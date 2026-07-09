import type { TaskStore } from './TaskStore.js';
import type { TaskStatus } from './types.js';

/**
 * Cross-entity workspace search — replaces the earlier per-surface
 * "substring match over task title/goal only" placeholder (previously
 * duplicated ad hoc in the MCP server's `searchTasks` and the CLI's
 * `search` command). Searches every entity a task can have (goal,
 * checkpoints, decisions, todos, errors, open questions, files, commits)
 * so "find where we decided X" / "find the task with that error" work
 * across a whole workspace, not just by title. Rule-based only (plain
 * case-insensitive substring matching) — no embeddings/LLM calls, per the
 * MVP's fully-deterministic, offline decision.
 */

export type SearchCategory =
  | 'title'
  | 'goal'
  | 'checkpoint'
  | 'decision'
  | 'todo'
  | 'error'
  | 'question'
  | 'file'
  | 'commit';

export interface SearchMatch {
  category: SearchCategory;
  /** The matched entity's own id (task id for title/goal matches, since those aren't separate rows). */
  id: string;
  text: string;
  createdAt: string;
}

export interface SearchResult {
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  /** All matches within this task, most recent first. */
  matches: SearchMatch[];
}

export interface SearchOptions {
  /** Max number of tasks returned, ranked by match count then recency. Default 20. */
  limit?: number;
  /** Max matches kept per task (across all categories combined). Default 10. */
  maxMatchesPerTask?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_MATCHES_PER_TASK = 10;

function includesQuery(haystack: string | null | undefined, needle: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(needle);
}

/**
 * Searches every task in the workspace (or store) for `query`, matching
 * against task title/goal plus every checkpoint, decision, todo, error,
 * open question, file path, and commit message belonging to it. Results are
 * grouped by task and ranked by (number of matches desc, most recent match
 * timestamp desc) — tasks with more/newer relevant hits surface first.
 */
export function searchWorkspace(store: TaskStore, query: string, options: SearchOptions = {}): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxMatchesPerTask = options.maxMatchesPerTask ?? DEFAULT_MAX_MATCHES_PER_TASK;

  const results: SearchResult[] = [];

  for (const task of store.listTasks()) {
    const matches: SearchMatch[] = [];

    if (includesQuery(task.title, needle)) {
      matches.push({ category: 'title', id: task.id, text: task.title, createdAt: task.createdAt });
    }
    if (includesQuery(task.goal, needle)) {
      matches.push({ category: 'goal', id: task.id, text: task.goal!, createdAt: task.createdAt });
    }

    for (const cp of store.listCheckpoints(task.id)) {
      if (includesQuery(cp.summary, needle)) {
        matches.push({ category: 'checkpoint', id: cp.id, text: cp.summary, createdAt: cp.createdAt });
      }
    }
    for (const d of store.listDecisions(task.id)) {
      if (includesQuery(d.text, needle) || includesQuery(d.rationale, needle)) {
        matches.push({ category: 'decision', id: d.id, text: d.text, createdAt: d.createdAt });
      }
    }
    for (const td of store.listTodos(task.id)) {
      if (includesQuery(td.text, needle)) {
        matches.push({ category: 'todo', id: td.id, text: td.text, createdAt: td.createdAt });
      }
    }
    for (const e of store.listErrors(task.id)) {
      if (includesQuery(e.message, needle) || includesQuery(e.resolution, needle)) {
        matches.push({ category: 'error', id: e.id, text: e.message, createdAt: e.createdAt });
      }
    }
    for (const q of store.listOpenQuestions(task.id)) {
      if (includesQuery(q.text, needle)) {
        matches.push({ category: 'question', id: q.id, text: q.text, createdAt: q.createdAt });
      }
    }
    for (const f of store.listFiles(task.id)) {
      if (includesQuery(f.path, needle)) {
        matches.push({ category: 'file', id: f.path, text: f.path, createdAt: f.lastTouched });
      }
    }
    for (const c of store.listCommits(task.id)) {
      if (includesQuery(c.message, needle)) {
        matches.push({ category: 'commit', id: c.sha, text: c.message!, createdAt: c.createdAt });
      }
    }

    if (matches.length === 0) continue;

    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    results.push({
      taskId: task.id,
      taskTitle: task.title,
      taskStatus: task.status,
      matches: matches.slice(0, maxMatchesPerTask),
    });
  }

  results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
    return b.matches[0].createdAt.localeCompare(a.matches[0].createdAt);
  });

  return results.slice(0, limit);
}
