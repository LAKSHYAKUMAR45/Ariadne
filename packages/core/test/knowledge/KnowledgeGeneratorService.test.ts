import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { KnowledgeGeneratorService } from '../../src/knowledge/KnowledgeGeneratorService.js';

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
});
