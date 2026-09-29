import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeGraphReporter } from '../../src/knowledge/KnowledgeGraphReporting.js';
import { KnowledgeHostSettingsStore, KnowledgeWorkerSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeWorker, type KnowledgeWorkerOptions } from '../../src/knowledge/KnowledgeWorker.js';
import { KnowledgeWorkerPool, type KnowledgeWorkerPoolOptions } from '../../src/knowledge/KnowledgeWorkerPool.js';
import { createDefaultAnalyzerRegistry, type AnalyzerInput } from '../../src/knowledge/analyzers/index.js';

const PROJECT_A = 'project_a';
const PROJECT_B = 'project_b';
const START = Date.parse('2026-09-29T00:00:00.000Z');
const LEASE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('KnowledgeWorkerPool', () => {
  let db: Database.Database;
  let queue: KnowledgeQueue;
  let sourceStore: KnowledgeSourceStore;
  let settings: KnowledgeWorkerSettingsStore;
  let roots: string[];
  let clockMs: number;
  let onAnalyze: (input: AnalyzerInput) => Promise<void> | void;
  let analyzeCalls: Map<string, number>;
  let inFlight: number;
  let maxInFlight: number;
  const now = () => new Date(clockMs).toISOString();

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    sourceStore = new KnowledgeSourceStore(db);
    clockMs = START;
    queue = new KnowledgeQueue(db, { leaseDurationMs: LEASE_MS, now });
    settings = new KnowledgeWorkerSettingsStore(new KnowledgeHostSettingsStore(db, { now }));
    roots = [];
    onAnalyze = () => undefined;
    analyzeCalls = new Map();
    inFlight = 0;
    maxInFlight = 0;
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      const root = mkdtempSync(join(process.cwd(), `.knowledge-pool-${projectId}-`));
      roots.push(root);
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, root, projectId, now(), now());
    }
  });

  afterEach(() => {
    db.close();
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function instrumentedAnalyzers() {
    const base = createDefaultAnalyzerRegistry();
    return {
      ...base,
      require: base.require.bind(base),
      resolve(selection: Parameters<typeof base.resolve>[0]) {
        const resolution = base.resolve(selection);
        if (resolution.kind !== 'supported') {
          return resolution;
        }
        const analyzer = resolution.analyzer;
        return {
          ...resolution,
          analyzer: {
            id: analyzer.id,
            version: analyzer.version,
            supports: (input: Parameters<typeof analyzer.supports>[0]) => analyzer.supports(input),
            async analyze(input: AnalyzerInput) {
              analyzeCalls.set(input.sourceVersionId, (analyzeCalls.get(input.sourceVersionId) ?? 0) + 1);
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              try {
                await onAnalyze(input);
                return await analyzer.analyze(input);
              } finally {
                inFlight -= 1;
              }
            },
          },
        };
      },
    };
  }

  function createPool(
    options: Partial<KnowledgeWorkerPoolOptions> = {},
    workerOptions: Partial<KnowledgeWorkerOptions> = {},
  ): KnowledgeWorkerPool {
    return new KnowledgeWorkerPool(
      db,
      {
        baseWorkerId: 'pool-test',
        now,
        workerOptions,
        workerDependencies: { analyzers: instrumentedAnalyzers() },
        queue,
        settings,
        ...options,
      },
    );
  }

  function register(projectId: string, name: string): { sourceVersionId: string } {
    const content = `def ${name}():\n    return "${name}"\n`;
    const contentPath = `sources/files/${name}.py`;
    const absolute = join(roots[projectId === PROJECT_A ? 0 : 1]!, '.ariadne', 'knowledge', contentPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
    const source = sourceStore.register({ projectId, kind: 'file', path: `src/${name}.py`, content, contentPath, mimeType: 'text/x-python' });
    return { sourceVersionId: sourceStore.listVersions(projectId, source.id)[0]!.id };
  }

  function enqueue(projectId: string, name: string, maxRetries?: number) {
    const { sourceVersionId } = register(projectId, name);
    const job = queue.enqueue({
      projectId,
      jobKind: 'analyze',
      sourceVersionId,
      payload: { sourceVersionId },
      ...(maxRetries === undefined ? {} : { maxRetries }),
    });
    return { job, sourceVersionId };
  }

  it('drains one project with bounded parallel slots and completes every job exactly once', async () => {
    const enqueued = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((name) => enqueue(PROJECT_A, name));
    onAnalyze = () => sleep(25);

    const result = await createPool().runOnce(PROJECT_A, { concurrency: 3 });

    expect(result).toMatchObject({
      projectId: PROJECT_A,
      claimed: 6,
      completed: 6,
      failed: 0,
      cancelled: 0,
      concurrency: 3,
      resolvedConcurrency: { value: 3, source: 'override' },
      recoveredExpired: 0,
    });
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    for (const { job, sourceVersionId } of enqueued) {
      expect(queue.get(job.id)?.status).toBe('completed');
      expect(analyzeCalls.get(sourceVersionId)).toBe(1);
    }
    expect(result.slots).toHaveLength(3);
    expect(new Set(result.slots.map((slot) => slot.workerId)).size).toBe(3);
    for (const [index, slot] of result.slots.entries()) {
      expect(slot.workerId).toMatch(new RegExp(`^pool-test/run_[A-Za-z0-9]+/slot_${index + 1}$`));
    }
    expect(result.slots.reduce((sum, slot) => sum + slot.claimed, 0)).toBe(6);
    expect(result.slots.reduce((sum, slot) => sum + slot.completed, 0)).toBe(6);
  });

  it('never exceeds one in-flight job at concurrency 1 and keeps the single-worker result shape', async () => {
    const enqueued = ['s1', 's2', 's3'].map((name) => enqueue(PROJECT_A, name));
    onAnalyze = () => sleep(10);

    const result = await createPool().runOnce(PROJECT_A);

    expect(maxInFlight).toBe(1);
    expect(result).toMatchObject({
      projectId: PROJECT_A,
      claimed: 3,
      completed: 3,
      failed: 0,
      cancelled: 0,
      unsupportedCoverageCount: 0,
      concurrency: 1,
      resolvedConcurrency: { value: 1, source: 'default' },
    });
    expect(result.warnings).toEqual([]);
    expect(result.slots).toHaveLength(1);
    expect(enqueued.every(({ job }) => queue.get(job.id)?.status === 'completed')).toBe(true);
    expect(new KnowledgeGraphReporter(db).getCompletenessReport(PROJECT_A)).not.toBeNull();
  });

  it('counts unsupported coverage-only completions across slots', async () => {
    enqueue(PROJECT_A, 'supported');
    const ruby = sourceStore.register({
      projectId: PROJECT_A,
      kind: 'file',
      path: 'scripts/tool.rb',
      content: 'puts "x"\n',
      contentPath: 'sources/files/tool.rb.txt',
      mimeType: 'application/x-ruby',
    });
    const contentPath = join(roots[0]!, '.ariadne', 'knowledge', 'sources/files/tool.rb.txt');
    mkdirSync(dirname(contentPath), { recursive: true });
    writeFileSync(contentPath, 'puts "x"\n', 'utf8');
    const rubyVersion = sourceStore.listVersions(PROJECT_A, ruby.id)[0]!.id;
    queue.enqueue({ projectId: PROJECT_A, jobKind: 'analyze', sourceVersionId: rubyVersion, payload: { sourceVersionId: rubyVersion } });

    const result = await createPool().runOnce(PROJECT_A, { concurrency: 2 });

    expect(result).toMatchObject({ claimed: 2, completed: 2, unsupportedCoverageCount: 1 });
  });

  it('drains only the requested project and ignores another project host setting', async () => {
    const own = enqueue(PROJECT_A, 'own');
    const other = enqueue(PROJECT_B, 'other');
    settings.setConcurrency(PROJECT_B, 4);

    const result = await createPool().runOnce(PROJECT_A);

    expect(result).toMatchObject({ claimed: 1, completed: 1, concurrency: 1, resolvedConcurrency: { source: 'default' } });
    expect(queue.get(own.job.id)?.status).toBe('completed');
    expect(queue.get(other.job.id)?.status).toBe('queued');
  });

  it('resolves concurrency from the host setting, an override on the pool, then a per-run override', async () => {
    settings.setConcurrency(PROJECT_A, 2);

    const fromSetting = await createPool().runOnce(PROJECT_A);
    expect(fromSetting).toMatchObject({ concurrency: 2, resolvedConcurrency: { value: 2, source: 'host-setting' } });
    expect(fromSetting.slots).toHaveLength(2);

    const fromPoolOption = await createPool({ concurrency: 4 }).runOnce(PROJECT_A);
    expect(fromPoolOption).toMatchObject({ concurrency: 4, resolvedConcurrency: { value: 4, source: 'override' } });

    const fromRun = await createPool({ concurrency: 4 }).runOnce(PROJECT_A, { concurrency: 1 });
    expect(fromRun).toMatchObject({ concurrency: 1, resolvedConcurrency: { value: 1, source: 'override' } });
  });

  it.each([0, 9, 1.5, Number.NaN])('rejects invalid concurrency %s before recovering or claiming anything', async (concurrency) => {
    const { job } = enqueue(PROJECT_A, 'invalid');
    const expired = enqueue(PROJECT_A, 'expired', 0).job;
    queue.claim(PROJECT_A, 'dead-worker');
    queue.claim(PROJECT_A, 'dead-worker');
    clockMs += LEASE_MS + 1;

    await expect(createPool().runOnce(PROJECT_A, { concurrency })).rejects.toThrow(/concurrency must be an integer between 1 and 8/i);

    expect(queue.get(job.id)?.status).toBe('running');
    expect(queue.get(expired.id)?.status).toBe('running');
  });

  it('fails before claiming when the stored host setting is corrupt', async () => {
    const { job } = enqueue(PROJECT_A, 'corrupt');
    db.prepare(
      `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
       VALUES ('s1', ?, 'host.worker.concurrency', '64', ?, ?)`,
    ).run(PROJECT_A, now(), now());

    await expect(createPool().runOnce(PROJECT_A)).rejects.toThrow(/invalid stored value/i);

    expect(queue.get(job.id)?.status).toBe('queued');
  });

  it.each(['', '  ', 'has/slash', 'has space', 'x'.repeat(65), 'sk-secret\nkey'])('rejects unsafe base worker id %j', (baseWorkerId) => {
    expect(() => createPool({ baseWorkerId })).toThrow(/worker id/i);
  });

  it('renews leases per slot so long jobs finish, and only the owning slot id can renew', async () => {
    const firstLease = new KnowledgeQueue(db, { leaseDurationMs: 800 });
    queue = firstLease;
    const jobs = ['r1', 'r2'].map((name) => enqueue(PROJECT_A, name).job);
    const owners: string[] = [];
    let renewalObserved = false;
    let intruderRejected = false;
    onAnalyze = async () => {
      await sleep(30);
      const running = queue.list(PROJECT_A).filter((job) => job.status === 'running');
      if (running.length === 2 && owners.length === 0) {
        owners.push(...running.map((job) => job.workerId!));
        try {
          queue.renewLease(running[0]!.id, 'intruder-worker');
        } catch (error) {
          intruderRejected = /lease/i.test((error as Error).message);
        }
        const before = running[0]!.leaseExpiresAt!;
        await sleep(900);
        renewalObserved = queue.get(running[0]!.id)!.leaseExpiresAt! > before;
      } else {
        await sleep(930);
      }
    };
    const pool = createPool({ now: () => new Date().toISOString() }, { leaseRenewIntervalMs: 20 });

    const result = await pool.runOnce(PROJECT_A, { concurrency: 2 });
    expect(result).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
    expect(result.slots.every((slot) => slot.leaseLosses === 0)).toBe(true);
    expect(new Set(owners).size).toBe(2);
    expect(intruderRejected).toBe(true);
    expect(renewalObserved).toBe(true);
    expect(jobs.every((job) => queue.get(job.id)?.status === 'completed')).toBe(true);
  }, 10_000);

  it('records a lease loss for the losing slot only and never completes or fails the stolen job', async () => {
    const stolen = enqueue(PROJECT_A, 'stolen');
    const healthy = enqueue(PROJECT_A, 'healthy');
    onAnalyze = async (input) => {
      if (input.sourceVersionId === stolen.sourceVersionId) {
        await sleep(15);
        db.prepare(`UPDATE knowledge_jobs SET worker_id = 'other-host/slot_1', lease_expires_at = ? WHERE id = ?`).run(
          new Date(clockMs + LEASE_MS).toISOString(),
          stolen.job.id,
        );
      }
    };

    const result = await createPool().runOnce(PROJECT_A, { concurrency: 2 });

    expect(result).toMatchObject({ claimed: 2, completed: 1, failed: 0, cancelled: 0 });
    expect(result.slots.reduce((sum, slot) => sum + slot.leaseLosses, 0)).toBe(1);
    expect(queue.get(healthy.job.id)?.status).toBe('completed');
    expect(queue.get(stolen.job.id)).toMatchObject({ status: 'running', workerId: 'other-host/slot_1' });
  });

  it('lets sibling slots finish when one slot crashes, then recovers its leased job exactly once', async () => {
    const jobs = ['c1', 'c2', 'c3'].map((name) => enqueue(PROJECT_A, name).job);
    class CrashingWorker extends KnowledgeWorker {
      public override async runOne(projectId: string) {
        queue.claim(projectId, this.crashWorkerId);
        throw new Error('slot crashed while holding a lease');
      }

      public constructor(private readonly crashWorkerId: string, ...args: ConstructorParameters<typeof KnowledgeWorker>) {
        super(...args);
      }
    }
    const pool = createPool({
      createWorker: ({ workerId, signal }) =>
        workerId.endsWith('/slot_1')
          ? new CrashingWorker(workerId, db, { workerId, now, signal }, { queue })
          : new KnowledgeWorker(db, { workerId, now, signal }, { queue, analyzers: instrumentedAnalyzers() }),
    });

    await expect(pool.runOnce(PROJECT_A, { concurrency: 2 })).rejects.toThrow(/slot crashed/);

    const statuses = jobs.map((job) => queue.get(job.id)!.status).sort();
    expect(statuses).toEqual(['completed', 'completed', 'running']);
    const leased = jobs.map((job) => queue.get(job.id)!).find((job) => job.status === 'running')!;
    expect(leased.workerId).toMatch(/\/slot_1$/);

    clockMs += LEASE_MS + 1;
    const recovery = await createPool().runOnce(PROJECT_A);
    expect(recovery).toMatchObject({ recoveredExpired: 1, claimed: 1, completed: 1 });
    expect(queue.get(leased.id)).toMatchObject({ status: 'completed', retryCount: 1 });
    await expect(createPool().runOnce(PROJECT_A)).resolves.toMatchObject({ recoveredExpired: 0, claimed: 0 });
  });

  it('propagates abort to every slot, cancelling in-flight jobs and leaving the rest queued', async () => {
    const controller = new AbortController();
    const jobs = ['x1', 'x2', 'x3', 'x4'].map((name) => enqueue(PROJECT_A, name).job);
    onAnalyze = async () => {
      if (inFlight === 2) {
        controller.abort();
      }
      await sleep(20);
    };

    const result = await createPool({ signal: controller.signal }).runOnce(PROJECT_A, { concurrency: 2 });

    expect(result).toMatchObject({ claimed: 2, completed: 0, failed: 0, cancelled: 2 });
    expect(result.slots.reduce((sum, slot) => sum + slot.cancelled, 0)).toBe(2);
    expect(jobs.map((job) => queue.get(job.id)!.status).sort()).toEqual(['cancelled', 'cancelled', 'queued', 'queued']);
  });

  it('recovers expired leases once per pass and counts recovery failures without claiming', async () => {
    const retryable = enqueue(PROJECT_A, 'retry').job;
    const exhausted = enqueue(PROJECT_A, 'exhausted', 0).job;
    queue.claim(PROJECT_A, 'dead-worker');
    queue.claim(PROJECT_A, 'dead-worker');
    clockMs += LEASE_MS + 1;

    const result = await createPool().runOnce(PROJECT_A, { concurrency: 3 });

    expect(result).toMatchObject({ recoveredExpired: 2, failed: 1, claimed: 1, completed: 1 });
    expect(queue.get(exhausted.id)).toMatchObject({ status: 'failed', failureCode: 'lease_expired' });
    expect(queue.get(retryable.id)).toMatchObject({ status: 'completed', retryCount: 1 });
    expect(result.slots.reduce((sum, slot) => sum + slot.failed, 0)).toBe(0);
  });

  it('never disturbs a leased job when a requeue races slots, and claims the requeued job exactly once', async () => {
    const first = enqueue(PROJECT_A, 'first');
    await createPool().runOnce(PROJECT_A);
    expect(queue.get(first.job.id)?.status).toBe('completed');
    const busy = enqueue(PROJECT_A, 'busy');
    const other = enqueue(PROJECT_A, 'other');
    let leasedRequeue: unknown = 'unset';
    let completedRequeue: unknown = 'unset';
    onAnalyze = async (input) => {
      if (input.sourceVersionId === busy.sourceVersionId) {
        leasedRequeue = queue.requeueAnalyze(busy.job.id, 'analyzer_upgraded');
        completedRequeue = queue.requeueAnalyze(first.job.id, 'analyzer_upgraded');
      }
      await sleep(15);
    };

    const result = await createPool().runOnce(PROJECT_A, { concurrency: 3 });

    expect(leasedRequeue).toBeNull();
    expect(completedRequeue).toMatchObject({ id: first.job.id, status: 'queued' });
    expect(result).toMatchObject({ claimed: 3, completed: 3, failed: 0 });
    expect(analyzeCalls.get(first.sourceVersionId)).toBe(2);
    expect(analyzeCalls.get(busy.sourceVersionId)).toBe(1);
    expect(analyzeCalls.get(other.sourceVersionId)).toBe(1);
    expect([first, busy, other].every(({ job }) => queue.get(job.id)?.status === 'completed')).toBe(true);
  });

  it('watches with repeated pool drains, picks up late work, and stops cleanly on abort', async () => {
    const controller = new AbortController();
    const pool = createPool({ signal: controller.signal });
    const watching = pool.runWatch(PROJECT_A, { concurrency: 2, pollMs: 50 });
    await sleep(80);
    const { job } = enqueue(PROJECT_A, 'late');
    for (let attempt = 0; attempt < 60 && queue.get(job.id)?.status !== 'completed'; attempt += 1) {
      await sleep(25);
    }
    controller.abort();
    await watching;

    expect(queue.get(job.id)?.status).toBe('completed');
  }, 10_000);

  it('does not put host settings or concurrency values into worker ids or warnings', async () => {
    settings.setConcurrency(PROJECT_A, 3);
    enqueue(PROJECT_A, 'quiet');

    const result = await createPool().runOnce(PROJECT_A);

    expect(JSON.stringify(result.slots.map((slot) => slot.workerId))).not.toMatch(/host\.|concurrency/);
    expect(JSON.stringify(result.warnings)).not.toMatch(/host\./);
  });
});
