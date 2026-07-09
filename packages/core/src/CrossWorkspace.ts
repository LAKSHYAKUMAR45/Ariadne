import { openWorkspaceStore } from './workspace.js';
import { openRegistry, listAllTasks, listWorkspaces, findTaskWorkspace, type TaskIndexEntry } from './Registry.js';
import { searchWorkspace, type SearchResult } from './Search.js';
import type { TaskStore } from './TaskStore.js';
import type { Task, TaskStatus } from './types.js';

/**
 * Orchestration on top of `Registry.ts` + `workspace.ts`: turns the raw
 * cross-workspace index into the operations the CLI/MCP server/chat
 * participant actually need — "list every task I have anywhere,"
 * "search every workspace I've ever used," and "resolve this task id
 * regardless of which workspace I'm currently sitting in." Kept in its own
 * module (rather than folded into `Registry.ts`) so `Registry.ts` itself
 * stays a small, dependency-free index (no `TaskStore`/`Search` imports),
 * easy to reason about and test in isolation.
 */

export interface CrossWorkspaceTask extends TaskIndexEntry {}

/**
 * Lists every known task across every known workspace, straight from the
 * registry (no per-workspace db opens) — fast, but the data can be as
 * stale as the last time each workspace's store was opened or mutated
 * (in practice: recent, since every surface syncs on open/mutation — see
 * `TaskStore.ts` and `openWorkspaceStore` in `workspace.ts`).
 */
export function listTasksAcrossWorkspaces(filter?: { status?: TaskStatus }): CrossWorkspaceTask[] {
  return listAllTasks(openRegistry(), filter);
}

/** Lists every workspace root Ariadne has ever seen, most recently used first. */
export function listKnownWorkspaces(): Array<{ root: string; lastSeenAt: string }> {
  return listWorkspaces(openRegistry());
}

export interface CrossWorkspaceSearchResult extends SearchResult {
  workspaceRoot: string;
}

export interface CrossWorkspaceSearchOptions {
  limit?: number;
  maxMatchesPerTask?: number;
  /** Cap on how many tasks to return across ALL workspaces combined (applied after merging). Default 20. */
  totalLimit?: number;
}

/**
 * Searches every known workspace's real store (not just registry metadata),
 * so this reuses the full cross-entity `searchWorkspace()` — checkpoints,
 * decisions, todos, errors, open questions, files, commits, not just titles.
 * Opens and closes a short-lived `TaskStore` per known workspace; at
 * solo-dev scale (a handful to dozens of workspaces) this is cheap enough
 * to do synchronously on every call rather than needing to cache anything.
 * A workspace whose store fails to open (e.g. deleted from disk since it
 * was last seen) is skipped rather than failing the whole search.
 */
export function searchAcrossWorkspaces(
  query: string,
  options: CrossWorkspaceSearchOptions = {},
): CrossWorkspaceSearchResult[] {
  const registryDb = openRegistry();
  const workspaces = listWorkspaces(registryDb);
  const totalLimit = options.totalLimit ?? 20;

  const results: CrossWorkspaceSearchResult[] = [];
  for (const { root } of workspaces) {
    let store: TaskStore | undefined;
    try {
      store = openWorkspaceStore(root);
      const matches = searchWorkspace(store, query, {
        limit: options.limit,
        maxMatchesPerTask: options.maxMatchesPerTask,
      });
      for (const match of matches) {
        results.push({ ...match, workspaceRoot: root });
      }
    } catch {
      // Skip workspaces that no longer exist / can't be opened — cross-
      // workspace search is best-effort discovery, not a guarantee.
    } finally {
      store?.close();
    }
  }

  // Re-rank the merged set the same way searchWorkspace ranks within one
  // workspace: most matches first, then most recently touched.
  results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length;
    const aLatest = a.matches[0]?.createdAt ?? '';
    const bLatest = b.matches[0]?.createdAt ?? '';
    return bLatest.localeCompare(aLatest);
  });

  return results.slice(0, totalLimit);
}

export interface ResolvedTask {
  task: Task;
  workspaceRoot: string;
  store: TaskStore;
  /** Whether this task was found in the workspace the caller was already in, or a different one discovered via the registry. */
  fromCurrentWorkspace: boolean;
}

/**
 * Resolves an explicit task id to the store that owns it, trying the
 * current workspace first and falling back to the global registry to find
 * (and transparently open) whichever other workspace actually has it. This
 * is what lets `ariadne status --task <id>` (or the equivalent MCP tool /
 * chat command) work on a task from a different workspace without the
 * caller needing to `cd` there first.
 *
 * Returns `undefined` if the task isn't found anywhere Ariadne knows about.
 * Callers own the returned store's lifetime and must `close()` it — note
 * that when `fromCurrentWorkspace` is true, this is a *new* store handle
 * on the same current-workspace db, not the caller's existing one, so it's
 * always safe (and required) to close it.
 */
export function resolveTaskAnyWorkspace(taskId: string, currentWorkspaceRoot: string): ResolvedTask | undefined {
  const currentStore = openWorkspaceStore(currentWorkspaceRoot);
  const currentTask = currentStore.getTask(taskId);
  if (currentTask) {
    return { task: currentTask, workspaceRoot: currentWorkspaceRoot, store: currentStore, fromCurrentWorkspace: true };
  }
  currentStore.close();

  const otherRoot = findTaskWorkspace(openRegistry(), taskId);
  if (!otherRoot || otherRoot === currentWorkspaceRoot) return undefined;

  try {
    const otherStore = openWorkspaceStore(otherRoot);
    const task = otherStore.getTask(taskId);
    if (!task) {
      otherStore.close();
      return undefined;
    }
    return { task, workspaceRoot: otherRoot, store: otherStore, fromCurrentWorkspace: false };
  } catch {
    return undefined;
  }
}
