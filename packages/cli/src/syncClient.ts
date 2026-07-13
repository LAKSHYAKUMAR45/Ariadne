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
  workspaceLabel?: string | null;
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
  workspaceLabel: string | null;
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

export interface PullTasksOptions {
  since?: string;
  limit?: number;
  offset?: number;
}

/** One page of `GET /tasks`. `hasMore`/`nextOffset` support paging through large result sets (see docs/07-CLOUD-SYNC-API-CONTRACT.md §4.5). */
export function pullTasks(serverUrl: string, token: string, sinceOrOptions?: string | PullTasksOptions) {
  const opts: PullTasksOptions = typeof sinceOrOptions === 'string' ? { since: sinceOrOptions } : (sinceOrOptions ?? {});
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const query = params.toString() ? `?${params.toString()}` : '';
  return request<{ tasks: RemoteTask[]; serverTime: string; hasMore: boolean; nextOffset: number | null }>(
    `${serverUrl}/api/v1/sync/tasks${query}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

export interface RemoteTaskWithOwner extends RemoteTask {
  owner: string;
}

/**
 * Browse-only listing of every task on the server (not just ones this
 * workspace has linked) — backs `ariadne sync list-remote`. Paginated via
 * `limit`/`offset` (defaults: limit 200, max 500); see GET
 * /api/v1/sync/tasks/all in docs/07-CLOUD-SYNC-API-CONTRACT.md §4.5.
 */
export function listAllRemoteTasks(serverUrl: string, token: string, options: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));
  const query = params.toString() ? `?${params.toString()}` : '';
  return request<{ tasks: RemoteTaskWithOwner[]; hasMore: boolean; nextOffset: number | null }>(
    `${serverUrl}/api/v1/sync/tasks/all${query}`,
    { method: 'GET', headers: authHeaders(token) },
  );
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

// ---------------------------------------------------------------------
// Todos — the one sub-entity type with full bidirectional sync (an
// update-by-remoteId path), mirroring tasks above.
// ---------------------------------------------------------------------

export interface RemoteTodo {
  remoteId: string;
  text: string;
  status: 'pending' | 'done' | 'blocked';
  workspaceLabel?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushTodoInput {
  localId: string;
  remoteId: string | null;
  remoteTaskId: string;
  text: string;
  status: string;
  workspaceLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export function pushTodos(serverUrl: string, token: string, todos: PushTodoInput[]) {
  return request<{ results: { localId: string; remoteId: string; updatedAt: string }[] }>(
    `${serverUrl}/api/v1/sync/todos`,
    { method: 'POST', headers: authHeaders(token), body: JSON.stringify({ todos }) },
  );
}

export function pullTodos(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ todos: RemoteTodo[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/todos?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

// ---------------------------------------------------------------------
// Decisions, errors, open questions, commands — create-once sync,
// mirroring checkpoints above (push is insert-only, pull is a
// since-cursor scan). See docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6.
// ---------------------------------------------------------------------

export interface RemoteDecision {
  remoteId: string;
  text: string;
  rationale: string | null;
  workspaceLabel?: string | null;
  createdAt: string;
}

export interface PushDecisionInput {
  localId: string;
  remoteTaskId: string;
  text: string;
  rationale: string | null;
  workspaceLabel: string | null;
  createdAt: string;
}

export function pushDecisions(serverUrl: string, token: string, decisions: PushDecisionInput[]) {
  return request<{ results: { localId: string; remoteId: string }[] }>(`${serverUrl}/api/v1/sync/decisions`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ decisions }),
  });
}

export function pullDecisions(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ decisions: RemoteDecision[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/decisions?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

export interface RemoteTaskError {
  remoteId: string;
  message: string;
  resolved: boolean;
  resolution: string | null;
  workspaceLabel?: string | null;
  createdAt: string;
}

export interface PushErrorInput {
  localId: string;
  remoteTaskId: string;
  message: string;
  resolved: boolean;
  resolution: string | null;
  workspaceLabel: string | null;
  createdAt: string;
}

export function pushErrors(serverUrl: string, token: string, errors: PushErrorInput[]) {
  return request<{ results: { localId: string; remoteId: string }[] }>(`${serverUrl}/api/v1/sync/errors`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ errors }),
  });
}

export function pullErrors(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ errors: RemoteTaskError[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/errors?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

export interface RemoteOpenQuestion {
  remoteId: string;
  text: string;
  resolved: boolean;
  workspaceLabel?: string | null;
  createdAt: string;
}

export interface PushOpenQuestionInput {
  localId: string;
  remoteTaskId: string;
  text: string;
  resolved: boolean;
  workspaceLabel: string | null;
  createdAt: string;
}

export function pushOpenQuestions(serverUrl: string, token: string, openQuestions: PushOpenQuestionInput[]) {
  return request<{ results: { localId: string; remoteId: string }[] }>(`${serverUrl}/api/v1/sync/open-questions`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ openQuestions }),
  });
}

export function pullOpenQuestions(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ openQuestions: RemoteOpenQuestion[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/open-questions?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}

export interface RemoteCommand {
  remoteId: string;
  cmdRedacted: string;
  exitCode: number | null;
  summary: string | null;
  workspaceLabel?: string | null;
  createdAt: string;
}

export interface PushCommandInput {
  localId: string;
  remoteTaskId: string;
  cmdRedacted: string;
  exitCode: number | null;
  summary: string | null;
  workspaceLabel: string | null;
  createdAt: string;
}

export function pushCommands(serverUrl: string, token: string, commands: PushCommandInput[]) {
  return request<{ results: { localId: string; remoteId: string }[] }>(`${serverUrl}/api/v1/sync/commands`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ commands }),
  });
}

export function pullCommands(serverUrl: string, token: string, taskRemoteId: string, since?: string) {
  const params = new URLSearchParams({ taskRemoteId });
  if (since) params.set('since', since);
  return request<{ commands: RemoteCommand[]; serverTime: string }>(
    `${serverUrl}/api/v1/sync/commands?${params.toString()}`,
    { method: 'GET', headers: authHeaders(token) },
  );
}
