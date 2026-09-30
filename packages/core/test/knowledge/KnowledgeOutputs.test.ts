import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KnowledgeOutputStore } from '../../src/knowledge/KnowledgeOutputs.js';

describe('KnowledgeOutputStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function createStore(): { root: string; store: KnowledgeOutputStore } {
    const root = mkdtempSync(join(process.cwd(), '.knowledge-outputs-test-'));
    directories.push(root);
    return { root, store: new KnowledgeOutputStore(root, { now: () => '2026-09-24T00:00:00.000Z' }) };
  }

  it('creates confined, redacted output with MIME metadata and provenance', () => {
    const { root, store } = createStore();

    const output = store.create({
      projectId: 'project_1',
      kind: 'report',
      path: 'exports/report.md',
      content: 'token=do-not-persist\n# Report',
      provenance: [{ kind: 'task', id: 'task_1' }],
    });

    expect(output).toMatchObject({
      projectId: 'project_1',
      kind: 'report',
      path: 'exports/report.md',
      mimeType: 'text/markdown',
      size: expect.any(Number),
      provenance: [{ kind: 'task', id: 'task_1' }],
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    expect(readFileSync(join(root, 'exports/report.md'), 'utf8')).toBe('token=***\n# Report');
    expect(store.list('project_1')).toEqual([output]);
    expect(store.preview('project_1', output.id)?.content).toBe('token=***\n# Report');
  });

  it('rejects paths outside the output root and refuses implicit overwrites', () => {
    const { root, store } = createStore();
    writeFileSync(join(root, 'existing.md'), 'existing', 'utf8');

    expect(() =>
      store.create({
        projectId: 'project_1',
        kind: 'report',
        path: '../outside.md',
        content: 'nope',
      }),
    ).toThrow(/within the output root/i);
    expect(() =>
      store.create({
        projectId: 'project_1',
        kind: 'report',
        path: 'existing.md',
        content: 'replacement',
      }),
    ).toThrow(/already exists/i);

    const output = store.create({
      projectId: 'project_1',
      kind: 'report',
      path: 'existing.md',
      content: 'replacement',
      overwrite: 'replace',
    });
    expect(readFileSync(join(root, 'existing.md'), 'utf8')).toBe('replacement');
    expect(output.mimeType).toBe('text/markdown');
  });

  it('rejects output paths that traverse symbolic links', () => {
    const { root, store } = createStore();
    const outside = createStore().root;
    mkdirSync(join(root, 'exports'));
    symlinkSync(outside, join(root, 'exports', 'linked'));

    expect(() =>
      store.create({
        projectId: 'project_1',
        kind: 'report',
        path: 'exports/linked/report.md',
        content: 'nope',
      }),
    ).toThrow(/symbolic links/i);
    expect(existsSync(join(outside, 'report.md'))).toBe(false);
  });

  it('cleans up only the requested output and its metadata', () => {
    const { root, store } = createStore();
    const first = store.create({
      projectId: 'project_1',
      kind: 'report',
      path: 'exports/first.txt',
      content: 'first',
    });
    const second = store.create({
      projectId: 'project_1',
      kind: 'report',
      path: 'exports/second.txt',
      content: 'second',
    });

    store.delete('project_1', first.id);

    expect(existsSync(join(root, first.path))).toBe(false);
    expect(existsSync(join(root, second.path))).toBe(true);
    expect(store.list('project_1')).toEqual([second]);
    expect(store.preview('project_1', first.id)).toBeUndefined();
  });
});
