import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeFreshnessService } from '../../src/knowledge/KnowledgeFreshness.js';
import type {
  KnowledgeFreshnessWatcherFactory,
  KnowledgeFreshnessWatcherHandle,
} from '../../src/knowledge/KnowledgeFreshnessWatch.js';
import { createFreshnessHarness, type FreshnessHarness } from './freshnessTestHarness.js';

class FakeWatcher extends EventEmitter implements KnowledgeFreshnessWatcherHandle {
  public stopped = false;
  public constructor(private readonly onStart: (watcher: FakeWatcher) => void = () => undefined) {
    super();
  }
  public start(): Promise<void> {
    this.onStart(this);
    return Promise.resolve();
  }
  public stop(): void {
    this.stopped = true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('KnowledgeFreshnessService.watchProject', () => {
  let harness: FreshnessHarness;
  let project: { id: string; workspaceRoot: string };
  let controller: AbortController;
  let watching: Promise<void> | undefined;

  const options = { debounceMs: 20, rescanIntervalMs: 60_000, restartBackoffMs: 10, maxRestartBackoffMs: 40, degradedAfterFailures: 3 };
  const versionCount = (): number =>
    (harness.db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_versions WHERE project_id = ?').get(project.id) as { count: number }).count;

  function serviceWith(factory?: KnowledgeFreshnessWatcherFactory): KnowledgeFreshnessService {
    return new KnowledgeFreshnessService(harness.db, { queue: harness.queue, watcherFactory: factory });
  }

  beforeEach(() => {
    harness = createFreshnessHarness();
    project = harness.createProject('project_w');
    controller = new AbortController();
  });

  afterEach(async () => {
    controller.abort();
    await watching;
    watching = undefined;
    harness.cleanup();
  });

  it('runs a startup refresh before opening watchers, then reports watching with generation 1', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    const order: string[] = [];
    const service = serviceWith((root) => {
      order.push(`watcher:${versionCount()}`);
      return new FakeWatcher();
    });

    watching = service.watchProject(project.id, { ...options, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    expect(order).toEqual(['watcher:1']);
    expect(service.getStatus(project.id)).toMatchObject({ generation: 1, pendingCount: 1, lastErrorCode: null });
  });

  it('recovers automatically after a startup error and runs a watch-recovery refresh', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    let attempts = 0;
    const service = serviceWith(() =>
      new FakeWatcher((watcher) => {
        attempts += 1;
        if (attempts === 1) watcher.emit('error', new Error(`ENOSPC while watching ${project.workspaceRoot}/docs`));
      }),
    );
    const refresh = vi.spyOn(service, 'refreshProject');

    watching = service.watchProject(project.id, { ...options, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    expect(attempts).toBe(2);
    expect(refresh.mock.calls.map(([, reason]) => reason)).toEqual(['startup', 'watch-recovery']);
    const status = service.getStatus(project.id);
    expect(status).toMatchObject({ generation: 1, lastErrorCode: null });
    const watcherRow = harness.db.prepare('SELECT consecutive_error_count, last_restart_at FROM knowledge_project_watchers WHERE project_id = ?').get(project.id) as { consecutive_error_count: number; last_restart_at: string };
    expect(watcherRow.consecutive_error_count).toBe(0);
    expect(watcherRow.last_restart_at).toBeTruthy();
  });

  it('records a bounded, path-free error while recovering', async () => {
    let attempts = 0;
    const service = serviceWith(() =>
      new FakeWatcher((watcher) => {
        attempts += 1;
        if (attempts < 50) watcher.emit('error', new Error(`EMFILE opening ${project.workspaceRoot}/docs/${'x'.repeat(2_000)}`));
      }),
    );
    watching = service.watchProject(project.id, { ...options, restartBackoffMs: 5_000, maxRestartBackoffMs: 5_000, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'recovering');

    const status = service.getStatus(project.id);
    expect(status.lastErrorCode).toBe('watcher_start_failed');
    expect(status.lastErrorMessage).not.toContain(project.workspaceRoot);
    expect((status.lastErrorMessage ?? '').length).toBeLessThanOrEqual(300);
  });

  it('recovers from a runtime watcher error by restarting the watcher set and incrementing the generation', async () => {
    const watchers: FakeWatcher[] = [];
    const service = serviceWith(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    });
    watching = service.watchProject(project.id, { ...options, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    watchers[0].emit('error', new Error('inotify limit reached'));
    expect(service.getStatus(project.id).watcherStatus).toBe('recovering');
    expect(watchers[0].stopped).toBe(true);
    await waitFor(() => service.getStatus(project.id).generation === 2);

    expect(service.getStatus(project.id)).toMatchObject({ watcherStatus: 'watching', lastErrorCode: null });
    expect(watchers).toHaveLength(2);
  });

  it('collapses an event burst into a single debounced watch-event refresh', async () => {
    const watchers: FakeWatcher[] = [];
    const service = serviceWith(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    });
    const refresh = vi.spyOn(service, 'refreshProject');
    watching = service.watchProject(project.id, { ...options, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    harness.writeFile(project.workspaceRoot, 'burst.md', 'one');
    for (let index = 0; index < 8; index += 1) watchers[0].emit(index % 2 ? 'changed' : 'created', { path: 'burst.md' });
    await waitFor(() => refresh.mock.calls.some(([, reason]) => reason === 'watch-event'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(refresh.mock.calls.filter(([, reason]) => reason === 'watch-event')).toHaveLength(1);
    expect(versionCount()).toBe(1);
  });

  it('detects a change through the periodic rescan when no filesystem event is emitted', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    const service = serviceWith(() => new FakeWatcher());
    watching = service.watchProject(project.id, { ...options, rescanIntervalMs: 40, signal: controller.signal });
    await waitFor(() => versionCount() === 1);

    harness.writeFile(project.workspaceRoot, 'a.md', 'two');
    await waitFor(() => versionCount() === 2);

    const jobs = harness.queue.list(project.id).filter((job) => job.jobKind === 'analyze');
    expect(jobs).toHaveLength(2);
  });

  it('enters degraded after repeated restart failures, keeps rescanning, and recovers to watching', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    let healthy = false;
    const service = serviceWith(() =>
      new FakeWatcher((watcher) => {
        if (!healthy) watcher.emit('error', new Error('EACCES'));
      }),
    );
    watching = service.watchProject(project.id, { ...options, rescanIntervalMs: 30, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'degraded');

    harness.writeFile(project.workspaceRoot, 'a.md', 'two');
    await waitFor(() => versionCount() === 2);
    expect(service.getStatus(project.id).watcherStatus).toBe('degraded');
    const failures = (harness.db.prepare('SELECT consecutive_error_count AS count FROM knowledge_project_watchers WHERE project_id = ?').get(project.id) as { count: number }).count;
    expect(failures).toBeGreaterThanOrEqual(3);

    healthy = true;
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');
    expect(service.getStatus(project.id)).toMatchObject({ generation: 1, lastErrorCode: null });
  });

  it('backs off exponentially between restart attempts, capped by the maximum', async () => {
    const startedAt: number[] = [];
    const service = serviceWith(() =>
      new FakeWatcher((watcher) => {
        startedAt.push(Date.now());
        watcher.emit('error', new Error('boom'));
      }),
    );
    watching = service.watchProject(project.id, { ...options, restartBackoffMs: 30, maxRestartBackoffMs: 60, signal: controller.signal });
    await waitFor(() => startedAt.length >= 4);

    const gaps = startedAt.slice(1, 4).map((time, index) => time - startedAt[index]);
    expect(gaps[0]).toBeGreaterThanOrEqual(25);
    expect(gaps[1]).toBeGreaterThanOrEqual(55);
    expect(gaps[2]).toBeLessThan(200);
  });

  it('keeps freshness correct after watcher errors: a change made while recovering is picked up', async () => {
    harness.writeFile(project.workspaceRoot, 'a.md', 'one');
    let healthy = false;
    const service = serviceWith(() =>
      new FakeWatcher((watcher) => {
        if (!healthy) watcher.emit('error', new Error('boom'));
      }),
    );
    watching = service.watchProject(project.id, { ...options, restartBackoffMs: 30, maxRestartBackoffMs: 30, degradedAfterFailures: 99, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'recovering');
    harness.writeFile(project.workspaceRoot, 'a.md', 'two');
    healthy = true;

    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');
    await waitFor(() => versionCount() === 2);
  });

  it('stops watchers, cancels timers, and reports stopped when aborted', async () => {
    const watchers: FakeWatcher[] = [];
    const service = serviceWith(() => {
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    });
    watching = service.watchProject(project.id, { ...options, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    controller.abort();
    await watching;

    expect(watchers.every((watcher) => watcher.stopped)).toBe(true);
    expect(service.getStatus(project.id).watcherStatus).toBe('stopped');
  });

  it('watches a real directory: a created file is registered without any manual rescan', async () => {
    const service = serviceWith();
    watching = service.watchProject(project.id, { ...options, debounceMs: 30, signal: controller.signal });
    await waitFor(() => service.getStatus(project.id).watcherStatus === 'watching');

    harness.writeFile(project.workspaceRoot, 'live.md', 'live');

    await waitFor(() => versionCount() === 1, 4_000);
    expect(service.getStatus(project.id).generation).toBe(1);
  });

  it('rejects invalid options and unknown projects', () => {
    const service = serviceWith();
    expect(() => service.watchProject(project.id, { debounceMs: 0 })).toThrow(/debounceMs/);
    expect(() => service.watchProject('project_unknown')).toThrow(/not found/i);
  });
});
