import type { TaskStore } from '@ariadne/core';
import { resolveTaskAnyWorkspace } from '@ariadne/core';
import { findWorkspaceRoot, openWorkspaceStore } from './workspace.js';
import { readCurrentTaskId } from './currentTask.js';

/**
 * Resolves which task to operate on and opens whichever store actually owns
 * it, runs `fn`, then closes that store. Explicit `id` wins; otherwise
 * falls back to this workspace's current task. If the resolved id isn't a
 * task in the current workspace, transparently falls back to the global
 * cross-workspace registry to find and open the actual owning workspace
 * (see `resolveTaskAnyWorkspace` in `@ariadne/core`) — this is what lets
 * e.g. `ariadne status --task <id>` operate on a task from a different
 * workspace without the user needing to `cd` there first.
 */
export function withResolvedTask<T>(
  explicitId: string | undefined,
  fn: (store: TaskStore, taskId: string, workspaceRoot: string) => T,
): T {
  const workspaceRoot = findWorkspaceRoot();
  const id = explicitId ?? readCurrentTaskId(workspaceRoot);
  if (!id) {
    console.error(
      'No task specified and no current task set. Run "ariadne task new <title>" first, or pass --task <id>.',
    );
    process.exit(1);
  }

  const resolved = resolveTaskAnyWorkspace(id, workspaceRoot);
  if (!resolved) {
    console.error(`No task found with id "${id}" in this workspace or any other known workspace.`);
    process.exit(1);
  }
  if (!resolved.fromCurrentWorkspace) {
    console.error(`(Task ${id} belongs to a different workspace — ${resolved.workspaceRoot} — operating on it there.)`);
  }
  try {
    return fn(resolved.store, id, resolved.workspaceRoot);
  } finally {
    resolved.store.close();
  }
}

/**
 * Opens whichever store owns a sub-entity mutation (`todo done <id>`,
 * `error resolve <id>`, `question resolve <id>`) given an optional
 * `--task <taskId>` hint. The cross-workspace registry only indexes task
 * ids, not sub-entity ids, so a bare todo/error/question id belonging to
 * another workspace can't be resolved on its own — the hint tells us which
 * task (and therefore which workspace) to open first. Without a hint,
 * operates against the current workspace's store, unchanged from before.
 */
export function withScopedStore<T>(taskIdHint: string | undefined, fn: (store: TaskStore) => T): T {
  if (!taskIdHint) {
    const workspaceRoot = findWorkspaceRoot();
    const store = openWorkspaceStore(workspaceRoot);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  }
  return withResolvedTask(taskIdHint, (store) => fn(store));
}
