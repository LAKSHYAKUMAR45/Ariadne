import type { Checkpoint, CheckpointLevel } from './types.js';
import type { TaskStore } from './TaskStore.js';

/**
 * Rule-based, event-triggered checkpoint creation and hierarchical rollup —
 * the `CheckpointEngine` from docs/02-ARCHITECTURE.md, implementing the
 * triggers and rollup rules from docs/03-DATA-MODEL.md section 6. No LLM
 * calls: summaries are generated with plain string templates, and rollup is
 * pure string/set aggregation (dedupe identical summaries; everything else
 * is kept verbatim), per the MVP's rule-based-only decision.
 */

export const DEFAULT_FILE_TRIGGER_THRESHOLD = 5;
export const DEFAULT_IDLE_TRIGGER_MINUTES = 10;

const LEVEL_RANK: Record<CheckpointLevel, number> = { micro: 0, session: 1, milestone: 2 };

// ---------------------------------------------------------------------
// Rule-based summary generators
// ---------------------------------------------------------------------

export function summarizeFileBatch(paths: string[]): string {
  const MAX_LISTED = 8;
  const listed = paths.slice(0, MAX_LISTED).join(', ');
  const suffix = paths.length > MAX_LISTED ? ` (+${paths.length - MAX_LISTED} more)` : '';
  return `Edited ${paths.length} file${paths.length === 1 ? '' : 's'}: ${listed}${suffix}`;
}

export function summarizeCommit(sha: string, message: string | null): string {
  return `Committed ${sha.slice(0, 7)}${message ? `: ${message}` : ''}`;
}

export function summarizeError(message: string): string {
  return `New error: ${message}`;
}

export function summarizeIdle(filesTouched: number): string {
  return `Session paused after ${filesTouched} file${filesTouched === 1 ? '' : 's'} touched (idle).`;
}

// ---------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------

/**
 * Creates a micro checkpoint if at least `threshold` files (default 5) have
 * been touched since the last checkpoint. Returns null if the trigger
 * condition isn't met yet.
 */
export function maybeCheckpointOnFileActivity(
  store: TaskStore,
  taskId: string,
  options: { threshold?: number } = {},
): Checkpoint | null {
  const threshold = options.threshold ?? DEFAULT_FILE_TRIGGER_THRESHOLD;
  const latest = store.latestCheckpoint(taskId);
  const files = store.listFiles(taskId);
  const touchedSince = latest ? files.filter((f) => f.lastTouched > latest.createdAt) : files;
  if (touchedSince.length < threshold) return null;
  return store.createCheckpoint({
    taskId,
    level: 'micro',
    summary: summarizeFileBatch(touchedSince.map((f) => f.path)),
  });
}

/** A git commit always triggers a micro checkpoint (per docs/03-DATA-MODEL.md section 6). */
export function checkpointOnCommit(store: TaskStore, taskId: string, sha: string, message: string | null): Checkpoint {
  return store.createCheckpoint({ taskId, level: 'micro', summary: summarizeCommit(sha, message) });
}

/** A newly recorded unresolved error always triggers a micro checkpoint. */
export function checkpointOnError(store: TaskStore, taskId: string, message: string): Checkpoint {
  return store.createCheckpoint({ taskId, level: 'micro', summary: summarizeError(message) });
}

/**
 * Creates a micro checkpoint if the task has gone idle (no checkpoint) for
 * longer than `idleMinutes` (default 10) since its last checkpoint, and
 * there's been file activity since then worth capturing. Returns null
 * otherwise.
 */
export function maybeCheckpointOnIdle(
  store: TaskStore,
  taskId: string,
  options: { idleMinutes?: number; now?: Date } = {},
): Checkpoint | null {
  const idleMinutes = options.idleMinutes ?? DEFAULT_IDLE_TRIGGER_MINUTES;
  const now = options.now ?? new Date();
  const latest = store.latestCheckpoint(taskId);
  const files = store.listFiles(taskId);
  const touchedSince = latest ? files.filter((f) => f.lastTouched > latest.createdAt) : files;
  if (touchedSince.length === 0) return null;

  const sinceMs = latest ? now.getTime() - new Date(latest.createdAt).getTime() : Infinity;
  if (sinceMs < idleMinutes * 60_000) return null;

  return store.createCheckpoint({ taskId, level: 'micro', summary: summarizeIdle(touchedSince.length) });
}

// ---------------------------------------------------------------------
// Hierarchical rollup
// ---------------------------------------------------------------------

/**
 * Rolls up every `from`-level checkpoint recorded since the most recent
 * `to`-level-or-higher checkpoint into one new `to`-level checkpoint — e.g.
 * `rollupCheckpoints(store, taskId, 'micro', 'session')` at session end, or
 * `rollupCheckpoints(store, taskId, 'session', 'milestone')` at a major
 * event (PR opened, task marked done). The rolled-up checkpoints are
 * re-parented under the new one (`parentCheckpointId`). Returns null if
 * there's nothing to roll up.
 *
 * The rollup itself is pure string/set aggregation, not an LLM
 * summarization call: identical summaries are deduped, and everything else
 * (decisions/errors/commits, already recorded verbatim in checkpoint
 * summaries) is kept as-is, oldest first.
 */
export function rollupCheckpoints(
  store: TaskStore,
  taskId: string,
  from: CheckpointLevel,
  to: CheckpointLevel,
): Checkpoint | null {
  if (LEVEL_RANK[to] <= LEVEL_RANK[from]) {
    throw new Error(`Cannot roll up "${from}" into "${to}": rollup must target a strictly higher level.`);
  }

  const all = store.listCheckpoints(taskId); // newest first
  const boundary = all.find((c) => LEVEL_RANK[c.level] >= LEVEL_RANK[to]);
  const candidates = all.filter((c) => c.level === from && (!boundary || c.createdAt > boundary.createdAt));
  if (candidates.length === 0) return null;

  const chronological = [...candidates].reverse(); // oldest first
  const uniqueSummaries = [...new Set(chronological.map((c) => c.summary))];
  const summary = uniqueSummaries.map((s) => `- ${s}`).join('\n');

  const rolled = store.createCheckpoint({ taskId, level: to, summary });
  for (const c of chronological) {
    store.setCheckpointParent(c.id, rolled.id);
  }
  return rolled;
}
