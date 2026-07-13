# Ariadne — Cloud Sync Server Schema & API Contract (Phase 0)

**Status: Phase 0 output — schema + API contract finalized, implementation
starting.** This is the concrete follow-on to `docs/06-CLOUD-SYNC-DESIGN.md`
v0.2 (all product/infra decisions locked there). This doc defines the actual
Postgres schema and HTTP API for `packages/sync-server`, scoped to **Phase 1**
of that design's phasing: read/write sync for `tasks` and `checkpoints` only
(todos/decisions/open_questions/commands/files follow once the round trip is
proven, per §5.2 of the design doc).

## 1. Scope of this phase

In scope (Phase 1):
- User accounts (username/password).
- `tasks` and `checkpoints` sync — push (upload local changes) and pull
  (download remote changes), additive-only (no deletes, per design doc §6).

Out of scope for this phase (tracked as follow-up todos):
- `todos`, `decisions`, `open_questions`, `commands`, `files` sync (Phase 2).
- Conflict-resolution UI beyond a simple "remote wins" default (Phase 2 adds
  real last-write-wins-by-field with a reported conflict, per design doc §4.4).
- Any client-side CLI/MCP/VS Code wiring beyond a minimal `ariadne sync
  push`/`ariadne sync pull` (tracked separately; this doc is server-only).

## 2. Postgres schema

```sql
-- Users: username/password auth, per design doc §6 ("Auth model").
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, -- bcrypt
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tasks: mirrors packages/core/src/schema.ts's `tasks` table, plus
-- server-only bookkeeping (owner, updated_at for conflict/sync-window
-- queries). No FK to a "team" — per design doc §6, access is flat: any
-- authenticated user can read/write any task once it's on the server.
CREATE TABLE tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- becomes the local task's `remote_id`
  local_id       TEXT NOT NULL,      -- the originating workspace's local task id (ULID), for traceability
  owner_user_id  UUID NOT NULL REFERENCES users(id),
  title          TEXT NOT NULL,
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active|paused|done|archived
  branch         TEXT,
  workspace_label TEXT,               -- e.g. "laptop1:org/atom" — which machine/repo last pushed this (see §2.1)
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL             -- bumped on every field change; drives pull's "changed since" query
);
CREATE INDEX idx_tasks_updated_at ON tasks(updated_at);

-- Checkpoints: mirrors packages/core/src/schema.ts's `checkpoints` table.
CREATE TABLE checkpoints (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- becomes the local checkpoint's `remote_id`
  local_id   TEXT NOT NULL,
  task_id    UUID NOT NULL REFERENCES tasks(id),
  level      TEXT NOT NULL, -- micro|session|milestone
  summary    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_checkpoints_task_created ON checkpoints(task_id, created_at);
CREATE INDEX idx_checkpoints_created_at ON checkpoints(created_at); -- drives pull's "changed since" query

-- Schema version bookkeeping, mirroring the client's schema_meta table.
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');
```

Notes:
- **No delete semantics anywhere** — per design doc §4.6/§6, the server is
  additive-only in v1. There is no `DELETE` endpoint and no `deleted_at`
  column; local archival/deletion never propagates.
- **No team/ACL table** — per design doc §6's flat-access decision, any row
  is readable/writable by any authenticated user. `owner_user_id` on `tasks`
  is bookkeeping (who created it), not an access-control gate.
- `local_id` + `owner_user_id`/`task_id` let the server stay a plain mirror
  of client data without needing to understand workspace-local ULIDs as
  primary keys — the server mints its own UUIDs, which the client then
  stores back into its local `remote_id` column (§4 below).

### 2.1 Workspace attribution (`workspace_label`)

`owner_user_id` only identifies *who* pushed a task, not *which
repo/workspace/machine* it came from — two tasks pushed by the same user
from two different repos are otherwise indistinguishable server-side. Every
push (`POST /api/v1/sync/tasks`) therefore includes a client-computed
`workspaceLabel` string, stored verbatim in `tasks.workspace_label` and
returned by both pull endpoints (§4.2, §4.4):

- Computed as `${hostname}:${repoShorthand}` (e.g. `laptop1:org/atom`),
  where `repoShorthand` is derived from `git remote get-url origin` when
  available (`org/repo`, stripped of protocol/`.git`), falling back to the
  workspace folder's basename if it isn't a git repo or has no `origin`
  remote. See `packages/cli/src/workspaceLabel.ts`.
- Recomputed fresh on every push (not cached) — cheap, and stays accurate
  even if a workspace is renamed or its remote changes.
- Overwritten (not merged) on re-push, so it always reflects the most
  recent workspace to push that task, not just its origin.
- Optional/nullable — omitting it (or pushing from an older client) simply
  leaves it `null`; nothing else depends on it being present.

## 3. Client-side schema addition (packages/core)

Per design doc §4.1, add nullable columns to the existing `tasks` table
(`packages/core/src/schema.ts`), via a new migration in
`packages/core/src/migrations.ts`:

```sql
ALTER TABLE tasks ADD COLUMN remote_id  TEXT;
ALTER TABLE tasks ADD COLUMN synced_at  TEXT;
```

Same pattern for `checkpoints` (`remote_id`, `synced_at`) once Phase 1 lands.
An un-synced task/checkpoint simply has `remote_id IS NULL` and behaves
exactly as today — no behavior change for anyone who never runs `ariadne
sync push`.

## 4. HTTP API

Base path: `/api/v1`. All request/response bodies are JSON. All endpoints
except `/auth/register` and `/auth/login` require `Authorization: Bearer
<token>`.

### 4.1 Auth

**`POST /api/v1/auth/register`**
```json
// Request
{ "username": "alice", "password": "hunter2" }
// Response 201
{ "userId": "1f9c...", "username": "alice" }
```
- `409 Conflict` if the username is already taken.
- Password is hashed with bcrypt (cost factor 12) before storage; never
  logged or returned.

**`POST /api/v1/auth/login`**
```json
// Request
{ "username": "alice", "password": "hunter2" }
// Response 200
{ "token": "<JWT>", "userId": "1f9c...", "username": "alice" }
```
- `401 Unauthorized` on bad credentials.
- Token is a JWT (HS256, server-side secret from `SYNC_SERVER_JWT_SECRET`
  env var), containing `{ sub: userId, username }`, expiring after 30 days
  (internal-use tool — long-lived tokens are an acceptable tradeoff here;
  revisit if this is ever exposed beyond the current trusted deployment).

### 4.2 Sync — tasks

**`POST /api/v1/sync/tasks`** — push (create or update)
```json
// Request: array of tasks changed locally since last sync
{
  "tasks": [
    {
      "localId": "01J...",       // the workspace's local ULID
      "remoteId": null,           // null on first push, else the previously-assigned remote id
      "title": "Fix login bug",
      "goal": "...",
      "status": "active",
      "branch": "main",
      "workspaceLabel": "laptop1:org/atom",  // optional — see §2.1
      "createdAt": "2026-07-01T12:00:00Z",
      "updatedAt": "2026-07-13T10:00:00Z"
    }
  ]
}
// Response 200
{
  "results": [
    { "localId": "01J...", "remoteId": "9a3f...", "updatedAt": "2026-07-13T10:00:05Z" }
  ]
}
```
- If `remoteId` is `null`, the server inserts a new row and returns a fresh
  UUID — the client persists this into its local `remote_id` column.
- If `remoteId` is set, the server upserts by `id = remoteId`. Phase 1 uses
  **remote-wins on conflict** (the simplest possible rule, explicitly
  weaker than the design doc's eventual last-write-wins-by-field — that's
  Phase 2 scope). The response's `updatedAt` reflects what the server now
  has; the client sets its local `synced_at` to that value.
- `403 Forbidden` is never returned for a task another user owns — per the
  flat-access model, ownership doesn't gate writes; `owner_user_id` is set
  once at creation time only.

**`GET /api/v1/sync/tasks?since=<ISO-8601 timestamp>`** — pull
```json
// Response 200
{
  "tasks": [
    {
      "remoteId": "9a3f...",
      "title": "Fix login bug",
      "goal": "...",
      "status": "active",
      "branch": "main",
      "workspaceLabel": "laptop1:org/atom",
      "createdAt": "2026-07-01T12:00:00Z",
      "updatedAt": "2026-07-13T10:00:05Z"
    }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```
- Returns every task with `updated_at > since` (or all tasks if `since` is
  omitted — used for a first-time pull). `serverTime` is what the client
  should store as its next `since` value, not the max `updatedAt` in the
  page, to avoid missing rows written between the query and the response.
- Note this is the feed `ariadne sync pull` uses — by default it only
  updates tasks the calling workspace has already linked via `remote_id`
  (see design doc §4.6.4); tasks from other workspaces still appear here
  but are skipped client-side unless `--import-new` is passed. When
  `--import-new` is used, the client does **not** rely on this `since`-
  filtered feed to find unlinked tasks — instead it separately calls
  `GET /tasks/all` (§4.4, no `since` filtering) and imports any task not
  yet linked locally (via `TaskStore.insertPulledTask`, using that
  response's `createdAt`/`updatedAt`). This decouples import-new from the
  incremental cursor above, so a task already "seen" (and skipped) by an
  earlier plain `pull` is still found and imported later, however old.

**`GET /api/v1/sync/tasks/all`** — browse-only listing of every task on the
server, regardless of whether the caller's workspace has ever linked it.
Backs `ariadne sync list-remote`. No `since` filtering (always returns the
full set, newest-updated first) — this is a small-scale browsing endpoint,
not the incremental sync feed.
```json
// Response 200
{
  "tasks": [
    {
      "remoteId": "9a3f...",
      "title": "Fix login bug",
      "goal": "...",
      "status": "active",
      "branch": "main",
      "workspaceLabel": "laptop1:org/atom",
      "owner": "alice",
      "createdAt": "2026-07-01T12:00:00Z",
      "updatedAt": "2026-07-13T10:00:05Z"
    }
  ]
}
```

### 4.3 Sync — checkpoints

**`POST /api/v1/sync/checkpoints`** — push (create-only; checkpoints are
immutable once written, matching the local schema's append-only design)
```json
// Request
{
  "checkpoints": [
    {
      "localId": "01J...",
      "remoteTaskId": "9a3f...",  // the task's remote id — must already exist
      "level": "milestone",
      "summary": "...",
      "createdAt": "2026-07-13T10:00:00Z"
    }
  ]
}
// Response 200
{ "results": [ { "localId": "01J...", "remoteId": "7b21..." } ] }
```
- `404 Not Found` if `remoteTaskId` doesn't exist on the server (client must
  push the parent task first).
- No update/upsert case — checkpoints are write-once.

**`GET /api/v1/sync/checkpoints?taskRemoteId=<id>&since=<ISO-8601>`** — pull
```json
// Response 200
{
  "checkpoints": [
    { "remoteId": "7b21...", "level": "milestone", "summary": "...", "createdAt": "2026-07-13T10:00:00Z" }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

## 5. Error format

All error responses share one shape:
```json
{ "error": { "code": "invalid_credentials", "message": "..." } }
```
Standard HTTP status codes apply (400/401/403/404/409/500); `code` is a
stable machine-readable string for client branching, `message` is
human-readable.

## 6. Non-functional notes

- **Transport**: plain HTTPS (TLS termination assumed to be handled by
  whatever reverse proxy fronts the server in the internal deployment — out
  of scope for this doc).
- **Rate limiting / abuse protection**: none in Phase 1 — acceptable given
  the internal-only, trusted-user deployment (design doc §6).
- **Migrations**: plain versioned `.sql` files under
  `packages/sync-server/migrations/`, applied via a small runner script
  (mirrors `packages/core/src/migrations.ts`'s pattern of a numbered
  `schema_meta.schema_version`) rather than a full migration framework —
  consistent with the rest of this project's preference for minimal
  dependencies.
- **Testing**: integration tests run against a real (test-only) Postgres
  instance — see `packages/sync-server/README.md` once written for how to
  point tests at one locally / in CI.

## 7. Next steps after this doc

1. Scaffold `packages/sync-server` (Express + `pg`), migrations runner,
   config loading (`DATABASE_URL`, `SYNC_SERVER_JWT_SECRET`, `PORT`).
2. Implement `/auth/register` and `/auth/login`.
3. Implement `/sync/tasks` push + pull.
4. Implement `/sync/checkpoints` push + pull.
5. Add the `remote_id`/`synced_at` columns to `packages/core` (§3) — needed
   before any client (CLI `ariadne sync push`/`pull`) can be built.
6. Add a test suite for all of the above.
7. Only then: wire a client (`ariadne sync push`/`pull` CLI commands).
