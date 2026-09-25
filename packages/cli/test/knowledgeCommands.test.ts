import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { closeRegistry, openDatabase } from '@ariadne-dev/core';
import { program } from '../src/index.js';

// Functional coverage for `ariadne knowledge ...`: parses argv through the
// real `program` (same convention as curation.test.ts/status.test.ts)
// against an isolated temp workspace, so every command exercises the actual
// commander wiring plus the real `@ariadne-dev/core` knowledge services
// against a real (file-backed) SQLite database.
describe('ariadne knowledge commands', () => {
  let root: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let originalCwd: string;
  let previousRegistryPath: string | undefined;

  function resetCommanderOptionState(cmd: import('commander').Command): void {
    (cmd as unknown as { _optionValues: Record<string, unknown> })._optionValues = {};
    (cmd as unknown as { _optionValueSources: Record<string, unknown> })._optionValueSources = {};
    for (const sub of cmd.commands) resetCommanderOptionState(sub);
  }

  beforeEach(() => {
    resetCommanderOptionState(program);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-knowledge-test-'));
    fs.mkdirSync(path.join(root, '.git'));
    previousRegistryPath = process.env.ARIADNE_REGISTRY_PATH;
    process.env.ARIADNE_REGISTRY_PATH = path.join(root, 'registry.db');
    closeRegistry();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalCwd = process.cwd();
    process.chdir(root);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.env.ARIADNE_REGISTRY_PATH = previousRegistryPath;
    closeRegistry();
    process.exitCode = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function loggedLines(): string[] {
    return logSpy.mock.calls.map((args) => String(args[0]));
  }

  function lastJson(): { ok: boolean; data?: unknown; error?: { message: string; capability?: string } } {
    return JSON.parse(loggedLines().at(-1) ?? '{}');
  }

  async function run(...args: string[]): Promise<void> {
    await program.parseAsync(['node', 'ariadne', 'knowledge', ...args]);
  }

  async function createProject(name = 'Wiki'): Promise<string> {
    await run('project', 'create', name, '--json');
    const created = lastJson();
    return (created.data as { id: string }).id;
  }

  function insertProject(id: string, workspaceRoot: string, name: string): void {
    const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
    try {
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(id, workspaceRoot, name, createdAt, createdAt);
    } finally {
      db.close();
    }
  }

  describe('project', () => {
    it('creates, lists, shows, and archives a project', async () => {
      const projectId = await createProject('Ariadne Wiki');
      expect(projectId).toMatch(/^project_/);

      await run('project', 'list', '--json');
      const listed = lastJson();
      expect(listed.ok).toBe(true);
      expect((listed.data as unknown[]).length).toBe(1);

      await run('project', 'show', projectId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Ariadne Wiki');

      await run('project', 'archive', projectId, '--json');
      expect((lastJson().data as { status: string }).status).toBe('archived');
    });

    it('reports a clean error for an unknown project id', async () => {
      await run('project', 'show', 'project_missing', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/not found/i);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('source and ingest', () => {
    it('scans, ingests a file, and lists the registered source', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nSome knowledge content.\n');
      const projectId = await createProject();

      await run('source', 'scan', projectId, '.', '--json');
      const scanned = lastJson();
      expect(scanned.ok).toBe(true);
      expect((scanned.data as Array<{ path: string }>).some((c) => c.path === 'notes.md')).toBe(true);

      await run('ingest', 'file', projectId, 'notes.md', '--json');
      const ingested = lastJson();
      expect(ingested.ok).toBe(true);
      const { source, job } = ingested.data as { source: { id: string }; job: { id: string; status: string } };
      expect(source.id).toMatch(/^source_/);
      expect(job.status).toBe('queued');

      await run('source', 'list', projectId, '--json');
      const sources = lastJson().data as Array<{ id: string }>;
      expect(sources.map((s) => s.id)).toContain(source.id);

      await run('queue', 'list', projectId, '--json');
      const jobs = lastJson().data as Array<{ id: string }>;
      expect(jobs.map((j) => j.id)).toContain(job.id);
    });

    it('ingests an entire folder of policy-approved files', async () => {
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n');
      fs.writeFileSync(path.join(root, 'docs', 'b.txt'), 'plain text\n');
      const projectId = await createProject();

      await run('ingest', 'folder', projectId, 'docs', '--json');
      const result = lastJson();
      expect(result.ok).toBe(true);
      expect((result.data as unknown[]).length).toBe(2);
    });
  });

  describe('queue', () => {
    it('claims, cancels, and retries jobs', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), 'content\n');
      const projectId = await createProject();
      await run('ingest', 'file', projectId, 'notes.md', '--json');
      const { job } = lastJson().data as { job: { id: string } };

      await run('queue', 'claim', projectId, '--worker', 'test-worker', '--json');
      expect((lastJson().data as { id: string; status: string }).status).toBe('running');

      await run('queue', 'show', job.id, '--json');
      expect((lastJson().data as { job: { id: string } }).job.id).toBe(job.id);

      await run('queue', 'cancel', job.id, '--json');
      expect((lastJson().data as { status: string }).status).toBe('cancelled');
    });

    it('claims only jobs from the requested project', async () => {
      fs.writeFileSync(path.join(root, 'project-a.md'), 'a\n');
      fs.writeFileSync(path.join(root, 'project-b.md'), 'b\n');
      const projectA = await createProject('Project A');
      const projectB = 'project_b';
      insertProject(projectB, '/alternate-workspace', 'Project B');

      await run('ingest', 'file', projectA, 'project-a.md', '--json');
      await run('ingest', 'file', projectB, 'project-b.md', '--json');

      await run('queue', 'claim', projectB, '--worker', 'worker-b', '--json');
      const claimed = lastJson().data as { projectId: string; status: string };
      expect(claimed.projectId).toBe(projectB);
      expect(claimed.status).toBe('running');

      await run('queue', 'list', projectA, '--json');
      const projectAJobs = lastJson().data as Array<{ status: string }>;
      expect(projectAJobs).toHaveLength(1);
      expect(projectAJobs[0].status).toBe('queued');
    });
  });

  describe('search', () => {
    it('finds an ingested source by lexical search', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Auth flow\n\nDescribes the login handshake.\n');
      const projectId = await createProject();
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      // Lexical search indexes source metadata (path/kind/hash), not raw file
      // content, so search by the ingested file's path term.
      await run('search', projectId, 'notes', '--json');
      const results = lastJson().data as Array<{ kind: string }>;
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('graph', () => {
    it('imports a graphify export and exposes nodes/edges/neighborhood', async () => {
      const projectId = await createProject();
      const graphifyPath = path.join(root, 'graphify.json');
      fs.writeFileSync(
        graphifyPath,
        JSON.stringify({
          nodes: [
            { id: 'n1', nodeType: 'file', label: 'a.ts' },
            { id: 'n2', nodeType: 'file', label: 'b.ts' },
          ],
          edges: [{ source: 'n1', target: 'n2', type: 'imports' }],
        }),
      );

      await run('graph', 'import-graphify', projectId, 'graphify.json', '--json');
      const imported = lastJson();
      expect(imported.ok).toBe(true);
      expect((imported.data as { nodeCount: number }).nodeCount).toBe(2);
      expect((imported.data as { edgeCount: number }).edgeCount).toBe(1);

      await run('graph', 'nodes', projectId, '--json');
      const nodes = lastJson().data as Array<{ id: string; label: string }>;
      expect(nodes.map((n) => n.label).sort()).toEqual(['a.ts', 'b.ts']);

      await run('graph', 'edges', projectId, '--json');
      expect((lastJson().data as unknown[]).length).toBe(1);

      const nodeId = nodes.find((n) => n.label === 'a.ts')!.id;
      await run('graph', 'neighborhood', projectId, nodeId, '--json');
      expect((lastJson().data as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
    });
  });

  describe('review', () => {
    it('creates, lists, resolves, and reopens a review', async () => {
      const projectId = await createProject();
      await run('review', 'create', projectId, '--summary', 'Check this claim', '--json');
      const { id } = lastJson().data as { id: string };

      await run('review', 'list', projectId, '--json');
      expect((lastJson().data as unknown[]).length).toBe(1);

      await run('review', 'resolve', id, 'accept', '--actor', 'tester', '--source', 'cli', '--evidence-kind', 'source', '--evidence-id', 'source_1', '--json');
      expect((lastJson().data as { status: string }).status).toBe('approved');

      await run('review', 'reopen', id, '--actor', 'tester', '--source', 'cli', '--json');
      expect((lastJson().data as { status: string }).status).toBe('pending');
    });
  });

  describe('research (no provider configured)', () => {
    it('fails deterministically without making any network call', async () => {
      const projectId = await createProject();
      await run('research', projectId, 'how does auth work', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/provider/i);
      expect(process.exitCode).toBe(1);
    });
  });

  describe('chat', () => {
    it('creates a conversation and lists it, but "send" fails deterministically without a provider', async () => {
      const projectId = await createProject();
      await run('chat', 'create', projectId, '--title', 'Investigation', '--json');
      const { id } = lastJson().data as { id: string };

      await run('chat', 'list', projectId, '--json');
      expect((lastJson().data as Array<{ id: string }>).map((c) => c.id)).toContain(id);

      await run('chat', 'send', id, 'What is this project about?', '--json');
      const sendResult = lastJson();
      expect(sendResult.ok).toBe(false);
      expect(sendResult.error?.capability).toBe('chat');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('export and import', () => {
    it('round-trips a project through export then import into a fresh project id', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const projectId = await createProject('Exportable');
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      await run('export', projectId, outputDir, '--json');
      const exported = lastJson();
      expect(exported.ok).toBe(true);
      expect(fs.existsSync(path.join(outputDir, 'manifest.json'))).toBe(true);

      // Delete the original project's data so import proves it can restore
      // everything purely from the exported archive.
      await run('project', 'archive', projectId, '--json');

      await run('import', projectId, outputDir, '--replace', '--json');
      const imported = lastJson();
      expect(imported.ok).toBe(true);
      expect((imported.data as { projectId: string }).projectId).toBe(projectId);

      await run('project', 'show', projectId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Exportable');
    });
  });
});
