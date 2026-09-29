import type { EventEmitter } from 'node:events';
import { KnowledgeSourceWatcher } from './KnowledgeSourceWatcher.js';
import { boundedFreshnessMessage, type KnowledgeFreshnessStore } from './KnowledgeFreshnessStore.js';
import type { SourcePolicy } from './SourcePolicy.js';

export interface KnowledgeFreshnessWatchOptions {
  debounceMs?: number;
  rescanIntervalMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  /** Consecutive watcher failures before the status becomes `degraded`; rescans continue either way. */
  degradedAfterFailures?: number;
  signal?: AbortSignal;
}

export interface KnowledgeFreshnessWatcherHandle extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
}

export type KnowledgeFreshnessWatcherFactory = (
  root: string,
  policy: SourcePolicy,
  options: { debounceMs: number },
) => KnowledgeFreshnessWatcherHandle;

type WatchRefreshReason = 'startup' | 'watch-event' | 'periodic-rescan' | 'watch-recovery';

export interface KnowledgeFreshnessWatchHost {
  projectId: string;
  roots: string[];
  policy: SourcePolicy;
  options: KnowledgeFreshnessWatchOptions;
  store: KnowledgeFreshnessStore;
  factory?: KnowledgeFreshnessWatcherFactory;
  now: () => string;
  privateRoots: string[];
  refresh(reason: WatchRefreshReason): Promise<unknown>;
}

const WATCH_EVENTS = ['created', 'changed', 'deleted', 'renamed'] as const;
const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_RESCAN_INTERVAL_MS = 60_000;
const DEFAULT_RESTART_BACKOFF_MS = 1_000;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 60_000;
const DEFAULT_DEGRADED_AFTER_FAILURES = 3;

function positive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Knowledge freshness ${label} must be a positive number`);
  return value;
}

const defaultFactory: KnowledgeFreshnessWatcherFactory = (root, policy, options) =>
  new KnowledgeSourceWatcher(root, policy, options);

/**
 * Supervises one project's watcher set. Filesystem events are only hints: every one schedules a debounced full
 * refresh, and a periodic rescan repairs missed events. A failing watcher set is stopped and restarted with
 * exponential backoff while rescans continue.
 */
export class KnowledgeFreshnessWatchLoop {
  private readonly debounceMs: number;
  private readonly rescanIntervalMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;
  private readonly degradedAfter: number;
  private readonly factory: KnowledgeFreshnessWatcherFactory;
  private active = new Set<KnowledgeFreshnessWatcherHandle>();
  private starting = false;
  private startError: Error | undefined;
  private stopped = false;
  private recovering = false;
  private debounceTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private rescanTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private queuedReason: WatchRefreshReason | undefined;

  public constructor(private readonly host: KnowledgeFreshnessWatchHost) {
    const { options } = host;
    this.debounceMs = positive(options.debounceMs, DEFAULT_DEBOUNCE_MS, 'debounceMs');
    this.rescanIntervalMs = positive(options.rescanIntervalMs, DEFAULT_RESCAN_INTERVAL_MS, 'rescanIntervalMs');
    this.restartBackoffMs = positive(options.restartBackoffMs, DEFAULT_RESTART_BACKOFF_MS, 'restartBackoffMs');
    this.maxRestartBackoffMs = Math.max(
      this.restartBackoffMs,
      positive(options.maxRestartBackoffMs, DEFAULT_MAX_RESTART_BACKOFF_MS, 'maxRestartBackoffMs'),
    );
    this.degradedAfter = positive(options.degradedAfterFailures, DEFAULT_DEGRADED_AFTER_FAILURES, 'degradedAfterFailures');
    this.factory = host.factory ?? defaultFactory;
  }

  public async run(): Promise<void> {
    const { signal } = this.host.options;
    if (signal?.aborted) return;
    const finished = new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await this.runRefresh('startup');
    if (!signal?.aborted) {
      this.rescanTimer = setInterval(() => this.requestRefresh('periodic-rescan'), this.rescanIntervalMs);
      await this.startWatchers();
    }
    if (signal) await finished;
    else await new Promise<void>(() => undefined);
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of [this.debounceTimer, this.restartTimer]) if (timer) clearTimeout(timer);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.stopWatchers();
    await this.running;
    this.host.store.updateWatcher(this.host.projectId, { status: 'stopped' });
  }

  private async startWatchers(): Promise<void> {
    if (this.stopped) return;
    const created: KnowledgeFreshnessWatcherHandle[] = [];
    this.starting = true;
    this.startError = undefined;
    try {
      for (const root of this.host.roots) {
        const watcher = this.factory(root, this.host.policy, { debounceMs: this.debounceMs });
        created.push(watcher);
        this.attach(watcher);
        await watcher.start();
        if (this.startError) break;
      }
    } catch (error) {
      this.startError ??= error instanceof Error ? error : new Error(String(error));
    } finally {
      this.starting = false;
    }
    if (this.startError || this.stopped) {
      for (const watcher of created) watcher.stop();
      if (this.startError) this.handleFailure(this.startError, 'watcher_start_failed');
      return;
    }
    this.active = new Set(created);
    this.onStarted();
  }

  private attach(watcher: KnowledgeFreshnessWatcherHandle): void {
    watcher.on('error', (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      if (this.starting) {
        this.startError ??= normalized;
      } else if (this.active.has(watcher)) {
        this.handleFailure(normalized, 'watcher_error');
      }
    });
    for (const eventName of WATCH_EVENTS) watcher.on(eventName, () => this.onEvent());
  }

  private onStarted(): void {
    const { store, projectId, now } = this.host;
    const previous = store.getWatcher(projectId);
    const wasRecovering = this.recovering;
    this.recovering = false;
    const recoveredError = previous.lastErrorCode === 'watcher_error' || previous.lastErrorCode === 'watcher_start_failed';
    store.updateWatcher(projectId, {
      status: 'watching',
      generation: previous.generation + 1,
      lastRestartAt: now(),
      consecutiveErrorCount: 0,
      ...(recoveredError ? { lastErrorCode: null, lastErrorMessage: null } : {}),
    });
    if (wasRecovering) this.requestRefresh('watch-recovery');
  }

  private handleFailure(error: Error, code: 'watcher_error' | 'watcher_start_failed'): void {
    if (this.stopped) return;
    this.stopWatchers();
    const { store, projectId, privateRoots } = this.host;
    const failures = store.getWatcher(projectId).consecutiveErrorCount + 1;
    this.recovering = true;
    store.updateWatcher(projectId, {
      status: failures >= this.degradedAfter ? 'degraded' : 'recovering',
      consecutiveErrorCount: failures,
      lastErrorCode: code,
      lastErrorMessage: boundedFreshnessMessage(error.message, privateRoots),
    });
    const delay = Math.min(this.restartBackoffMs * 2 ** Math.min(failures - 1, 30), this.maxRestartBackoffMs);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.startWatchers();
    }, delay);
  }

  private stopWatchers(): void {
    const watchers = [...this.active];
    this.active = new Set();
    for (const watcher of watchers) watcher.stop();
  }

  private onEvent(): void {
    if (this.stopped) return;
    this.host.store.updateWatcher(this.host.projectId, { lastEventAt: this.host.now() });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.requestRefresh('watch-event');
    }, this.debounceMs);
  }

  /** Single-flight: refreshes that arrive while one runs collapse into one follow-up pass. */
  private requestRefresh(reason: WatchRefreshReason): void {
    if (this.stopped) return;
    if (this.running) {
      this.queuedReason ??= reason;
      return;
    }
    this.running = this.drain(reason).finally(() => {
      this.running = undefined;
    });
  }

  private async drain(first: WatchRefreshReason): Promise<void> {
    let next: WatchRefreshReason | undefined = first;
    while (next && !this.stopped) {
      this.queuedReason = undefined;
      await this.runRefresh(next);
      next = this.queuedReason;
    }
  }

  private async runRefresh(reason: WatchRefreshReason): Promise<void> {
    try {
      await this.host.refresh(reason);
    } catch {
      // The refresh already recorded a bounded error; the next rescan retries from persisted state.
    }
  }
}
