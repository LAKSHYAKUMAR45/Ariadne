import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KnowledgeSourceWatcher,
  type KnowledgeSourceWatchEvent,
} from '../../src/knowledge/KnowledgeSourceWatcher.js';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for watcher event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('KnowledgeSourceWatcher', () => {
  let workspaceRoot: string;
  let watcher: KnowledgeSourceWatcher | undefined;

  afterEach(async () => {
    watcher?.stop();
    vi.useRealTimers();
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('debounces filesystem changes and emits created, changed, deleted, and renamed events', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-watch-'));
    watcher = new KnowledgeSourceWatcher(workspaceRoot, { workspaceRoot }, { debounceMs: 25 });
    const events: KnowledgeSourceWatchEvent[] = [];
    watcher.on('created', (event) => events.push(event));
    watcher.on('changed', (event) => events.push(event));
    watcher.on('deleted', (event) => events.push(event));
    watcher.on('renamed', (event) => events.push(event));
    await watcher.start();

    await writeFile(path.join(workspaceRoot, 'note.md'), 'first');
    await waitFor(() => events.some((event) => event.type === 'created'));
    await writeFile(path.join(workspaceRoot, 'note.md'), 'second');
    await waitFor(() => events.some((event) => event.type === 'changed'));
    await rename(path.join(workspaceRoot, 'note.md'), path.join(workspaceRoot, 'renamed.md'));
    await waitFor(() => events.some((event) => event.type === 'renamed'));
    await rm(path.join(workspaceRoot, 'renamed.md'));
    await waitFor(() => events.some((event) => event.type === 'deleted'));

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'created', path: 'note.md', directory: '.' }),
        expect.objectContaining({ type: 'changed', path: 'note.md' }),
        expect.objectContaining({
          type: 'renamed',
          path: 'renamed.md',
          previousPath: 'note.md',
        }),
        expect.objectContaining({ type: 'deleted', path: 'renamed.md' }),
      ]),
    );
  });

  it('stops emitting after stop is called', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-watch-'));
    watcher = new KnowledgeSourceWatcher(workspaceRoot, { workspaceRoot }, { debounceMs: 10 });
    const created = vi.fn();
    watcher.on('created', created);
    await watcher.start();
    watcher.stop();

    await writeFile(path.join(workspaceRoot, 'after-stop.md'), 'not watched');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(created).not.toHaveBeenCalled();
  });

  it('emits filesystem errors to listeners without throwing when no error listener exists', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-watch-'));
    const missingRoot = path.join(workspaceRoot, 'missing');
    watcher = new KnowledgeSourceWatcher(missingRoot, { workspaceRoot: missingRoot });
    const errors: Error[] = [];
    watcher.on('error', (error) => errors.push(error));

    await expect(watcher.start()).resolves.toBeUndefined();
    await waitFor(() => errors.length === 1);
    expect(errors[0].message).toContain(missingRoot);

    watcher.stop();
    const silentWatcher = new KnowledgeSourceWatcher(missingRoot, { workspaceRoot: missingRoot });
    await expect(silentWatcher.start()).resolves.toBeUndefined();
    silentWatcher.stop();
  });

  it('allows a watcher to be started after a recoverable startup error', async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'ariadne-knowledge-watch-'));
    const missingRoot = path.join(workspaceRoot, 'missing');
    watcher = new KnowledgeSourceWatcher(missingRoot, { workspaceRoot: missingRoot }, { debounceMs: 10 });
    const errors: Error[] = [];
    watcher.on('error', (error) => errors.push(error));

    await watcher.start();
    await waitFor(() => errors.length === 1);
    await mkdir(missingRoot);
    await watcher.start();

    const created = vi.fn();
    watcher.on('created', created);
    await writeFile(path.join(missingRoot, 'recovered.md'), 'ready');
    await waitFor(() => created.mock.calls.length === 1);
  });
});
