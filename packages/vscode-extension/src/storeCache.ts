import { TaskStore, openWorkspaceStore } from '@ariadne-dev/core';

/**
 * Caches one TaskStore (i.e. one open SQLite connection) per workspace root
 * for the extension's lifetime, instead of opening/closing a connection on
 * every single command or chat turn. WAL mode (enabled in @ariadne-dev/core's
 * openDatabase()) makes this safe to hold open alongside the CLI and/or an
 * MCP server process writing to the same `.ariadne/state.db` concurrently —
 * SQLite's own file locking arbitrates cross-process writes regardless of
 * how long any one process holds its connection open.
 */
const cache = new Map<string, TaskStore>();

export function getOrOpenStore(workspaceRoot: string): TaskStore {
  const existing = cache.get(workspaceRoot);
  if (existing) return existing;
  const store = openWorkspaceStore(workspaceRoot);
  cache.set(workspaceRoot, store);
  return store;
}

/** Closes and evicts the cached store for one workspace root, if any (e.g. when a folder is removed from the workspace). */
export function closeStore(workspaceRoot: string): void {
  const existing = cache.get(workspaceRoot);
  if (!existing) return;
  existing.close();
  cache.delete(workspaceRoot);
}

/** Closes every cached store. Called from deactivate(). */
export function closeAllStores(): void {
  for (const store of cache.values()) store.close();
  cache.clear();
}

/** Iterates every currently-open (root, store) pair — used by idle-checkpoint polling. */
export function listOpenStores(): IterableIterator<[string, TaskStore]> {
  return cache.entries();
}
