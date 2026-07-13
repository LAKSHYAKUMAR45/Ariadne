# Ariadne — Cloud Sync Server Schema & API Contract

**Status: Phase 0/1 schema + API finalized and implemented; Phase 2
(sub-entity sync) also implemented — see §4.6.** This is the concrete
follow-on to `docs/06-CLOUD-SYNC-DESIGN.md` v0.2 (all product/infra
decisions locked there). This doc defines the actual Postgres schema and
HTTP API for `packages/sync-server`.

## 1. Scope

Implemented:
- User accounts (username/password).
- `tasks` and `checkpoints` sync — push (upload local changes) and pull
  (download remote changes), additive-only (no deletes, per design doc §6).
- `todos`, `decisions`, `errors`, `open_questions`, `commands` sync (§4.6).
  Todos get full bidirectional sync; the other four are create-once
  (mirroring checkpoints) — see §4.6 for the exact limitation.
- Visible conflict detection + a `--on-conflict <remote-wins|local-wins>`
  flag on `ariadne sync pull` for the two bidirectional entity types
  (tasks, todos) — see §6's pull section for the exact behavior.

Out of scope (tracked as follow-up work):
- `files`/`commits` sync — deliberately excluded. These are git/workspace-
  local derived artifacts (already partly covered by `git_sync`), not
  first-class curated text content like todos/decisions/errors/questions.
- Full per-field interactive conflict resolution / CRDT-style merge (the
  design doc's §4.4 "eventual" full vision) — what's implemented instead
  is whole-row conflict detection with a visible warning and a
  remote-wins/local-wins flag, which is deliberately simpler.
- Delete/archive propagation to the server (reaffirmed as an intentional
  scope decision — see §2's notes on additive-only sync).

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
  owner_user_id   UUID REFERENCES users(id), -- who pushed THIS checkpoint (may differ from the task's owner — see §2.1)
  workspace_label TEXT,                      -- which machine/repo pushed THIS checkpoint (see §2.1)
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
  additive-only. There is no `DELETE` endpoint and no `deleted_at` column;
  local archival/deletion never propagates. **Reaffirmed** after
  implementing todos/decisions/errors/open questions/commands sync (§4.6):
  archiving a *task* already syncs fine (`status: 'archived'` is just a
  normal field on the existing upsert), but hard-deleting a sub-entity
  locally (e.g. `ariadne decision delete <id>`) is **not** propagated to
  the server — the remote row is left as-is. Adding delete/tombstone
  propagation was considered and explicitly deferred to keep sync
  additive-only/conflict-free; if this becomes a real need later, revisit
  as its own design doc rather than bolting deletes on ad hoc.
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
- **Checkpoints get the same treatment** (migration `0003`, `checkpoints.
  owner_user_id`/`workspace_label`), but per-checkpoint rather than
  overwritten on the parent task: each checkpoint push records the
  authenticated user and computed `workspaceLabel` *at push time* and never
  changes it afterward, since (unlike a task) a checkpoint is never
  re-pushed/edited once created. This lets a checkpoint pushed by a
  teammate who pulled (but didn't originate) a task be told apart from ones
  pushed by the task's original owner/workspace.

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
- If `remoteId` is set, the server upserts by `id = remoteId` — this part
  of conflict resolution (which row's data wins in Postgres) is still a
  simple whole-row overwrite. The response's `updatedAt` reflects what the
  server now has; the client sets its local `synced_at` to that value.
  The client-side CLI layer now adds a visible-conflict check *before* this
  call: if a local task/todo has unpushed changes (`updated_at >
  synced_at`) that differ from what pull just fetched, `ariadne sync pull`
  logs `⚠ Conflict on <entity> <id>: field "<name>" differs (local=...,
  remote=...)` and then resolves it per `--on-conflict` (`remote-wins` by
  default, or `local-wins` to re-push the local value on the next push).
  This satisfies the design doc's "visible warning, pick a side via flag"
  requirement without building full per-field/CRDT merge.
- `403 Forbidden` is never returned for a task another user owns — per the
  flat-access model, ownership doesn't gate writes; `owner_user_id` is set
  once at creation time only.

**`GET /api/v1/sync/tasks?since=<ISO-8601 timestamp>&limit=<n>&offset=<n>`** — pull
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
  "serverTime": "2026-07-13T10:05:00Z",
  "hasMore": false,
  "nextOffset": null
}
```
- Returns every task with `updated_at > since` (or all tasks if `since` is
  omitted — used for a first-time pull). `serverTime` is what the client
  should store as its next `since` value, not the max `updatedAt` in the
  page, to avoid missing rows written between the query and the response.
  When a pull spans multiple pages (see below), the client stores the
  **last** page's `serverTime`, not the first's.
- **Pagination (§4.5)**: `limit` defaults to 200, clamped to a max of 500;
  `offset` defaults to 0. `hasMore`/`nextOffset` let the caller page
  through results larger than one `limit`. `ariadne sync pull` loops
  internally until `hasMore` is `false`, transparently to the user — no
  new CLI flags were needed for this.
- Note this is the feed `ariadne sync pull` uses — by default it only
  updates tasks the calling workspace has already linked via `remote_id`
  (see design doc §4.6.4); tasks from other workspaces still appear here
  but are skipped client-side unless `--import-new` is passed. When
  `--import-new` is used, the client does **not** rely on this `since`-
  filtered feed to find unlinked tasks — instead it separately calls
  `GET /tasks/all` (§4.2, no `since` filtering) and imports any task not
  yet linked locally (via `TaskStore.insertPulledTask`, using that
  response's `createdAt`/`updatedAt`). This decouples import-new from the
  incremental cursor above, so a task already "seen" (and skipped) by an
  earlier plain `pull` is still found and imported later, however old.

**`GET /api/v1/sync/tasks/all?limit=<n>&offset=<n>`** — browse-only listing
of every task on the server, regardless of whether the caller's workspace
has ever linked it. Backs `ariadne sync list-remote`. No `since` filtering
(always returns tasks ordered newest-updated first) — paginated the same
way as `GET /tasks` (§4.5): `limit`/`offset` query params, `hasMore`/
`nextOffset` in the response. Both `ariadne sync list-remote` and
`--import-new` page through this endpoint internally until exhausted.
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
  ],
  "hasMore": false,
  "nextOffset": null
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
      "workspaceLabel": "laptop1:org/atom",  // optional — see §2.1; recorded from the pushing account/workspace, independent of the task's
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
    { "remoteId": "7b21...", "level": "milestone", "summary": "...", "workspaceLabel": "laptop1:org/atom", "createdAt": "2026-07-13T10:00:00Z" }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

### 4.4 Pagination

`GET /api/v1/sync/tasks` and `GET /api/v1/sync/tasks/all` both accept
`limit`/`offset` query params:
- `limit` — default 200, clamped server-side to a max of 500.
- `offset` — default 0.

Both responses include `hasMore: boolean` and `nextOffset: number | null`
(`null` once exhausted). The server fetches `limit + 1` rows internally to
detect `hasMore` cheaply, without a separate `COUNT(*)` query, then trims
the extra row before returning.

This is purely an internal scalability safeguard for teams/servers with
many tasks — it does not add any new CLI flags. `ariadne sync pull` and
`ariadne sync list-remote` (including the `--import-new` browse pass) loop
through pages automatically until `hasMore` is `false`, accumulating the
full result before acting on it, so behavior is unchanged from the user's
perspective regardless of how many tasks exist on the server.

### 4.6 Sync — todos, decisions, errors, open questions, commands

Extends sync coverage beyond tasks/checkpoints to the rest of a task's
curated content, mirroring the tables in `packages/core/src/schema.ts`.
`files`/`commits` are deliberately **not** included (see §1) — this section
covers only `todos`, `decisions`, `errors`, `open_questions`, `commands`.

**Todos** get full bidirectional sync (like tasks): push is an upsert keyed
on `remoteId` (`null` → insert, present → update), and a local edit made
after the first push (e.g. marking one done) is correctly re-detected and
re-pushed on the next `sync push`, since `todos.updated_at` is bumped on
every mutation and compared against `synced_at`.

**Decisions, errors, open questions, commands** get **create-once** sync,
identical in spirit to checkpoints (§4.3): push is insert-only (no
`remoteId` in the push payload — there's nothing to upsert), and pull is a
`since`-cursor scan by `created_at`. **This is a known, deliberate
limitation**: none of these four have an `updated_at` column, so a local
edit made *after* the initial push — editing a decision's rationale,
resolving an error, resolving an open question, editing a command's summary
— is **not** automatically detected or re-pushed in this phase. The first
push of each row is what reaches the server; later local edits stay local
until a future phase adds per-row update tracking for these four types.

**`POST /api/v1/sync/todos`** — push (upsert by `remoteId`)
```json
// Request
{
  "todos": [
    {
      "localId": "01J...",
      "remoteId": null,                 // null on first push; the server's id on subsequent updates
      "remoteTaskId": "9a3f...",         // must already exist
      "text": "Write tests",
      "status": "pending",               // pending | done | blocked
      "workspaceLabel": "laptop1:org/atom",
      "createdAt": "2026-07-13T10:00:00Z",
      "updatedAt": "2026-07-13T10:00:00Z"
    }
  ]
}
// Response 200
{ "results": [ { "localId": "01J...", "remoteId": "7b21...", "updatedAt": "2026-07-13T10:00:00Z" } ] }
```
- `404 Not Found` (`task_not_found`) if `remoteTaskId` doesn't exist (on a first push).
- `404 Not Found` (`todo_not_found`) if `remoteId` doesn't exist (on an update push).

**`GET /api/v1/sync/todos?taskRemoteId=<id>&since=<ISO-8601>`** — pull, filtered by `updated_at > since`
```json
// Response 200
{
  "todos": [
    { "remoteId": "7b21...", "text": "Write tests", "status": "done", "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

**`POST /api/v1/sync/decisions`** / **`GET /api/v1/sync/decisions?taskRemoteId=<id>&since=<ISO-8601>`**
— same create-only push / since-cursor pull shape as checkpoints, with
fields `text`, `rationale` (nullable).

**`POST /api/v1/sync/errors`** / **`GET /api/v1/sync/errors?taskRemoteId=<id>&since=<ISO-8601>`**
— fields `message`, `resolved` (boolean), `resolution` (nullable). Note:
`resolved`/`resolution` reflect the state *at first push* only, per the
create-once limitation above.

**`POST /api/v1/sync/open-questions`** / **`GET /api/v1/sync/open-questions?taskRemoteId=<id>&since=<ISO-8601>`**
— fields `text`, `resolved` (boolean). Response body key is `openQuestions`.

**`POST /api/v1/sync/commands`** / **`GET /api/v1/sync/commands?taskRemoteId=<id>&since=<ISO-8601>`**
— fields `cmdRedacted`, `exitCode` (nullable int), `summary` (nullable).

All five push endpoints follow checkpoints' attribution model (§2.1):
`owner_user_id` is the pushing account, `workspace_label` is the pushing
workspace, independent of the parent task's own attribution.

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

## 7. Status

Phase 1 (tasks/checkpoints), Phase 2 (todos/decisions/errors/open
questions/commands sync, §4.6), and visible conflict detection with
`--on-conflict` (§6) are all implemented and tested end-to-end
(sync-server routes, CLI push/pull, MCP server + VS Code extension surfaces
that shell out to the CLI). Remaining known gap, tracked as a deliberate
scope decision rather than an oversight: delete/archive propagation (§2)
— sync stays additive-only by design.
