/**
 * Thin HTTP client for the sync server's REST API, per
 * docs/07-CLOUD-SYNC-API-CONTRACT.md. Deliberately minimal (no retry/queue
 * logic) — Phase 1 CLI wiring is meant to prove the round trip, not be a
 * full offline-sync engine. Uses Node's built-in `fetch` (global since
 * Node 18) rather than adding an HTTP client dependency.
 */

export class SyncApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncApiError';
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SyncApiError(0, 'network_error', `Could not reach sync server at ${url}: ${message}`);
  }
  const body = await res.json().catch(() => undefined);
  if (!res.ok) {
    const code = body?.error?.code ?? 'unknown_error';
    const message = body?.error?.message ?? `Request to ${url} failed with status ${res.status}`;
    throw new SyncApiError(res.status, code, message);
  }
  return body as T;
}

export interface RemoteTask {
  remoteId: string;
  title: string;
  workspaceLabel?: string | null;
  goal: string | null;
  status: 'active' | 'paused' | 'done' | 'archived';
  branch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteCheckpoint {
  remoteId: string;
  level: 'micro' | 'session' | 'milestone';
  summary: string;
  createdAt: string;
}

export interface PushTaskInput {
  localId: string;
  remoteId: string | null;
  title: string;
  goal: string | null;
  status: string;
  branch: string | null;
  workspaceLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushCheckpointInput {
  localId: string;
  remoteTaskId: string;
  level: string;
  summary: string;
  createdAt: string;
}

export function register(serverUrl: string, username: string, password: string) {
  return request<{ userId: string; username: string }>(`${serverUrl}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

export function login(serverUrl: string, username: string, password: string) {
  return request<{ token: string; userId: string; username: string }>(`${serverUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export function pushTasks(serverUrl: string, token: string, tasks: PushTaskInput[]) {
  return request<{ results: { localId: string; remoteId: string; updatedAt: string }[] }>(
    `${serverUrl}/api/v1/sync/tasks`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ tasks }) },
  );
}

export function pullTasks(serverUrl: string, token: string, since?: string) {
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  return request<{ tasks: RemoteTask[]; serverTime: string }>(`${serverUrl}/api/v1/sync/tasks${query}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

export interface RemoteTaskWithOwner extends RemoteTask {
  owner: string;
}

/**
 * Browse-only listing of every task on the server (not just ones this
 * workspace has linked) — backs `ariadne sync list-remote`. See
 * GET /api/v1/sync/tasks/all in docs/07-CLOUD-SYNC-API-CONTRACT.md.
 */
export function listAllRemoteTasks(serverUrl: string, token: string) {
  return request<{ tasks: RemoteTaskWithOwner[] }>(`${serverUrl}/api/v1/sync/tasks/all`, {
    method: 'GET',
    headers: authHeaders(token),
  });
}

export function pushCheckpoints(serverUrl: string, token: string, checkpoints: PushCheckpointInput[]) {
  return request<{ results: { localId: string; remoteId: string }[] }>(`${serverUrl}/api/v1/sync/checkpoints`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ checkpoints }),
  });
}

export function pullCheckpoints(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ checkpoints: RemoteCheckpoint[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/checkpoints?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}
