import type { TaskStore } from './TaskStore.js';

/**
 * Ranked, token-budgeted context assembly — the `ContextBuilder` from
 * docs/02-ARCHITECTURE.md and the ranking algorithm in
 * docs/03-DATA-MODEL.md section 5. Shared by every surface (CLI, MCP
 * server, VS Code extension) so "resume"/"status"/`get_context` all use the
 * same ranking instead of each reimplementing an ad-hoc dump of raw data.
 */

/** Default token budget when the caller doesn't specify one. Deliberately conservative so a context package stays cheap to inject into any chat/agent prompt. */
export const DEFAULT_TOKEN_BUDGET = 2000;

/**
 * Estimates token count for a piece of text using a simple `chars / 4`
 * heuristic — a common, model-agnostic rule of thumb for English text/code.
 * This resolves the "token-counting method" open question from
 * docs/04-ROADMAP.md in favor of a deterministic, offline estimate rather
 * than a model-specific tokenizer dependency (which would conflict with
 * staying LLM-agnostic and fully rule-based for the MVP).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface ContextFileRef {
  path: string;
  role: string;
}

interface ContextFileRefSource {
  path: string;
  role: string;
}

export interface ContextCommitRef {
  sha: string;
  message: string | null;
}

interface ContextCommitRefSource {
  sha: string;
  message: string | null;
}

export interface ContextCommandRef {
  cmd: string;
  exitCode: number | null;
}

interface ContextCommandRefSource {
  cmdRedacted: string;
  summary: string | null;
  exitCode: number | null;
}

export interface ContextPackage {
  taskId: string;
  goal: string | null;
  latestSummary: string | null;
  openQuestions: string[];
  openTodos: string[];
  unresolvedErrors: string[];
  recentFiles: ContextFileRef[];
  recentCommits: ContextCommitRef[];
  /** Recently run terminal commands (captured via passive capture or `git-sync`), most-recent-first, trimmed to fit the token budget like everything else. Was previously stored but never surfaced here — see docs/04-ROADMAP.md gap tracking. */
  recentCommands: ContextCommandRef[];
  decisions: string[];
  /** What was cut for budget, keyed by category, e.g. `{ commands: 12, resolvedTodos: 5 }`. */
  truncated: Record<string, number>;
}

export interface BuildContextOptions {
  tokenBudget?: number;
}

type Tier = 'high' | 'medium' | 'low';

interface Candidate {
  tier: Tier;
  category: string;
  createdAt: string;
  cost: number;
  text: string;
  data?: unknown;
}

const TIER_ORDER: Record<Tier, number> = { high: 0, medium: 1, low: 2 };

/**
 * Builds a ranked, budgeted context package for `taskId`.
 *
 * Priority tiers (per docs/03-DATA-MODEL.md section 5), filled greedily
 * under `tokenBudget`:
 * 1. Never-trim: active task goal, latest checkpoint summary.
 * 2. High: open questions, unresolved errors, current (non-superseded) decisions.
 * 3. Medium: recently touched files, pending todos, commits since the last checkpoint.
 * 4. Low: resolved todos, superseded/historical decisions, full command log.
 *
 * Within a tier, items are ordered most-recent-first. This is intentionally
 * simple and deterministic (no LLM call, no external tokenizer) to match the
 * MVP's rule-based-only decision.
 */
export function buildContext(store: TaskStore, taskId: string, options: BuildContextOptions = {}): ContextPackage {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`No task found with id "${taskId}".`);
  }

  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  let remaining = tokenBudget;
  const truncated: Record<string, number> = {};

  // --- Never-trim tier: goal + latest checkpoint summary always included. ---
  const goal = task.goal ?? null;
  remaining -= estimateTokens(goal ?? '');

  const latestCheckpoint = store.latestCheckpoint(taskId);
  const latestSummary = latestCheckpoint?.summary ?? null;
  remaining -= estimateTokens(latestSummary ?? '');

  // --- Gather candidates for the ranked (high/medium/low) tiers. ---
  const candidates: Candidate[] = [];

  const openQuestions = store.listOpenQuestions(taskId, { resolved: false });
  for (const q of openQuestions) {
    candidates.push({ tier: 'high', category: 'openQuestions', createdAt: q.createdAt, cost: estimateTokens(q.text), text: q.text });
  }

  const unresolvedErrors = store.listErrors(taskId, { resolved: false });
  for (const e of unresolvedErrors) {
    candidates.push({ tier: 'high', category: 'unresolvedErrors', createdAt: e.createdAt, cost: estimateTokens(e.message), text: e.message });
  }

  // A decision is "current" (high tier) unless some other decision's
  // supersedesId points at it, in which case it's historical (low tier).
  const allDecisions = store.listDecisions(taskId, 200);
  const supersededIds = new Set(allDecisions.map((d) => d.supersedesId).filter((id): id is string => Boolean(id)));
  for (const d of allDecisions) {
    const tier: Tier = supersededIds.has(d.id) ? 'low' : 'high';
    const category = tier === 'high' ? 'decisions' : 'historicalDecisions';
    candidates.push({ tier, category, createdAt: d.createdAt, cost: estimateTokens(d.text), text: d.text });
  }

  const recentFiles = store.listFiles(taskId, 50);
  for (const f of recentFiles) {
    const text = `${f.path} (${f.role})`;
    candidates.push({ tier: 'medium', category: 'recentFiles', createdAt: f.lastTouched, cost: estimateTokens(text), text, data: f });
  }

  const pendingTodos = store.listTodos(taskId, { status: 'pending' });
  for (const t of pendingTodos) {
    candidates.push({ tier: 'medium', category: 'pendingTodos', createdAt: t.createdAt, cost: estimateTokens(t.text), text: t.text });
  }

  // Commits since the last checkpoint (message only, per the data model doc).
  const allCommits = store.listCommits(taskId, 100);
  const sinceCheckpoint = latestCheckpoint
    ? allCommits.filter((c) => c.createdAt > latestCheckpoint.createdAt)
    : allCommits;
  for (const c of sinceCheckpoint) {
    const text = c.message ?? c.sha;
    candidates.push({ tier: 'medium', category: 'recentCommits', createdAt: c.createdAt, cost: estimateTokens(text), text, data: c });
  }

  const resolvedTodos = store.listTodos(taskId, { status: 'done' });
  for (const t of resolvedTodos) {
    candidates.push({ tier: 'low', category: 'resolvedTodos', createdAt: t.updatedAt, cost: estimateTokens(t.text), text: t.text });
  }

  const commands = store.listCommands(taskId, 200);
  for (const c of commands) {
    const text = c.summary ?? c.cmdRedacted;
    candidates.push({ tier: 'low', category: 'commands', createdAt: c.createdAt, cost: estimateTokens(text), text, data: c });
  }

  // --- Sort: tier priority first, then most-recent-first within a tier. ---
  candidates.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

  // --- Greedily fill under the remaining budget; anything that doesn't fit is counted as truncated. ---
  const included: Record<string, Candidate[]> = {};
  for (const candidate of candidates) {
    if (candidate.cost <= remaining) {
      remaining -= candidate.cost;
      (included[candidate.category] ??= []).push(candidate);
    } else {
      truncated[candidate.category] = (truncated[candidate.category] ?? 0) + 1;
    }
  }

  return {
    taskId,
    goal,
    latestSummary,
    openQuestions: (included.openQuestions ?? []).map((c) => c.text),
    openTodos: (included.pendingTodos ?? []).map((c) => c.text),
    unresolvedErrors: (included.unresolvedErrors ?? []).map((c) => c.text),
    recentFiles: (included.recentFiles ?? [])
      .map((c) => c.data as ContextFileRefSource)
      .map((f) => ({ path: f.path, role: f.role })),
    recentCommits: (included.recentCommits ?? [])
      .map((c) => c.data as ContextCommitRefSource)
      .map((c) => ({ sha: c.sha, message: c.message })),
    recentCommands: (included.commands ?? [])
      .map((c) => c.data as ContextCommandRefSource)
      .map((c) => ({ cmd: c.summary ?? c.cmdRedacted, exitCode: c.exitCode })),
    decisions: (included.decisions ?? []).map((c) => c.text),
    truncated,
  };
}
