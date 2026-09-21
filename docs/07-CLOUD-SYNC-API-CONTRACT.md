# Ariadne — Cloud Sync Server Schema & API Contract

**Status: Phase 0/1 schema + API finalized and implemented for the
singleton-team model; Phase 2 (sub-entity sync) is also implemented, and the
former create-once limitation for decisions/errors/open_questions/commands is
now closed — see §4.6.** The bearer-authenticated `/api/v1/admin/*` surface
is temporary and will be replaced by browser-session auth in the later
dashboard rollout. This is the concrete follow-on to
`docs/06-CLOUD-SYNC-DESIGN.md` v0.2 (all product/infra decisions locked
there). This doc defines the actual Postgres schema and HTTP API for
`packages/sync-server`.

## 1. Scope

Implemented:
- User accounts and singleton-team membership (first registration becomes
  admin; later registrations join the same team as active members).
- `tasks` and `checkpoints` sync — push (upload local changes) and pull
  (download remote changes), additive-only (no deletes, per design doc §6).
- `todos`, `decisions`, `errors`, `open_questions`, `commands` sync (§4.6).
  All five now get full bidirectional sync (`remoteId` upsert on push,
  `updated_at`-driven pull cursors, and visible pull-time conflict
  detection for linked rows) — see §4.6.
- Visible conflict detection + a `--on-conflict <remote-wins|local-wins>`
  flag on `ariadne sync pull` for every bidirectional entity type
  (tasks, todos, decisions, errors, open questions, commands) — see §6's
  pull section for the exact behavior.
- Active-membership enforcement on every protected sync route, with
  inaccessible task IDs hidden behind `404 Not Found`.

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

-- Singleton-team authorization: one team per server, with the oldest
-- existing user (by created_at, id) backfilled as the initial admin and all
-- other existing users backfilled as active members. The `singleton_key`
-- column is the invariant: only the `default` row is permitted.
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton_key TEXT NOT NULL UNIQUE CHECK (singleton_key = 'default'),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE team_memberships (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE UNIQUE INDEX idx_team_memberships_single_admin
  ON team_memberships(team_id)
  WHERE role = 'admin';
CREATE INDEX idx_team_memberships_user_active ON team_memberships(user_id, active);

-- Tasks: mirrors packages/core/src/schema.ts's `tasks` table, plus
-- server-only bookkeeping (owner, team, updated_at for conflict/sync-window
-- queries). Every task belongs to the singleton team; `owner_user_id`
-- records who created/pushed it, not who can access it.
CREATE TABLE tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- becomes the local task's `remote_id`
  local_id       TEXT NOT NULL,      -- the originating workspace's local task id (ULID), for traceability
  owner_user_id  UUID NOT NULL REFERENCES users(id),
  team_id        UUID NOT NULL REFERENCES teams(id),
  title          TEXT NOT NULL,
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active|paused|done|archived
  branch         TEXT,
  workspace_label TEXT,               -- e.g. "laptop1:org/atom" — which machine/repo last pushed this (see §2.1)
  created_at     TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL             -- bumped on every field change; drives pull's "changed since" query
);
CREATE INDEX idx_tasks_updated_at ON tasks(updated_at);
CREATE INDEX idx_tasks_team_updated ON tasks(team_id, updated_at);

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

-- Todos / decisions / errors / open questions / commands: all syncable,
-- all additive-only, and all now track updated_at so post-create edits can
-- be re-pushed and re-pulled just like tasks/todos.
CREATE TABLE todos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_todos_task_updated ON todos(task_id, updated_at);

CREATE TABLE decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  rationale       TEXT,
  supersedes_id   UUID,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_decisions_task_updated ON decisions(task_id, updated_at);

CREATE TABLE errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  message         TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolution      TEXT,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_errors_task_updated ON errors(task_id, updated_at);

CREATE TABLE open_questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  text            TEXT NOT NULL,
  resolved        BOOLEAN NOT NULL DEFAULT false,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_open_questions_task_updated ON open_questions(task_id, updated_at);

CREATE TABLE commands (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id        TEXT NOT NULL,
  task_id         UUID NOT NULL REFERENCES tasks(id),
  cmd_redacted    TEXT NOT NULL,
  exit_code       INTEGER,
  summary         TEXT,
  owner_user_id   UUID REFERENCES users(id),
  workspace_label TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_commands_task_updated ON commands(task_id, updated_at);

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
- **Singleton-team authorization** — this release keeps one team per
  server, not per-user ACLs or cross-team flat access. Protected queries
  must scope through `tasks.team_id` / `team_memberships`; `owner_user_id`
  on `tasks` is provenance only, not an authorization boundary.
- `local_id` + `owner_user_id`/`task_id`/`team_id` let the server stay a
  plain mirror of client data without needing to understand workspace-local
  ULIDs as primary keys — the server mints its own UUIDs, which the client
  then stores back into its local `remote_id` column (§4 below).

### 2.1 Workspace attribution (`workspace_label`)

`owner_user_id` only identifies *who* pushed a task, not *which
repo/workspace/machine* it came from — two tasks pushed by the same user
from two different repos are otherwise indistinguishable server-side.
`team_id` identifies which singleton team the task belongs to; every
protected task query must scope through that column and verify the caller's
membership. Every push (`POST /api/v1/sync/tasks`) therefore includes a
client-computed `workspaceLabel` string, stored verbatim in
`tasks.workspace_label` and returned by both pull endpoints (§4.2, §4.4):

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
{ "userId": "1f9c...", "username": "alice", "role": "admin" }
```
- `409 Conflict` if the username is already taken.
- Password is hashed with bcrypt (cost factor 12) before storage; never
  logged or returned.
- The first successful registration becomes the singleton team's `admin`;
  later registrations join the same team as `member`.
- Registration is intentionally open for the internal deployment, but the
  server is expected to be reached through the project SSH tunnel or another
  secured transport, not exposed directly to the public internet.

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

**`GET /api/v1/admin/members`** / **`PATCH /api/v1/admin/members/:userId`**
— temporary bearer-authenticated singleton-admin member management
- Requires the same bearer JWT as the sync routes plus an active admin
  membership.
- `GET` lists the singleton team's members with `role` and `active` state.
- `PATCH` toggles `active` for non-admin members only.
- `403 Forbidden` if the caller is not the active singleton admin.
- `404 Not Found` if the target user is not a member of the singleton team.
- `409 Conflict` (`admin_immutable`) if the target is the singleton admin;
  the network API cannot promote, demote, or deactivate that account.
- This surface is temporary; the dashboard rollout will replace it with
  browser-session auth before production deployment.

### 4.2 Sync — tasks

**`POST /api/v1/sync/tasks`** — push (create or update)
The caller must be an active member of the singleton team. Tasks are shared
within that team only; there is no per-task ACL.
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
- `404 Not Found` if `remoteId` points at a task outside the caller's active
  team or the task does not exist. The API intentionally hides inaccessible
  resources rather than confirming cross-team existence.

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
- Only tasks in the caller's active team are included.
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
has ever linked it. Backs `ariadne sync list-remote`. The endpoint is still
restricted to the caller's active team; it is browse-only within that team,
not a cross-team leak. No `since` filtering.
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
  push the parent task first). The same 404 applies if the task exists but is
  outside the caller's active team.
- No update/upsert case — checkpoints are write-once.

**`GET /api/v1/sync/checkpoints?taskRemoteId=<id>&since=<ISO-8601>`** — pull
Only checkpoints for tasks visible to the caller's active team are returned.
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

**Todos, decisions, errors, open questions, and commands** all now get the
same full bidirectional sync shape: push is an upsert keyed on `remoteId`
(`null` → insert, present → update), and a local edit made after the first
push is correctly re-detected and re-pushed on the next `sync push`, since
each table now tracks `updated_at` and the client compares it against
`synced_at`. Pull uses `updated_at > since`, and the CLI applies the same
visible conflict reporting / `--on-conflict <remote-wins|local-wins>`
behavior for these rows that tasks/todos already used.

**`POST /api/v1/sync/todos`** — push (upsert by `remoteId`)
The same active-team scoping and 404-hiding rules apply to every sub-entity
endpoint below.
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
- `404 Not Found` if the task exists but is outside the caller's active
  team.

**`GET /api/v1/sync/todos?taskRemoteId=<id>&since=<ISO-8601>`** — pull, filtered by `updated_at > since`
The caller only sees rows for tasks in the active team.
```json
// Response 200
{
  "todos": [
    { "remoteId": "7b21...", "text": "Write tests", "status": "done", "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

**`POST /api/v1/sync/decisions`** — push (upsert by `remoteId`)
```json
{
  "decisions": [
    {
      "localId": "01J...",
      "remoteId": null,
      "remoteTaskId": "9a3f...",
      "text": "Use Postgres",
      "rationale": "Shared remote state",
      "supersedesId": null,
      "workspaceLabel": "laptop1:org/atom",
      "createdAt": "2026-07-13T10:00:00Z",
      "updatedAt": "2026-07-13T10:00:00Z"
    }
  ]
}
```
```json
{ "results": [ { "localId": "01J...", "remoteId": "7b21...", "updatedAt": "2026-07-13T10:00:00Z" } ] }
```

**`GET /api/v1/sync/decisions?taskRemoteId=<id>&since=<ISO-8601>`**
The caller only sees decisions for tasks in the active team.
```json
{
  "decisions": [
    {
      "remoteId": "7b21...",
      "text": "Use Postgres",
      "rationale": "Shared remote state",
      "supersedesId": null,
      "workspaceLabel": "laptop1:org/atom",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

**`POST /api/v1/sync/errors`** / **`GET /api/v1/sync/errors?taskRemoteId=<id>&since=<ISO-8601>`**
The caller only sees errors for tasks in the active team.
```json
{
  "errors": [
    {
      "localId": "01J...",
      "remoteId": "7b22...",
      "remoteTaskId": "9a3f...",
      "message": "TypeError",
      "resolved": true,
      "resolution": "Added guard",
      "workspaceLabel": "laptop1:org/atom",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```
```json
{
  "errors": [
    { "remoteId": "7b22...", "message": "TypeError", "resolved": true, "resolution": "Added guard", "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

**`POST /api/v1/sync/open-questions`** / **`GET /api/v1/sync/open-questions?taskRemoteId=<id>&since=<ISO-8601>`**
The caller only sees open questions for tasks in the active team.
```json
{
  "openQuestions": [
    { "localId": "01J...", "remoteId": null, "remoteTaskId": "9a3f...", "text": "Which SQL engine?", "resolved": false, "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ]
}
```
```json
{
  "openQuestions": [
    { "remoteId": "7b23...", "text": "Which SQL engine?", "resolved": false, "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

**`POST /api/v1/sync/commands`** / **`GET /api/v1/sync/commands?taskRemoteId=<id>&since=<ISO-8601>`**
The caller only sees commands for tasks in the active team.
```json
{
  "commands": [
    { "localId": "01J...", "remoteId": "7b24...", "remoteTaskId": "9a3f...", "cmdRedacted": "pnpm test", "exitCode": 0, "summary": "passed", "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ]
}
```
```json
{
  "commands": [
    { "remoteId": "7b24...", "cmdRedacted": "pnpm test", "exitCode": 0, "summary": "passed", "workspaceLabel": "laptop1:org/atom", "createdAt": "...", "updatedAt": "..." }
  ],
  "serverTime": "2026-07-13T10:05:00Z"
}
```

All five push endpoints follow checkpoints' attribution model (§2.1):
`owner_user_id` is the pushing account, `workspace_label` is the pushing
workspace, independent of the parent task's own attribution.

### 4.7 Sync — task file captures (encrypted history)

**`POST /api/v1/sync/tasks/:taskId/file-captures`** — upload one capture

`:taskId` is the task's **remote** id (a UUID). Exactly one capture is
uploaded per request: batching would multiply the 10 MiB per-capture cap and
make partial failures ambiguous, so each capture is its own retryable unit.
The body is plain UTF-8 JSON — never multipart, and the CLI never stages
plaintext through a temporary file.

```json
// Request
{
  "capture": {
    "captureId": "01J...",            // the local capture id; also the idempotency key
    "trigger": "git_commit",           // git_commit | checkpoint | explicit
    "gitCommitSha": "abcdef1234567",  // required for git_commit, else null
    "checkpointId": null,              // required for checkpoint, else null
    "createdAt": "2026-09-21T04:00:00.000Z",
    "entries": [
      {
        "path": "src/a.ts",           // normalized, workspace-relative POSIX path
        "content": "export const a = 1;\n",
        "unifiedDiff": "@@ -0,0 +1 @@\n+export const a = 1;\n",
        "contentSha256": "<64 lowercase hex>",
        "byteLength": 20               // UTF-8 byte length of `content`
      }
    ]
  }
}
// Response 200
{ "captureId": "01J...", "status": "stored", "entryCount": 1 }
```

- `status` is `"stored"` on first write and `"duplicate"` when an identical
  capture is replayed, so a client retry after a lost response is safe.
- Authorization: an **active team membership** plus access to the referenced
  team task. A deactivated caller gets `403 inactive_membership` *before* any
  body validation; a task outside the caller's team is `404 task_not_found`.
- Every guard is re-checked server-side, never trusted from the client:
  - `400 invalid_capture_encoding` — request bytes are not valid UTF-8, or a
    decoded string contains lone surrogates.
  - `400 invalid_request` — `:taskId` is not a UUID, or the body shape is wrong.
  - `400 invalid_capture` — non-normalized/absolute/traversal path, duplicate
    path, `contentSha256` mismatch, or `byteLength` mismatch.
  - `413 capture_too_large` — an entry over 1 MiB, a capture over 10 MiB of
    snapshot (or diff) text, or a request body over the route's own 32 MiB
    limit. That limit is scoped to this route only: it is mounted ahead of the
    global `express.json()` parser so no other endpoint's 100 KB default is
    weakened.
  - `409 capture_conflict` / `409 capture_event_conflict` — the same capture id
    with different contents, or another capture already recording that commit
    or checkpoint.
- The server content-addresses, gzip-compresses, and AES-256-GCM encrypts every
  snapshot and diff before storage. Postgres holds no plaintext (§2).

`ariadne sync push` uploads pending captures **after** the task and all of its
sub-entities are on the server (the task must already exist remotely), marks
only the capture ids the server acknowledged as synced, and leaves any failed
capture pending so the next push retries it. Upload failures are reported with
the stable error code only — capture content is never logged.

### 4.8 Admin — task audit (temporary bearer-admin gate)

These reads require the **singleton admin** (`403 admin_required` otherwise)
and are bearer-token gated only as an interim measure; plan 04 replaces this
with browser sessions. All three responses are `Cache-Control: no-store`.

**`GET /api/v1/admin/tasks?limit=&offset=`** — every task in the admin's team
```json
{
  "tasks": [
    {
      "taskId": "9a3f...", "localId": "01J...", "title": "...", "goal": null,
      "status": "active", "branch": null, "workspaceLabel": "laptop1:org/atom",
      "owner": "alice", "captureCount": 3,
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "hasMore": false,
  "nextOffset": null
}
```

**`GET /api/v1/admin/tasks/:taskId/timeline`** — one merged audit timeline
```json
{
  "taskId": "9a3f...",
  "events": [
    { "kind": "task", "id": "9a3f...", "occurredAt": "...", "summary": "...", "metadata": { } },
    { "kind": "capture", "id": "01J...", "occurredAt": "...", "summary": "git_commit capture of 1 file(s)",
      "metadata": { "trigger": "git_commit", "gitCommitSha": "abc...", "checkpointId": null,
                    "entryCount": 1,
                    "files": [ { "path": "src/a.ts", "contentSha256": "...", "byteLength": 20 } ] } }
  ]
}
```

- `kind` is one of `task`, `commit`, `checkpoint`, `capture`, `command`,
  `decision`, `todo`, `error`, `question`.
- `commit` events are derived from commit-triggered captures (the server stores
  no separate commits table), deduplicated by SHA and dated at the earliest
  capture recording them.
- Ordering is deterministic: `occurredAt` ascending, then the fixed `kind`
  order listed above, then `id` ascending. The same task always renders
  identically.
- The timeline is **metadata only**. Capture entries expose path, snapshot
  hash, and plaintext byte length (read from the blob's authenticated
  metadata, without decrypting); file text is never included here.

**`GET /api/v1/admin/tasks/:taskId/file-captures/:captureId/files/:path`** —
the single endpoint that decrypts captured file content
```json
{
  "path": "src/a.ts",
  "content": "export const a = 1;\n",
  "unifiedDiff": "@@ -0,0 +1 @@\n+export const a = 1;\n",
  "contentSha256": "<64 lowercase hex>",
  "byteLength": 20
}
```

- `:path` is the URL-encoded captured path. It is percent-decoded exactly once
  (by the router) and then validated, never decoded again: absolute paths,
  `..` segments, backslashes, and control characters are rejected with
  `400 invalid_request`, so `%2e%2e%2f...` cannot escape the capture.
- `404 task_not_found` for a task outside the admin's team,
  `404 capture_not_found` for an unknown capture, and
  `404 capture_file_not_found` when the capture holds no such path.
- Responses carry `Cache-Control: no-store` and `X-Content-Type-Options:
  nosniff`; decrypted text is returned as JSON data and is never interpreted
  as HTML.

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
