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
  /** This task's last known tracked git branch (updated by passive capture or `git-sync`); null if never set. */
  branch: string | null;
  /**
   * The workspace root this task's store was opened from, if the caller
   * knows it (surfaces pass this in explicitly since `buildContext` itself
   * is store-scoped and workspace-agnostic). Especially useful for
   * cross-workspace results, where it isn't otherwise obvious which
   * workspace's repo/state a task's status refers to.
   */
  workspaceRoot: string | null;
  latestSummary: string | null;
  openQuestions: string[];
  openTodos: string[];
  /** Todos explicitly marked blocked (distinct from pending) — surfaced separately since a blocker is important status context, not just another pending item. */
  blockedTodos: string[];
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
  /** The workspace root this task's store was opened from, if known — passed through unchanged into `ContextPackage.workspaceRoot`. */
  workspaceRoot?: string;
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
 * Gathers every ranking candidate (open questions, errors, decisions,
 * files, todos, commits, commands) plus the never-trim goal/latest-summary
 * fields for `taskId`, without yet sorting or budget-filling them. Shared
 * by `buildContext` (rule-based tier + recency sort) and
 * `buildContextWithEmbeddingRanking` (similarity-to-query sort) so both
 * ranking strategies see identical candidate data — only the *ordering*
 * differs between them.
 */
function gatherContextData(
  store: TaskStore,
  taskId: string,
): {
  goal: string | null;
  branch: string | null;
  latestSummary: string | null;
  candidates: Candidate[];
} {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`No task found with id "${taskId}".`);
  }

  const goal = task.goal ?? null;
  const latestCheckpoint = store.latestCheckpoint(taskId);
  const latestSummary = latestCheckpoint?.summary ?? null;

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

  const blockedTodos = store.listTodos(taskId, { status: 'blocked' });
  for (const t of blockedTodos) {
    candidates.push({ tier: 'high', category: 'blockedTodos', createdAt: t.createdAt, cost: estimateTokens(t.text), text: t.text });
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

  return { goal, branch: task.branch ?? null, latestSummary, candidates };
}

/** Greedily fills `candidates` (already sorted in the desired priority order) under `tokenBudget`, returning what was included per category and what got cut. */
function fillBudget(
  candidates: Candidate[],
  tokenBudget: number,
): { included: Record<string, Candidate[]>; truncated: Record<string, number> } {
  let remaining = tokenBudget;
  const included: Record<string, Candidate[]> = {};
  const truncated: Record<string, number> = {};
  for (const candidate of candidates) {
    if (candidate.cost <= remaining) {
      remaining -= candidate.cost;
      (included[candidate.category] ??= []).push(candidate);
    } else {
      truncated[candidate.category] = (truncated[candidate.category] ?? 0) + 1;
    }
  }
  return { included, truncated };
}

/** Assembles the final `ContextPackage` from already-ranked-and-budgeted `included` candidates. Shared by both ranking strategies. */
function toContextPackage(
  taskId: string,
  goal: string | null,
  branch: string | null,
  workspaceRoot: string | null,
  latestSummary: string | null,
  included: Record<string, Candidate[]>,
  truncated: Record<string, number>,
): ContextPackage {
  return {
    taskId,
    goal,
    branch,
    workspaceRoot,
    latestSummary,
    openQuestions: (included.openQuestions ?? []).map((c) => c.text),
    openTodos: (included.pendingTodos ?? []).map((c) => c.text),
    blockedTodos: (included.blockedTodos ?? []).map((c) => c.text),
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
  const { goal, branch, latestSummary, candidates } = gatherContextData(store, taskId);

  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const neverTrimCost = estimateTokens(goal ?? '') + estimateTokens(latestSummary ?? '');
  const remainingBudget = tokenBudget - neverTrimCost;

  // --- Sort: tier priority first, then most-recent-first within a tier. ---
  candidates.sort((a, b) => {
    const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

  const { included, truncated } = fillBudget(candidates, remainingBudget);
  return toContextPackage(taskId, goal, branch, options.workspaceRoot ?? null, latestSummary, included, truncated);
}

// ---------------------------------------------------------------------------
// Embedding-based context ranking (additive, opt-in).
//
// `buildContext` above ranks candidates deterministically by tier + recency,
// with zero external dependencies. That's the right default, but it has no
// notion of *relevance to what the agent is actually asking about right
// now*. This section adds an optional, purely additive ranking mode that
// re-orders the same candidate pool by embedding-similarity to a caller-
// supplied query string, instead of tier/recency. It never changes
// `buildContext`'s behavior — existing callers and tests are untouched.
// ---------------------------------------------------------------------------

/**
 * Minimal embedding-provider contract. Implementations may call out to a
 * local model, a hosted API, or anything else — `ContextBuilder` only needs
 * batched text -> vector conversion. Keeping the interface this small (one
 * method, no config) makes it trivial to implement with any embedding
 * backend (OpenAI, local ONNX model, etc.) without coupling core to a
 * specific provider or requiring network access by default.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Cosine similarity between two equal-length numeric vectors, in [-1, 1].
 * Returns 0 for zero-length or zero-magnitude vectors (rather than NaN) so
 * a degenerate embedding never crashes ranking or forces every consumer to
 * special-case it.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface BuildContextWithEmbeddingRankingOptions extends BuildContextOptions {
  /**
   * Number of highest-similarity candidates to always keep regardless of
   * tier, before falling back to tier order for anything left over. Lets
   * "on-topic but low tier" items (e.g. a resolved todo that exactly
   * matches the query) outrank "off-topic but high tier" items, which is
   * the entire point of embedding ranking. Defaults to including every
   * candidate in similarity order.
   */
  topK?: number;
}

/**
 * Like `buildContext`, but ranks candidates by cosine similarity between
 * `query`'s embedding and each candidate's embedding, instead of by
 * tier + recency. Falls back to the same greedy token-budget fill as
 * `buildContext`, just with a different candidate order.
 *
 * The never-trim tier (goal + latest checkpoint summary) is unaffected —
 * it's always included first, exactly as in `buildContext`.
 *
 * This is intentionally a separate async function rather than a new
 * `buildContext` option: embedding calls are async and potentially slow or
 * networked, so callers that want the fast, synchronous, zero-dependency
 * default keep using `buildContext` unchanged.
 */
export async function buildContextWithEmbeddingRanking(
  store: TaskStore,
  taskId: string,
  query: string,
  embed: EmbeddingProvider,
  options: BuildContextWithEmbeddingRankingOptions = {},
): Promise<ContextPackage> {
  const { goal, branch, latestSummary, candidates } = gatherContextData(store, taskId);

  const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const neverTrimCost = estimateTokens(goal ?? '') + estimateTokens(latestSummary ?? '');
  const remainingBudget = tokenBudget - neverTrimCost;

  if (candidates.length === 0) {
    return toContextPackage(taskId, goal, branch, options.workspaceRoot ?? null, latestSummary, {}, {});
  }

  // Embed the query and every candidate's text in one batched call so a
  // real network-backed provider only pays one round trip per buildContext
  // call, not one per candidate.
  const vectors = await embed.embed([query, ...candidates.map((c) => c.text)]);
  const queryVector = vectors[0];
  const candidateVectors = vectors.slice(1);

  const ranked = candidates
    .map((candidate, i) => ({ candidate, similarity: cosineSimilarity(queryVector, candidateVectors[i]) }))
    .sort((a, b) => b.similarity - a.similarity);

  const topK = options.topK ?? ranked.length;
  const orderedCandidates: Candidate[] = [];
  for (let i = 0; i < ranked.length; i++) {
    if (i < topK) {
      orderedCandidates.push(ranked[i].candidate);
    }
  }
  // Anything beyond topK still gets a chance to fill leftover budget, in
  // tier order, so a generous topK doesn't silently drop otherwise-includable
  // context — it only controls *priority*, not exclusion.
  if (topK < ranked.length) {
    const remainder = ranked.slice(topK).map((r) => r.candidate);
    remainder.sort((a, b) => {
      const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
      if (tierDiff !== 0) return tierDiff;
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });
    orderedCandidates.push(...remainder);
  }

  const { included, truncated } = fillBudget(orderedCandidates, remainingBudget);
  return toContextPackage(taskId, goal, branch, options.workspaceRoot ?? null, latestSummary, included, truncated);
}
