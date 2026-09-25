import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { KnowledgeGeneratorService } from '../../src/knowledge/KnowledgeGeneratorService.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';

describe('KnowledgeGeneratorService', () => {
  const databases: Array<{ close: () => void }> = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function createDatabase(workspaceRoot: string): ReturnType<typeof openDatabase> {
    const database = openDatabase(':memory:');
    databases.push(database);
    database
      .prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run('project_1', workspaceRoot, 'Wiki', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    return database;
  }

  function enqueue(database: ReturnType<typeof openDatabase>, outputRoot: string, content = 'Generated'): string {
    const result = database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_1',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          generatorVersion: 'generator-1',
          generatedAt: '2026-01-01T00:00:00.000Z',
          pages: [{ type: 'concept', title: 'SQLite', slug: 'sqlite', content }],
        }),
        '2026-01-01T00:00:00.000Z',
      );
    return String(result.lastInsertRowid) === '-1' ? 'job_1' : 'job_1';
  }

  it('generates pages, indexes, and manifest atomically', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);
    const jobId = enqueue(database, outputRoot);

    const result = await new KnowledgeGeneratorService(database).runKnowledgeGeneration(jobId);

    expect(result.pages).toHaveLength(1);
    expect(readFileSync(join(outputRoot, 'pages/concept/sqlite.md'), 'utf8')).toContain('generator_version: "generator-1"');
    expect(existsSync(join(outputRoot, 'index.md'))).toBe(true);
    expect(existsSync(join(outputRoot, 'manifest.json'))).toBe(true);
    expect(database.prepare('SELECT status FROM knowledge_jobs WHERE id = ?').get(jobId)).toEqual({ status: 'completed' });
  });

  it('leaves prior files and versions unchanged when rendering fails', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);
    const jobId = enqueue(database, outputRoot, 'Original');
    await new KnowledgeGeneratorService(database).runKnowledgeGeneration(jobId);

    database
      .prepare(`INSERT INTO knowledge_jobs (id, project_id, job_kind, status, payload_json, requested_at) VALUES (?, ?, ?, 'queued', ?, ?)`)
      .run(
        'job_2',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          pages: [{ type: 'concept', title: 'SQLite', slug: 'sqlite', content: 'Replacement' }],
        }),
        '2026-01-02T00:00:00.000Z',
      );
    const renderer = {
      renderKnowledgePage: () => {
        throw new Error('renderer failed');
      },
    };

    await expect(new KnowledgeGeneratorService(database, { renderer }).runKnowledgeGeneration('job_2')).rejects.toThrow('renderer failed');
    expect(readFileSync(join(outputRoot, 'pages/concept/sqlite.md'), 'utf8')).toContain('Original');
    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_page_versions').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT status FROM knowledge_jobs WHERE id = ?').get('job_2')).toEqual({ status: 'failed' });
  });

  it('rejects page slugs that would write outside the output root', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);
    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_traversal',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          pages: [{ type: 'concept', title: 'Traversal', slug: '../../outside', content: 'Generated' }],
        }),
        '2026-01-03T00:00:00.000Z',
      );

    await expect(new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_traversal')).rejects.toThrow(
      /workspace|output root/i,
    );
    expect(existsSync(join(outputRoot, '..', 'outside.md'))).toBe(false);
    expect(database.prepare('SELECT status FROM knowledge_jobs WHERE id = ?').get('job_traversal')).toEqual({
      status: 'failed',
    });
  });

  it('rejects an output root outside the project workspace', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-workspace-'));
    const outputRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-outside-'));
    directories.push(workspaceRoot, outputRoot);
    const database = createDatabase(workspaceRoot);
    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_output_escape',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          pages: [{ type: 'concept', title: 'Escape', slug: 'escape', content: 'Generated' }],
        }),
        '2026-01-04T00:00:00.000Z',
      );

    await expect(new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_output_escape')).rejects.toThrow(
      /knowledge|workspace/i,
    );
    expect(existsSync(join(outputRoot, 'pages'))).toBe(false);
  });

  it('refuses to read an existing log file through a symlink', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);
    const secretPath = join(workspaceRoot, 'secret.txt');
    writeFileSync(secretPath, 'should-not-be-read\n', 'utf8');
    mkdirSync(outputRoot, { recursive: true });
    symlinkSync(secretPath, join(outputRoot, 'log.md'));
    const jobId = enqueue(database, outputRoot);

    await expect(new KnowledgeGeneratorService(database).runKnowledgeGeneration(jobId)).rejects.toThrow(/symbolic links/i);
    expect(database.prepare('SELECT status FROM knowledge_jobs WHERE id = ?').get(jobId)).toEqual({ status: 'failed' });
  });

  it('refuses to run a job already claimed by another worker', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);
    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at, worker_id, lease_expires_at, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, 'other-worker', ?, ?)`,
      )
      .run(
        'job_claimed_elsewhere',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          pages: [{ type: 'concept', title: 'Claimed', slug: 'claimed', content: 'Generated' }],
        }),
        '2026-01-04T00:00:00.000Z',
        '2026-01-04T00:10:00.000Z',
        '2026-01-04T00:00:00.000Z',
      );

    await expect(new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_claimed_elsewhere')).rejects.toThrow(
      /claimed by another worker/i,
    );
  });

  it('reuses the current page version when rerendered markdown is unchanged across deterministic reruns', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);

    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_deterministic_1',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          generatorVersion: 'deterministic:typescript-lezer:2.1.0',
          generatedAt: '2026-01-05T00:00:00.000Z',
          pages: [
            {
              pageId: 'page_source_1',
              type: 'source',
              title: 'src/weird-module.ts',
              slug: 'source-src-weird-module-ts',
              content: 'Deterministic body',
            },
          ],
        }),
        '2026-01-05T00:00:00.000Z',
      );
    const first = await new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_deterministic_1');
    new KnowledgePageStore(database).markPageStale('project_1', first.pages[0]!.pageId);

    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_deterministic_2',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          generatorVersion: 'deterministic:typescript-lezer:2.1.0',
          generatedAt: '2026-01-06T00:00:00.000Z',
          pages: [
            {
              pageId: 'page_source_1',
              type: 'source',
              title: 'src/weird-module.ts',
              slug: 'source-src-weird-module-ts',
              content: 'Deterministic body',
            },
          ],
        }),
        '2026-01-06T00:00:00.000Z',
      );

    const second = await new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_deterministic_2');

    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_page_versions').get()).toEqual({ count: 1 });
    expect(second.pageResults).toEqual([
      expect.objectContaining({
        reused: true,
        page: expect.objectContaining({
          id: first.pages[0]?.id,
          pageId: 'page_source_1',
          versionNumber: 1,
        }),
      }),
    ]);
    expect(new KnowledgePageStore(database).getCurrentPage('project_1', 'page_source_1' as never)).toMatchObject({
      status: 'active',
      currentVersion: 1,
    });
    expect(readFileSync(join(outputRoot, 'pages/source/source-src-weird-module-ts.md'), 'utf8')).toContain(
      'generated_at: "2026-01-05T00:00:00.000Z"',
    );
  });

  it('creates a new version when metadata summaries change even if page markdown body is unchanged', async () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const outputRoot = join(workspaceRoot, '.ariadne', 'knowledge');
    directories.push(workspaceRoot);
    const database = createDatabase(workspaceRoot);

    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_summary_1',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          generatorVersion: 'deterministic:typescript-lezer:2.1.0',
          generatedAt: '2026-01-07T00:00:00.000Z',
          pages: [
            {
              pageId: 'page_source_summary',
              type: 'source',
              title: 'src/summary.ts',
              slug: 'source-src-summary-ts',
              content: 'Deterministic body',
              summary: 'First summary',
            },
          ],
        }),
        '2026-01-07T00:00:00.000Z',
      );
    await new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_summary_1');

    database
      .prepare(
        `INSERT INTO knowledge_jobs
         (id, project_id, job_kind, status, payload_json, requested_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        'job_summary_2',
        'project_1',
        'generate',
        JSON.stringify({
          outputRoot,
          generatorVersion: 'deterministic:typescript-lezer:2.1.0',
          generatedAt: '2026-01-08T00:00:00.000Z',
          pages: [
            {
              pageId: 'page_source_summary',
              type: 'source',
              title: 'src/summary.ts',
              slug: 'source-src-summary-ts',
              content: 'Deterministic body',
              summary: 'Updated summary',
            },
          ],
        }),
        '2026-01-08T00:00:00.000Z',
      );

    const second = await new KnowledgeGeneratorService(database).runKnowledgeGeneration('job_summary_2');

    expect(database.prepare('SELECT COUNT(*) AS count FROM knowledge_page_versions').get()).toEqual({ count: 2 });
    expect(second.pageResults[0]).toMatchObject({
      reused: false,
      page: expect.objectContaining({
        versionNumber: 2,
        summary: 'Updated summary',
      }),
    });
  });

  it('reuses an unchanged semantic version across SQLite connections without creating duplicates', () => {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-generator-test-'));
    const databasePath = join(workspaceRoot, '.ariadne', 'knowledge-generator.db');
    directories.push(workspaceRoot);

    const firstConnection = openDatabase(databasePath);
    const secondConnection = openDatabase(databasePath);
    databases.push(firstConnection, secondConnection);
    firstConnection
      .prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      )
      .run('project_1', workspaceRoot, 'Wiki', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const firstStore = new KnowledgePageStore(firstConnection);
    const secondStore = new KnowledgePageStore(secondConnection);

    firstStore.createPageVersion({
      projectId: 'project_1',
      pageId: 'page_source_race',
      type: 'source',
      title: 'src/race.ts',
      slug: 'source-src-race-ts',
      content: 'Original body',
      createdAt: '2026-01-09T00:00:00.000Z',
    });

    // SQLite serializes writers, so this exercises the transactional compare-and-insert invariant
    // across independent connections rather than forcing true simultaneous writes.
    firstConnection.exec('BEGIN IMMEDIATE');
    const changedVersion = firstStore.createPageVersion({
      projectId: 'project_1',
      pageId: 'page_source_race',
      type: 'source',
      title: 'src/race.ts',
      slug: 'source-src-race-ts',
      content: 'Changed once',
      createdAt: '2026-01-10T00:00:00.000Z',
    });
    firstConnection.exec('COMMIT');

    secondConnection.exec('BEGIN IMMEDIATE');
    const reusedVersion = secondStore.createPageVersion({
      projectId: 'project_1',
      pageId: 'page_source_race',
      type: 'source',
      title: 'src/race.ts',
      slug: 'source-src-race-ts',
      content: 'Changed once',
      createdAt: '2026-01-11T00:00:00.000Z',
    });
    secondConnection.exec('COMMIT');

    expect(changedVersion).toMatchObject({
      pageId: 'page_source_race',
      versionNumber: 2,
      createdAt: '2026-01-10T00:00:00.000Z',
    });
    expect(reusedVersion).toMatchObject({
      pageId: 'page_source_race',
      versionNumber: 2,
      createdAt: '2026-01-10T00:00:00.000Z',
    });
    expect(firstConnection.prepare('SELECT COUNT(*) AS count FROM knowledge_page_versions').get()).toEqual({ count: 2 });
  });
});
