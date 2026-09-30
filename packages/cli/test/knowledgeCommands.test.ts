import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import { closeRegistry, openDatabase, KnowledgeQueue } from '@ariadne-dev/core';
import { program } from '../src/index.js';
import { buildCliWorkerStatus } from '../src/knowledgeCommands.js';

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
  const servers = new Set<http.Server>();

  function resetCommanderOptionState(cmd: import('commander').Command): void {
    (cmd as unknown as { _optionValues: Record<string, unknown> })._optionValues = {};
    (cmd as unknown as { _optionValueSources: Record<string, unknown> })._optionValueSources = {};
    for (const sub of cmd.commands) resetCommanderOptionState(sub);
  }

  beforeEach(() => {
    resetCommanderOptionState(program);
    program.exitOverride();
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
    for (const server of servers) {
      server.close();
    }
    servers.clear();
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

  function errorLines(): string[] {
    return errorSpy.mock.calls.map((args) => String(args[0]));
  }

  function allConsoleText(): string {
    return [...loggedLines(), ...errorLines()].join('\n');
  }

  function clearConsole(): void {
    logSpy.mockClear();
    errorSpy.mockClear();
    process.exitCode = undefined;
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

  async function startLoopbackProvider(): Promise<{ endpoint: string }> {
    const server = http.createServer((request, response) => {
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Loopback profile is reachable.',
                  entities: [],
                  claims: [],
                  relationships: [],
                  contradictions: [],
                  researchGaps: [],
                }),
              },
            },
          ],
        }),
      );
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected loopback server address');
    }
    return { endpoint: `http://127.0.0.1:${address.port}/v1` };
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

    it('rejects immutable source storage when the knowledge directory traverses a symlink', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n');
      const projectId = await createProject();
      const knowledgeRoot = path.join(root, '.ariadne', 'knowledge');
      const externalTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-cli-knowledge-external-'));
      fs.rmSync(knowledgeRoot, { recursive: true, force: true });
      fs.symlinkSync(externalTarget, knowledgeRoot, 'dir');

      try {
        await run('ingest', 'file', projectId, 'notes.md', '--json');
      } finally {
        fs.rmSync(knowledgeRoot, { force: true });
        fs.mkdirSync(knowledgeRoot, { recursive: true });
        fs.rmSync(externalTarget, { recursive: true, force: true });
      }

      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/symbolic links/i);
      expect(process.exitCode).toBe(1);
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

    describe('worker', () => {
      it('runs queued jobs once, makes content searchable with exact spans, reports status, and drains nothing on rerun', async () => {
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(
          path.join(root, 'src', 'example.py'),
          ['class Greeter:', '    def greet(self, name):', "        return f'hello {name}'", ''].join('\n'),
        );
        const projectId = await createProject();

        await run('ingest', 'file', projectId, 'src/example.py', '--json');
        clearConsole();

        await run('worker', 'run', projectId, '--once', '--json');
        const firstRun = lastJson();
        expect(firstRun.ok).toBe(true);
        expect(firstRun.data).toMatchObject({
          projectId,
          claimed: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
        });

        clearConsole();
        await run('search', projectId, 'greet', '--mode', 'sources', '--json');
        const results = lastJson().data as Array<{
          snippet: string;
          searchConfidence?: string;
          citations: Array<{ span?: { startLine: number; endLine: number } }>;
        }>;
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.snippet).toContain('greet');
        expect(results[0]?.searchConfidence).toBe('clear');
        expect(results[0]?.citations[0]?.span).toMatchObject({
          startLine: 2,
          endLine: 2,
        });

        clearConsole();
        resetCommanderOptionState(program);
        await run('search', projectId, 'greet', '--mode', 'sources');
        expect(allConsoleText()).toContain('Confidence: clear');
        expect(allConsoleText()).toContain('citation:');

        clearConsole();
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        expect(status.data).toMatchObject({
          projectId,
          queue: {
            queuedCount: 0,
            runningCount: 0,
            completedCount: 1,
            failedCount: 0,
            cancelledCount: 0,
          },
          completions: {
            deterministic: 1,
            enriched: 0,
          },
        });
        expect(status.data).toMatchObject({
          activeWorkers: {
            workerCount: 0,
          },
          analyzerVersions: [
            expect.objectContaining({
              analyzerId: expect.any(String),
              analyzerVersion: expect.any(String),
            }),
          ],
          coverage: {
            supported: 1,
            partial: 0,
            unsupported: 0,
            failed: 0,
          },
          graph: {
            nodeCount: expect.any(Number),
            edgeCount: expect.any(Number),
          },
          synthesis: {
            summaryCount: expect.any(Number),
            deterministic: expect.any(Number),
            providerRefined: expect.any(Number),
            fallbackWarning: expect.any(Number),
          },
          analytics: { enabled: false },
        });

        clearConsole();
        await run('worker', 'run', projectId, '--once', '--json');
        expect(lastJson().data).toMatchObject({
          projectId,
          claimed: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
        });
      });

      function writePythonSources(count: number): void {
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        for (let index = 0; index < count; index += 1) {
          fs.writeFileSync(path.join(root, 'src', `module_${index}.py`), `def handler_${index}():\n    return ${index}\n`);
        }
      }

      async function ingestSources(projectId: string, count: number): Promise<void> {
        writePythonSources(count);
        for (let index = 0; index < count; index += 1) {
          await run('ingest', 'file', projectId, `src/module_${index}.py`, '--json');
        }
        clearConsole();
      }

      function queuedJobCount(): number {
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          return (db.prepare("SELECT COUNT(*) AS count FROM knowledge_jobs WHERE status = 'queued'").get() as { count: number }).count;
        } finally {
          db.close();
        }
      }

      it('drains with bounded --concurrency slots and reports the resolved concurrency', async () => {
        const projectId = await createProject();
        await ingestSources(projectId, 4);

        await run('worker', 'run', projectId, '--once', '--concurrency', '3', '--worker', 'cli-test', '--json');

        const data = lastJson().data as {
          claimed: number;
          completed: number;
          concurrency: number;
          resolvedConcurrency: { value: number; source: string };
          slots: Array<{ workerId: string; claimed: number }>;
        };
        expect(lastJson().ok).toBe(true);
        expect(data).toMatchObject({ claimed: 4, completed: 4, concurrency: 3, resolvedConcurrency: { value: 3, source: 'override' } });
        expect(data.slots).toHaveLength(3);
        expect(new Set(data.slots.map((slot) => slot.workerId)).size).toBe(3);
        expect(data.slots.every((slot) => slot.workerId.startsWith('cli-test/run_'))).toBe(true);
        expect(data.slots.reduce((sum, slot) => sum + slot.claimed, 0)).toBe(4);
      });

      it.each(['0', '9', '1.5', 'abc', '-1', '2x'])('rejects --concurrency=%s before claiming any job', async (value) => {
        const projectId = await createProject();
        await ingestSources(projectId, 1);

        await run('worker', 'run', projectId, '--once', `--concurrency=${value}`, '--json');

        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/concurrency must be an integer between 1 and 8/i);
        expect(process.exitCode).toBe(1);
        expect(queuedJobCount()).toBe(1);
      });

      it('rejects unsafe worker ids before touching the queue', async () => {
        const projectId = await createProject();
        await ingestSources(projectId, 1);

        await run('worker', 'run', projectId, '--once', '--worker', 'bad/id with spaces', '--json');

        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/worker id/i);
        expect(queuedJobCount()).toBe(1);
      });

      it('stores a validated host-local concurrency, uses it by default, and lets a flag override it', async () => {
        const projectId = await createProject();
        await ingestSources(projectId, 3);

        await run('worker', 'concurrency', projectId, '--json');
        expect(lastJson().data).toEqual({ projectId, value: 1, source: 'default' });

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'concurrency', projectId, '--set', '2', '--json');
        expect(lastJson().data).toEqual({ projectId, value: 2, source: 'host-setting' });

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'run', projectId, '--once', '--json');
        expect(lastJson().data).toMatchObject({
          claimed: 3,
          completed: 3,
          concurrency: 2,
          resolvedConcurrency: { value: 2, source: 'host-setting' },
        });

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'status', projectId, '--json');
        expect(lastJson().data).toMatchObject({ concurrency: { value: 2, source: 'host-setting' } });

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'run', projectId, '--once', '--concurrency', '1', '--json');
        expect(lastJson().data).toMatchObject({ concurrency: 1, resolvedConcurrency: { source: 'override' } });

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'concurrency', projectId, '--reset', '--json');
        expect(lastJson().data).toEqual({ projectId, value: 1, source: 'default' });
      });

      it.each(['0', '9', '2.5', 'many'])('rejects invalid stored concurrency --set=%s', async (value) => {
        const projectId = await createProject();

        await run('worker', 'concurrency', projectId, `--set=${value}`, '--json');

        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/concurrency must be an integer between 1 and 8/i);
        expect(process.exitCode).toBe(1);
      });

      it('rejects combining --set and --reset and unknown projects', async () => {
        const projectId = await createProject();

        await run('worker', 'concurrency', projectId, '--set', '2', '--reset', '--json');
        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/--set.*--reset|--reset.*--set/);

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'concurrency', 'project_missing', '--set', '2', '--json');
        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/project not found/i);
      });

      it('fails fast without echoing a corrupt stored setting, and still reports status with a warning', async () => {
        const projectId = await createProject();
        await ingestSources(projectId, 1);
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          db.prepare(
            `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
             VALUES ('s1', ?, 'host.worker.concurrency', '4096', 'now', 'now')`,
          ).run(projectId);
        } finally {
          db.close();
        }

        await run('worker', 'run', projectId, '--once', '--json');
        expect(lastJson().ok).toBe(false);
        expect(lastJson().error?.message).toMatch(/invalid stored value/i);
        expect(allConsoleText()).not.toContain('4096');
        expect(queuedJobCount()).toBe(1);

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        expect(status.data).toMatchObject({
          concurrency: null,
          warnings: expect.arrayContaining([expect.objectContaining({ code: 'worker_concurrency_invalid' })]),
        });
        expect(allConsoleText()).not.toContain('4096');
      });

      it('shows the resolved concurrency in text status', async () => {
        const projectId = await createProject();

        await run('worker', 'status', projectId);

        expect(allConsoleText()).toContain('Concurrency: 1 (default)');
      });

      it('rejects --watch with --json to preserve the single JSON envelope contract', async () => {
        const projectId = await createProject();

        clearConsole();
        await run('worker', 'run', projectId, '--watch', '--json');

        const result = lastJson();
        expect(result.ok).toBe(false);
        expect(result.error?.message).toMatch(/--watch|watch mode/i);
        expect(process.exitCode).toBe(1);
      });

      it('aborts watch mode on SIGINT and removes scoped signal handlers', async () => {
        const projectId = await createProject();
        const sigintListenersBefore = process.listenerCount('SIGINT');
        const sigtermListenersBefore = process.listenerCount('SIGTERM');

        clearConsole();
        const emitSignal = setTimeout(() => {
          process.emit('SIGINT');
        }, 25);
        try {
          await run('worker', 'run', projectId, '--watch', '--poll-ms', '5');
        } finally {
          clearTimeout(emitSignal);
        }

        expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
        expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
        expect(process.exitCode).toBeUndefined();
      });

      it('reports the full active worker count even when the bounded lease list is truncated', async () => {
        const projectId = await createProject();
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          const queue = new KnowledgeQueue(db);
          for (let index = 0; index < 10; index += 1) {
            queue.enqueue({
              projectId,
              jobKind: 'analyze',
              payload: { index },
            });
            queue.claim(projectId, `worker-${index}`);
          }
        } finally {
          db.close();
        }

        clearConsole();
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        expect(status.data).toMatchObject({
          activeWorkers: {
            workerCount: 10,
          },
          queue: {
            runningCount: 10,
          },
        });
        expect(((status.data as { activeWorkers: { leases: unknown[] } }).activeWorkers.leases).length).toBeLessThanOrEqual(8);
      });

      it('excludes expired running leases from active status details while keeping raw running counts explicit', async () => {
        const projectId = await createProject();
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          const queue = new KnowledgeQueue(db);
          const expiredJob = queue.enqueue({
            projectId,
            jobKind: 'analyze',
            payload: { index: 'expired' },
          });
          const activeJob = queue.enqueue({
            projectId,
            jobKind: 'analyze',
            payload: { index: 'active' },
          });
          queue.claim(projectId, 'worker-expired');
          queue.claim(projectId, 'worker-active');
          db.prepare(
            `UPDATE knowledge_jobs
             SET lease_expires_at = ?
             WHERE id = ?`,
          ).run(new Date(Date.now() - 60_000).toISOString(), expiredJob.id);
          db.prepare(
            `UPDATE knowledge_jobs
             SET lease_expires_at = ?
             WHERE id = ?`,
          ).run(new Date(Date.now() + 60_000).toISOString(), activeJob.id);
        } finally {
          db.close();
        }

        clearConsole();
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        expect(status.data).toMatchObject({
          queue: {
            runningCount: 2,
          },
          activeWorkers: {
            workerCount: 1,
            runningCount: 1,
          },
        });
        expect((status.data as {
          activeWorkers: { leases: Array<{ workerId: string }> };
        }).activeWorkers.leases).toEqual([
          expect.objectContaining({ workerId: 'worker-active' }),
        ]);

        clearConsole();
        resetCommanderOptionState(program);
        await run('worker', 'status', projectId);
        expect(allConsoleText()).toContain('2 running (1 with active leases)');
      });

      it('bounds provider diagnostics in worker status output', async () => {
        const projectId = await createProject();
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          const createdAt = new Date().toISOString();
          for (let index = 0; index < 12; index += 1) {
            db.prepare(
              `INSERT INTO knowledge_provider_profiles
               (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
               VALUES (?, ?, 'remote', ?, ?, ?, ?)`,
            ).run(
              `provider_invalid_${index}`,
              projectId,
              `invalid-${index}`,
              '{"endpoint":"https://example.com/v1","apiKey":"sk-live-secret-value"}',
              createdAt,
              createdAt,
            );
          }
        } finally {
          db.close();
        }

        clearConsole();
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        const warnings = (status.data as { warnings: Array<{ code: string; message: string }> }).warnings;
        expect(warnings.length).toBeLessThanOrEqual(8);
        expect(JSON.stringify(warnings)).not.toContain('sk-live-secret-value');
      });

      it('redacts secret-shaped values from JSON diagnostics', async () => {
        clearConsole();
        await run('worker', 'status', 'sk-proj-abcdefghijklmnopqrstuvwxyz', '--json');

        expect(lastJson()).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/\*{3}|\[REDACTED\]/) },
        });
        expect(JSON.stringify(lastJson())).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz');
      });

      it('degrades gracefully when a completed job result row is malformed', async () => {
        const projectId = await createProject();
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          const createdAt = new Date().toISOString();
          db.prepare(
            `INSERT INTO knowledge_jobs
             (id, project_id, job_kind, source_version_id, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
             VALUES (?, ?, 'analyze', NULL, 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
          ).run('job_malformed_result', projectId, createdAt, createdAt, createdAt, '{not-json', 'unknown');
        } finally {
          db.close();
        }

        clearConsole();
        await run('worker', 'status', projectId, '--json');
        const status = lastJson();
        expect(status.ok).toBe(true);
        expect(status.data).toMatchObject({
          completions: {
            deterministic: 0,
            enriched: 0,
            unknown: 1,
          },
          unknownCompletionCount: 1,
        });
        expect((status.data as { warnings: Array<{ code: string }> }).warnings).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: 'job_result_unknown' })]),
        );
      });

      it('uses indexed aggregate SQL for deterministic, enriched, and unknown completion totals', async () => {
        const projectId = await createProject();
        const db = openDatabase(path.join(root, '.ariadne', 'state.db'));
        const createdAt = new Date().toISOString();
        try {
          db.prepare(
            `INSERT INTO knowledge_projects
             (id, workspace_root, name, status, created_at, updated_at)
             VALUES ('project_other', ?, 'Other Project', 'active', ?, ?)`,
          ).run(path.join(root, 'other-project'), createdAt, createdAt);
          for (let index = 0; index < 120; index += 1) {
            db.prepare(
              `INSERT INTO knowledge_jobs
               (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
               VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
            ).run(
              `job_meta_det_${index.toString().padStart(3, '0')}`,
              projectId,
              createdAt,
              createdAt,
              createdAt,
              '{"processingMode":"deterministic"}',
              'deterministic',
            );
          }
          for (let index = 0; index < 70; index += 1) {
            db.prepare(
              `INSERT INTO knowledge_jobs
               (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
               VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
            ).run(
              `job_meta_enriched_${index.toString().padStart(3, '0')}`,
              projectId,
              createdAt,
              createdAt,
              createdAt,
              '{"processingMode":"enriched"}',
              'enriched',
            );
          }
          for (let index = 0; index < 65; index += 1) {
            db.prepare(
              `INSERT INTO knowledge_jobs
               (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
               VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
            ).run(
              `job_det_${index.toString().padStart(3, '0')}`,
              projectId,
              createdAt,
              createdAt,
              createdAt,
              '{"processingMode":"deterministic","warnings":[]}',
              'deterministic',
            );
          }
          for (let index = 0; index < 45; index += 1) {
            db.prepare(
              `INSERT INTO knowledge_jobs
               (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
               VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
            ).run(
              `job_enriched_${index.toString().padStart(3, '0')}`,
              projectId,
              createdAt,
              createdAt,
              createdAt,
              '{"processingMode":"enriched","warnings":[]}',
              'enriched',
            );
          }
          db.prepare(
            `INSERT INTO knowledge_jobs
             (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
             VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
          ).run('job_unknown_bad_json', projectId, createdAt, createdAt, createdAt, '{bad-json', 'unknown');
          db.prepare(
            `INSERT INTO knowledge_jobs
             (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
             VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, NULL, ?)`,
          ).run('job_unknown_missing_result', projectId, createdAt, createdAt, createdAt, 'unknown');
          db.prepare(
            `INSERT INTO knowledge_jobs
             (id, project_id, job_kind, status, payload_json, requested_at, started_at, completed_at, retry_count, max_retries, result_json, result_processing_mode)
             VALUES (?, ?, 'analyze', 'completed', '{}', ?, ?, ?, 0, 3, ?, ?)`,
          ).run(
            'job_other_project',
            'project_other',
            createdAt,
            createdAt,
            createdAt,
            '{"processingMode":"deterministic"}',
            'deterministic',
          );
        } finally {
          db.close();
        }

        const queryShapes: string[] = [];
        const observedDb = openDatabase(path.join(root, '.ariadne', 'state.db'));
        try {
          const proxiedDb = new Proxy(observedDb, {
            get(target, property, receiver) {
              if (property !== 'prepare') {
                return Reflect.get(target, property, receiver);
              }
              return (sql: string) => {
                  if (sql.includes('FROM knowledge_jobs') && sql.includes('result_processing_mode')) {
                  queryShapes.push(sql.replace(/\s+/g, ' ').trim());
                }
                return target.prepare(sql);
              };
            },
          });

          const status = buildCliWorkerStatus(proxiedDb, projectId);
          expect(status.completions).toEqual({
            deterministic: 185,
            enriched: 115,
            unknown: 2,
          });
          expect(status.unknownCompletionCount).toBe(2);
          expect(status.warnings).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: 'job_result_unknown' })]),
          );
        } finally {
          observedDb.close();
        }

        expect(queryShapes).toEqual(
          expect.arrayContaining([
            expect.stringMatching(
              /SELECT result_processing_mode, COUNT\(\*\) AS completion_count FROM knowledge_jobs WHERE project_id = \? AND status = 'completed' AND result_processing_mode IS NOT NULL GROUP BY result_processing_mode/,
            ),
          ]),
        );
        expect(queryShapes).not.toEqual(
          expect.arrayContaining([
            expect.stringMatching(/SELECT id, result_json .* result_processing_mode IS NULL .* LIMIT \?/),
            expect.stringMatching(/^SELECT result_json FROM knowledge_jobs WHERE project_id = \? AND status = 'completed' AND result_json IS NOT NULL$/),
          ]),
        );
      });
    });

    describe('provider', () => {
      it('adds, lists, tests, enables, disables, and removes profiles without exposing secrets', async () => {
        const { endpoint } = await startLoopbackProvider();
        const projectId = await createProject();
        const secret = 'sk-live-cli-provider-secret';
        const envName = 'ARIADNE_KNOWLEDGE_PROVIDER_TEST_KEY';
        const previousValue = process.env[envName];
        delete process.env[envName];

        try {
          clearConsole();
          await run(
            'provider',
            'add',
            projectId,
            'loopback',
            '--kind',
            'openai-compatible',
            '--endpoint',
            endpoint,
            '--model',
            'gpt-4.1-mini',
            '--capabilities',
            'analysis,generation',
            '--timeout-ms',
            '5000',
            '--api-key-env',
            envName,
            '--json',
          );
          const added = lastJson();
          expect(added.ok).toBe(true);
          expect(added.data).toMatchObject({
            profileName: 'loopback',
            endpoint,
            apiKeyEnv: envName,
            enabled: false,
          });

          clearConsole();
          await run('provider', 'list', projectId, '--json');
          const listed = lastJson();
          expect(listed.ok).toBe(true);
          expect(listed.data).toMatchObject({
            profiles: [expect.objectContaining({ profileName: 'loopback', apiKeyEnv: envName })],
            warnings: [],
          });

          clearConsole();
          await run('provider', 'test', projectId, 'loopback', '--json');
          const missingEnv = lastJson();
          expect(missingEnv.ok).toBe(true);
          expect(missingEnv.data).toMatchObject({
            success: true,
            warnings: [expect.objectContaining({ code: 'provider_missing_api_key' })],
          });
          expect(JSON.stringify(missingEnv)).toContain(envName);
          expect(JSON.stringify(missingEnv)).not.toContain(secret);

          process.env[envName] = secret;
          clearConsole();
          await run('provider', 'test', projectId, 'loopback', '--json');
          const tested = lastJson();
          expect(tested.ok).toBe(true);
          expect(tested.data).toMatchObject({
            success: true,
            profile: expect.objectContaining({ profileName: 'loopback' }),
          });
          expect(allConsoleText()).not.toContain(secret);

          clearConsole();
          await run('provider', 'enable', projectId, 'loopback', '--json');
          expect(lastJson().data).toMatchObject({ profileName: 'loopback', enabled: true });

          clearConsole();
          await run('provider', 'disable', projectId, 'loopback', '--json');
          expect(lastJson().data).toMatchObject({ profileName: 'loopback', enabled: false });

          clearConsole();
          await run('provider', 'remove', projectId, 'loopback', '--json');
          expect(lastJson().data).toMatchObject({ removed: true, profileName: 'loopback' });

          clearConsole();
          await run('provider', 'list', projectId, '--json');
          expect(lastJson().data).toMatchObject({ profiles: [], warnings: [] });
        } finally {
          if (previousValue === undefined) {
            delete process.env[envName];
          } else {
            process.env[envName] = previousValue;
          }
        }
      });

      it('fails closed for public named hosts and rejects literal --api-key values as an unknown option', async () => {
        const projectId = await createProject();
        const envName = 'ARIADNE_KNOWLEDGE_PROVIDER_PUBLIC_KEY';
        const approvalName = 'ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_ORIGIN';
        const previousKey = process.env[envName];
        const previousOrigin = process.env[approvalName];
        process.env[envName] = 'sk-live-public-secret';
        process.env[approvalName] = 'https://api.example.com';

        try {
          clearConsole();
          await run(
            'provider',
            'add',
            projectId,
            'public',
            '--kind',
            'openai-compatible',
            '--endpoint',
            'https://api.example.com/v1',
            '--model',
            'gpt-4.1-mini',
            '--capabilities',
            'analysis',
            '--api-key-env',
            envName,
            '--json',
          );
          expect(lastJson().ok).toBe(true);

          clearConsole();
          await run('provider', 'test', projectId, 'public', '--json');
          const failed = lastJson();
          expect(failed.ok).toBe(true);
          expect(failed.data).toMatchObject({
            success: false,
            diagnostics: [expect.stringMatching(/requestPinned|named host/i)],
          });
          expect(allConsoleText()).not.toContain('sk-live-public-secret');

          clearConsole();
          await expect(
            run(
              'provider',
              'add',
              projectId,
              'bad-secret',
              '--kind',
              'openai-compatible',
              '--endpoint',
              'http://127.0.0.1:11434/v1',
              '--model',
              'gpt-4.1-mini',
              '--capabilities',
              'analysis',
              '--api-key',
              'sk-live-inline-secret',
            ),
          ).rejects.toThrow(/process\.exit unexpectedly called with "1"/);
        } finally {
          if (previousKey === undefined) {
            delete process.env[envName];
          } else {
            process.env[envName] = previousKey;
          }
          if (previousOrigin === undefined) {
            delete process.env[approvalName];
          } else {
            process.env[approvalName] = previousOrigin;
          }
        }
      });

      it('requires existing projects and profiles for provider mutations', async () => {
        const projectId = await createProject();

        clearConsole();
        await run(
          'provider',
          'add',
          'project_missing',
          'missing-project',
          '--kind',
          'openai-compatible',
          '--endpoint',
          'http://127.0.0.1:11434/v1',
          '--model',
          'gpt-4.1-mini',
          '--capabilities',
          'analysis',
          '--json',
        );
        expect(lastJson()).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/project.*not found/i) },
        });

        clearConsole();
        await run('provider', 'enable', projectId, 'missing-profile', '--json');
        expect(lastJson()).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/profile not found/i) },
        });
        expect(process.exitCode).toBe(1);

        clearConsole();
        await run('provider', 'remove', projectId, 'missing-profile', '--json');
        expect(lastJson()).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/profile not found/i) },
        });
        expect(process.exitCode).toBe(1);
      });
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

    it('reuses an existing pending review for the same project identity', async () => {
      const projectId = await createProject();

      await run('review', 'create', projectId, '--summary', 'Check this claim', '--json');
      const first = lastJson().data as { id: string; requestedAt: string };

      await run('review', 'create', projectId, '--summary', 'Check this claim', '--json');
      const second = lastJson().data as { id: string; requestedAt: string };

      expect(second.id).toBe(first.id);
      expect(second.requestedAt).toBe(first.requestedAt);

      await run('review', 'list', projectId, '--json');
      expect(lastJson().data as unknown[]).toHaveLength(1);
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

      await run('chat', 'send', projectId, id, 'What is this project about?', '--json');
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
      expect((imported.data as { warnings: Array<{ code: string }> }).warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'derived_data_rebuild_required' })]),
      );

      clearConsole();
      resetCommanderOptionState(program);
      await run('import', projectId, outputDir, '--replace');
      expect(allConsoleText()).toContain('derived_data_rebuild_required');
      expect(allConsoleText()).toContain('rebuild the search index');

      await run('project', 'show', projectId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Exportable');
    });

    it('rejects a mismatched import project id before mutating the database', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const exportedProjectId = await createProject('Archive source');
      await run('ingest', 'file', exportedProjectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      await run('export', exportedProjectId, outputDir, '--json');
      expect(lastJson().ok).toBe(true);

      const replacementTargetId = 'project_replace_target';
      insertProject(replacementTargetId, '/replacement-target', 'Replacement target');
      await run('project', 'show', replacementTargetId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Replacement target');

      clearConsole();
      await run('import', replacementTargetId, outputDir, '--replace', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Knowledge archive import target does not match the archive project ID.');
      expect(process.exitCode).toBe(1);

      clearConsole();
      await run('project', 'show', replacementTargetId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Replacement target');

      clearConsole();
      await run('project', 'show', exportedProjectId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Archive source');
    });

    it('rejects oversized archive entries before reading them into memory', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const projectId = await createProject('Archive source');
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      await run('export', projectId, outputDir, '--json');
      expect(lastJson().ok).toBe(true);

      fs.writeFileSync(path.join(outputDir, 'data', 'knowledge_pages.json'), Buffer.alloc(16 * 1024 * 1024 + 1, 'a'));

      clearConsole();
      await run('import', projectId, outputDir, '--replace', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('maximum supported file size');
      expect(process.exitCode).toBe(1);

      clearConsole();
      await run('project', 'show', projectId, '--json');
      expect((lastJson().data as { name: string }).name).toBe('Archive source');
    });

    it('rejects malformed manifest entry structures before preloading archive files', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const projectId = await createProject('Archive source');
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      await run('export', projectId, outputDir, '--json');
      expect(lastJson().ok).toBe(true);

      const manifestPath = path.join(outputDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { entries: unknown };
      manifest.entries = {};
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      clearConsole();
      await run('import', projectId, outputDir, '--replace', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Knowledge archive import rejected: manifest entries must be an array.');
      expect(process.exitCode).toBe(1);
    });

    it('rejects invalid manifest JSON with a stable archive error', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const projectId = await createProject('Archive source');
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      await run('export', projectId, outputDir, '--json');
      expect(lastJson().ok).toBe(true);

      fs.writeFileSync(path.join(outputDir, 'manifest.json'), '{not-json', 'utf8');

      clearConsole();
      await run('import', projectId, outputDir, '--replace', '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Knowledge archive import rejected: manifest.json must contain valid JSON.');
      expect(process.exitCode).toBe(1);
    });

    it('rejects export output directories that traverse symlinks', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), '# Title\n\nContent.\n');
      const projectId = await createProject('Archive source');
      await run('ingest', 'file', projectId, 'notes.md', '--json');

      const outputDir = path.join(root, 'exported');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(outputDir, 'data'));

      clearConsole();
      await run('export', projectId, outputDir, '--json');
      const result = lastJson();
      expect(result.ok).toBe(false);
      expect(result.error?.message).toMatch(/symbolic links/i);
      expect(fs.existsSync(path.join(outsideDir, 'knowledge_projects.json'))).toBe(false);
    });
  });
});
