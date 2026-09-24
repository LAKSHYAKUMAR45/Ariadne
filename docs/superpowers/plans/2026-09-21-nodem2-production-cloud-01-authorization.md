# Single-Team Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat authenticated access with explicit singleton-team membership and exactly one server-authoritative admin.

**Architecture:** Add team/membership schema, centralize access resolution in a small service, scope every sync query through the caller's active membership, and add member-management/admin-session foundations. Existing users/tasks are backfilled into one team without changing remote IDs.

**Tech Stack:** TypeScript 5.5, Express 4, PostgreSQL 16, Zod, JWT, bcryptjs, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md`

## Global Constraints

- One singleton team per server.
- First registered user is the immutable admin; later registrations are members.
- Membership is checked from PostgreSQL on every protected request, not trusted from JWT claims.
- Missing and unauthorized resources both return `404`.
- Open registration remains available only behind SSH/loopback.
- Preserve all existing user/task IDs and data.

---

### Task 1: Team schema and data-preserving migration

**Files:**
- Create: `packages/sync-server/migrations/0006_single_team_authorization.sql`
- Modify: `packages/sync-server/test/migrate.test.ts`
- Modify: `packages/sync-server/test/globalSetup.ts`
- Modify: `docs/07-CLOUD-SYNC-API-CONTRACT.md`

**Interfaces:**
- Produces tables `teams`, `team_memberships`, and non-null `tasks.team_id`.
- Produces singleton-team invariant enforced by a unique constant key.
- Produces indexes `idx_team_memberships_user_active` and `idx_tasks_team_updated`.

- [ ] **Step 1: Write the failing migration test**

Add a test that inserts two users and two tasks under schema v5, runs
`runMigrations`, then asserts:

```ts
const teams = await pool.query('SELECT id, singleton_key FROM teams');
expect(teams.rows).toHaveLength(1);
expect(teams.rows[0].singleton_key).toBe('default');

const memberships = await pool.query(
  'SELECT user_id, role, active FROM team_memberships ORDER BY created_at ASC',
);
expect(memberships.rows.map((row) => row.role)).toEqual(['admin', 'member']);
expect(memberships.rows.every((row) => row.active)).toBe(true);

const unscoped = await pool.query('SELECT count(*)::int AS count FROM tasks WHERE team_id IS NULL');
expect(unscoped.rows[0].count).toBe(0);
```

- [ ] **Step 2: Run the test and verify RED**

```bash
TEST_DATABASE_URL=postgres://ariadne:password@127.0.0.1:55432/ariadne_test \
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts
```

Expected: failure because migration 0006 and the new tables/column do not exist.

- [ ] **Step 3: Implement migration 0006**

The migration must:

```sql
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
```

Insert the singleton team, choose the oldest existing user by
`created_at, id` as admin, add all other users as members, add/backfill
`tasks.team_id`, make it non-null, add indexes, and set schema version `6`.
Add a partial unique index on `team_memberships(team_id) WHERE role = 'admin'`
so PostgreSQL enforces at most one admin per team. Make every operation
idempotent under the migration runner.

- [ ] **Step 4: Run migration tests and inspect schema**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts
```

Expected: PASS, including a second-run no-op assertion.

- [ ] **Step 5: Update the API contract**

Document the exact schema, singleton-team backfill, and team-scoping rule.
Remove statements that `owner_user_id` is the access boundary or that access
is flat.

- [ ] **Step 6: Commit**

```bash
git add packages/sync-server/migrations/0006_single_team_authorization.sql packages/sync-server/test/migrate.test.ts packages/sync-server/test/globalSetup.ts docs/07-CLOUD-SYNC-API-CONTRACT.md
git commit -m "feat(sync-server): add singleton team schema"
```

### Task 2: Membership service and transactional registration

**Files:**
- Create: `packages/sync-server/src/teamAccess.ts`
- Create: `packages/sync-server/test/teamAccess.test.ts`
- Modify: `packages/sync-server/src/routes/auth.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ActiveMembership {
  teamId: string;
  role: 'admin' | 'member';
}

export async function requireActiveMembership(
  pool: Pool,
  userId: string,
): Promise<ActiveMembership>;

export async function registerIntoSingletonTeam(
  pool: Pool,
  username: string,
  passwordHash: string,
): Promise<{ userId: string; teamId: string; role: 'admin' | 'member' }>;
```

- [ ] **Step 1: Write failing service and registration tests**

Cover:

```ts
it('makes the first registered user admin and later users members');
it('returns forbidden for a user with inactive membership');
it('rolls back user creation if membership creation fails');
it('keeps exactly one admin under concurrent first registrations');
```

Use two parallel registration requests for the concurrency case and assert one
admin, one member, one team.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/teamAccess.test.ts test/routes.test.ts
```

- [ ] **Step 3: Implement `teamAccess.ts`**

Use a PostgreSQL transaction and a transaction-scoped advisory lock:

```sql
SELECT pg_advisory_xact_lock(hashtext('ariadne-singleton-team-registration'));
```

Inside the lock, create/read the singleton team, determine whether an admin
membership exists, create the user and membership, then commit. Throw
`ApiError(403, 'inactive_membership', ...)` from
`requireActiveMembership` when no active membership exists.

- [ ] **Step 4: Route registration through the service**

Hash the password before entering `registerIntoSingletonTeam`; return the same
public registration shape plus `role`:

```json
{"userId":"...","username":"alice","role":"admin"}
```

Never return `teamId` as an authorization credential.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/teamAccess.test.ts test/routes.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/sync-server/src/teamAccess.ts packages/sync-server/src/routes/auth.ts packages/sync-server/test/teamAccess.test.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(auth): register users into the singleton team"
```

### Task 3: Team-scope every sync route

**Files:**
- Create: `packages/sync-server/src/taskAccess.ts`
- Create: `packages/sync-server/test/taskAccess.test.ts`
- Modify: `packages/sync-server/src/routes/sync.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

**Interfaces:**
- Consumes: `requireActiveMembership(pool, userId)`.
- Produces:

```ts
export async function requireTeamTask(
  pool: Pool,
  teamId: string,
  taskId: string,
): Promise<void>;

export function inaccessibleTaskError(taskId: string): ApiError;
```

- [ ] **Step 1: Write failing cross-team tests**

Create two teams directly in the test database. For every endpoint family,
assert a team-B user cannot:

```ts
await request(app).get('/api/v1/sync/tasks').set(authB).expect(200); // excludes team A rows
await request(app).get('/api/v1/sync/tasks/all').set(authB).expect(200); // excludes team A rows
await request(app).post('/api/v1/sync/tasks').set(authB).send(updateTeamATask).expect(404);
```

Repeat create/update/pull checks for checkpoints, todos, decisions, errors,
open questions, and commands. Assert superseding a decision across teams
returns `400 invalid_supersedes_id` without revealing the foreign decision.

- [ ] **Step 2: Run the tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/taskAccess.test.ts test/routes.test.ts
```

- [ ] **Step 3: Implement centralized task authorization**

`requireTeamTask` must use:

```sql
SELECT 1 FROM tasks WHERE id = $1 AND team_id = $2
```

and throw the same `task_not_found` response used for absent IDs.

- [ ] **Step 4: Scope task queries**

At the start of each handler:

```ts
const membership = await requireActiveMembership(pool, req.userId!);
```

Task inserts set `team_id`. Task updates include `AND team_id = $team`.
Incremental and all-task lists filter `WHERE team_id = $team`. Sub-entity
handlers call `requireTeamTask` before querying or writing. Existing
`remoteTaskId` matching remains mandatory.

- [ ] **Step 5: Run all server integration tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run
```

Expected: all existing sync semantics pass plus cross-team denial.

- [ ] **Step 6: Commit**

```bash
git add packages/sync-server/src/taskAccess.ts packages/sync-server/src/routes/sync.ts packages/sync-server/test/taskAccess.test.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(sync-server): enforce team-scoped task access"
```

### Task 4: Singleton-admin member management

**Files:**
- Create: `packages/sync-server/src/routes/members.ts`
- Create: `packages/sync-server/src/adminAccess.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

**Interfaces:**
- Produces:

```ts
export async function requireSingletonAdmin(
  pool: Pool,
  userId: string,
): Promise<ActiveMembership>;
```

- Produces endpoints:
  - `GET /api/v1/admin/members`
  - `PATCH /api/v1/admin/members/:userId` body `{ active: boolean }`

- [ ] **Step 1: Write failing server tests**

Cover admin list/activate/deactivate, member receives `403`, unknown user
receives `404`, and attempts to deactivate the admin receive
`409 admin_immutable`.

- [ ] **Step 2: Run server tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/routes.test.ts
```

- [ ] **Step 3: Implement admin access and member routes**

Query active membership with `role = 'admin'`. Return:

```ts
interface TeamMemberView {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: string;
}
```

Only member rows may change `active`. During this foundation plan, these routes
use the existing bearer token plus `requireSingletonAdmin`; Plan 04 replaces
that temporary admin-route authentication with dashboard sessions before
production rollout.

- [ ] **Step 4: Run server tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run
```

- [ ] **Step 5: Commit**

```bash
git add packages/sync-server/src/adminAccess.ts packages/sync-server/src/routes/members.ts packages/sync-server/src/app.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(admin): manage singleton team members"
```

### Task 5: Authorization documentation and review gate

**Files:**
- Modify: `docs/06-CLOUD-SYNC-DESIGN.md`
- Modify: `docs/07-CLOUD-SYNC-API-CONTRACT.md`
- Modify: `docs/05-USER-GUIDE.md`
- Modify: `packages/sync-server/README.md`

- [ ] **Step 1: Update docs**

Document one team, first-user admin, open registration behind SSH, member
access, immutable network-admin role, root-only admin transfer, and 404
resource-hiding behavior.

- [ ] **Step 2: Run validation**

```bash
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run
pnpm --filter @ariadne-dev/cli build
pnpm --filter @ariadne-dev/cli exec vitest run
git diff --check
```

- [ ] **Step 3: Run mandatory reviews**

Invoke the TypeScript Reviewer and Security Reviewer against this plan's diff.
Fix all high-confidence authorization, transaction, and information-disclosure
findings.

- [ ] **Step 4: Commit**

```bash
git add docs/06-CLOUD-SYNC-DESIGN.md docs/07-CLOUD-SYNC-API-CONTRACT.md docs/05-USER-GUIDE.md packages/sync-server/README.md
git commit -m "docs(cloud): document team authorization"
```
