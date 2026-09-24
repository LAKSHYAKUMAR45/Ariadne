# Operations Dashboard and Nodem2 Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a status-first single-admin Operations Console at `/admin`, provide safe visual task/file inspection and operational controls, then deploy and verify the complete stack on nodem2.

**Architecture:** The sync server owns short-lived database-backed browser sessions, CSRF enforcement, reauthentication, admin read APIs, and static dashboard delivery. A React/Vite SPA consumes only same-origin `/api/v1/admin/*` endpoints. Privileged mutations pass through the typed operator from Plan 03. Final rollout begins with a safety backup and preserves the existing service until the new stack passes all checks.

**Tech Stack:** React 19, Vite 6, TypeScript 5.5, CSS, Express 4, PostgreSQL 16, Zod, Vitest, React Testing Library, MSW, axe, Playwright, Docker Compose, systemd.

**Spec:** `docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md`

## Global Constraints

- Exactly one active admin account can establish dashboard sessions.
- Browser never receives or stores the CLI JWT.
- Session cookie is HttpOnly, SameSite=Strict, scoped to `/api/v1/admin`, and
  short-lived. `Secure` is enabled for HTTPS and deliberately omitted for the
  approved SSH-tunneled loopback HTTP origin.
- Every state-changing request requires CSRF and an allowed `Origin`.
- Destructive actions require password reauthentication no older than 5 minutes.
- File content is read-only, escaped, no-store, and never rendered as HTML.
- Logs are server-selected, bounded, redacted, and non-downloadable by default.
- The interface prioritizes current status and active failures over decorative
  charts or generic card grids.

---

### Task 1: Database-backed admin sessions, CSRF, and reauthentication

**Files:**
- Create: `packages/sync-server/migrations/0009_admin_sessions.sql`
- Create: `packages/sync-server/src/adminSessions.ts`
- Create: `packages/sync-server/src/routes/adminAuth.ts`
- Create: `packages/sync-server/test/adminSessions.test.ts`
- Modify: `packages/sync-server/src/middleware.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/src/config.ts`
- Modify: `packages/sync-server/test/routes.test.ts`
- Modify: `packages/sync-server/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
declare global {
  namespace Express {
    interface Request {
      adminSession?: {
        id: string;
        userId: string;
        csrfHash: string;
        reauthenticatedUntil: string | null;
      };
    }
  }
}
```

- Produces:
  - `POST /api/v1/admin/session` body `{ username, password }`
  - `GET /api/v1/admin/session`
  - `DELETE /api/v1/admin/session`
  - `POST /api/v1/admin/session/reauthenticate` body `{ password }`

- [ ] **Step 1: Write failing session tests**

Cover:

- only active admin can log in;
- members/inactive users receive generic `invalid_credentials`;
- cookie flags/path/max-age are exact;
- `Secure` follows the configured HTTPS/loopback transport mode;
- DB stores SHA-256 session token hash, never raw token;
- login response returns a separate CSRF token;
- expired/revoked sessions fail;
- logout revokes and clears cookie;
- state-changing requests reject missing/wrong CSRF and disallowed Origin;
- bearer JWTs no longer authorize any `/api/v1/admin/*` endpoint;
- successful password reauthentication lasts five minutes;
- rate limits apply to login and reauthentication;
- password/JWT/session/CSRF values never enter logs.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/adminSessions.test.ts test/routes.test.ts
```

- [ ] **Step 3: Add migration and session repository**

Create `admin_sessions` with token hash, user ID, CSRF hash, expiry,
reauthenticated-until, revoked-at, created-at, and last-seen-at. Add expiry
index. Generate 32 random bytes for session and CSRF tokens. Hash before DB.
Use constant-time comparison for CSRF hashes.

- [ ] **Step 4: Implement middleware/routes**

Use the `cookie` package for strict parsing/serialization. Require
`ADMIN_PUBLIC_ORIGIN` in production. `requireAdminSession` re-queries active
admin membership on every request. `requireCsrf` checks both Origin and
`X-CSRF-Token`. `requireRecentReauthentication` returns
`403 reauthentication_required`.

Replace the temporary bearer-admin middleware from Plans 01-03 on every
`/api/v1/admin/*` route with `requireAdminSession`; only
`POST /api/v1/admin/session` remains unauthenticated.

Use a bounded in-memory rate limiter keyed by normalized username + remote
loopback address, with periodic cleanup; document that SSH is the network
boundary. Append sanitized admin audit events for successful/failed login,
logout, and reauthentication without recording credentials, tokens, or raw
request bodies.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm install
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run test/adminSessions.test.ts test/routes.test.ts
git add packages/sync-server/migrations/0009_admin_sessions.sql packages/sync-server/src/adminSessions.ts packages/sync-server/src/routes/adminAuth.ts packages/sync-server/src/middleware.ts packages/sync-server/src/app.ts packages/sync-server/src/config.ts packages/sync-server/test/adminSessions.test.ts packages/sync-server/test/routes.test.ts packages/sync-server/package.json pnpm-lock.yaml
git commit -m "feat(admin): add secure dashboard sessions"
```

### Task 2: Admin overview, backup, log, and service read APIs

**Files:**
- Create: `packages/sync-server/src/routes/adminOverview.ts`
- Create: `packages/sync-server/src/routes/adminBackups.ts`
- Create: `packages/sync-server/src/routes/adminLogs.ts`
- Create: `packages/sync-server/src/routes/adminServices.ts`
- Create: `packages/sync-server/src/routes/adminAudit.ts`
- Modify: `packages/sync-server/src/operatorClient.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/test/routes.test.ts`
- Modify: `packages/operator/src/protocol.ts`
- Modify: `packages/operator/src/server.ts`
- Modify: `packages/operator/test/server.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/admin/overview`
  - `GET /api/v1/admin/backups`
  - `GET /api/v1/admin/backups/:name/download`
  - `GET /api/v1/admin/logs?source=sync-server|operator|deployment|backup&cursor=&limit=&severity=&since=`
  - `GET /api/v1/admin/services`
  - `GET /api/v1/admin/deployments`
  - `GET /api/v1/admin/audit`

Overview:

```ts
interface AdminOverview {
  generatedAt: string;
  database: { healthy: boolean; latencyMs: number };
  host: {
    cpuPercent: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    filesystemUsedBytes: number;
    filesystemTotalBytes: number;
  };
  databaseSizeBytes: number;
  services: Array<{ name: 'sync-server' | 'operator' | 'postgres'; state: string }>;
  tasks: { total: number; active: number; updatedLast24h: number };
  members: { active: number; inactive: number };
  sync: { lastPushAt: string | null; lastPullAt: string | null };
  backup: { latestAt: string | null; latestVerifiedAt: string | null; status: string };
  operations: { running: number; failedLast24h: number };
}
```

- [ ] **Step 1: Write failing API/operator tests**

Cover admin-only access, database/host metrics, stale backup warning,
operator-unavailable degradation, fixed log sources, deployment/backup log
sources, severity/time filters, cursor pagination, limit 1-500, ANSI removal,
secret redaction, max 256 KiB log response, append-only audit pagination, and
`Cache-Control: no-store`. Backup download tests validate the fixed basename,
checksum, maximum configured size, attachment headers, streaming
backpressure/client abort, and no path exposure.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run test/server.test.ts
pnpm --filter @ariadne-dev/sync-server exec vitest run test/routes.test.ts
```

- [ ] **Step 3: Extend operator with read-only status protocol**

Add a separate strict request union:

```ts
type OperatorQuery =
  | { type: 'service_status' }
  | { type: 'host_metrics' }
  | { type: 'deployment_status' }
  | { type: 'backup_read'; backupName: string }
  | { type: 'logs_read'; source: 'sync-server' | 'operator' | 'deployment' | 'backup'; cursor?: string; limit: number; severity?: 'error' | 'warning' | 'info'; since?: string };
```

Map to fixed `/proc`/filesystem reads, backup-directory access,
`systemctl show`, and `journalctl` argument arrays. Validate `since` as an RFC
3339 timestamp and translate it internally; the caller cannot supply unit
names, arbitrary journal expressions, output fields, or paths. Backup streaming
accepts only a verified recorded basename and enforces the configured maximum.
`deployment_status` returns the current revision, migration version, rollback
revision, and a bounded list of immutable commit SHAs reachable from the
configured trusted remote/ref. Normalize output into typed JSON and redact
before returning.

- [ ] **Step 4: Implement server aggregation routes**

Run independent metrics in parallel with per-source timeouts. Return
`healthy: false` and an explicit component error for unavailable optional
operator data; do not return success-shaped fake values. DB failure returns
`503`.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/operator build
pnpm --filter @ariadne-dev/operator exec vitest run
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run
git add packages/operator packages/sync-server/src/operatorClient.ts packages/sync-server/src/routes/adminOverview.ts packages/sync-server/src/routes/adminBackups.ts packages/sync-server/src/routes/adminLogs.ts packages/sync-server/src/routes/adminServices.ts packages/sync-server/src/app.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(admin): expose operations console data"
```

### Task 3: Scaffold dashboard package and design contract

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/tsconfig.json`
- Create: `packages/dashboard/vite.config.ts`
- Create: `packages/dashboard/index.html`
- Create: `packages/dashboard/src/main.tsx`
- Create: `packages/dashboard/src/App.tsx`
- Create: `packages/dashboard/src/styles/tokens.css`
- Create: `packages/dashboard/src/styles/global.css`
- Create: `packages/dashboard/src/test/setup.ts`
- Create: `packages/dashboard/src/App.test.tsx`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Load required UI skills before design**

Invoke `anti-ui-slop`, `react-patterns`, and `react-testing`. Use the approved
Operations Console and timeline-first direction from the spec. Record the
resulting design contract in test names and CSS tokens, not a new planning
document.

- [ ] **Step 2: Write failing shell tests**

Test:

- unauthenticated users see only the login form;
- authenticated users see primary navigation and a persistent environment
  banner;
- keyboard skip link reaches main content;
- 360 px, 768 px, and desktop layouts do not hide critical state;
- reduced-motion preference disables non-essential animation;
- axe reports no serious/critical violations.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run
```

Expected initially: package does not exist.

- [ ] **Step 4: Scaffold focused visual system**

Use:

- dark, dense status rail with explicit green/amber/red text labels, not color
  alone;
- near-black/navy canvas, high-contrast neutral typography, restrained blue for
  actions, operational amber/red only for attention;
- tabular numbers for timestamps/counts;
- 4/8 px spacing scale;
- desktop split panes that collapse to ordered sections on narrow screens;
- no gradients, floating glass cards, oversized hero text, or decorative
  dashboard charts without decisions attached.

Create routes/state for `Overview`, `Tasks`, `Members`, `Backups`,
`Services`, `Deployments`, `Logs`, and `Audit`.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm install
pnpm --filter @ariadne-dev/dashboard build
pnpm --filter @ariadne-dev/dashboard exec vitest run
git add packages/dashboard pnpm-lock.yaml
git commit -m "feat(dashboard): scaffold operations console"
```

### Task 4: Typed API client and authentication UI

**Files:**
- Create: `packages/dashboard/src/api/types.ts`
- Create: `packages/dashboard/src/api/client.ts`
- Create: `packages/dashboard/src/auth/AuthProvider.tsx`
- Create: `packages/dashboard/src/auth/LoginPage.tsx`
- Create: `packages/dashboard/src/auth/ReauthenticateDialog.tsx`
- Create: `packages/dashboard/src/auth/auth.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`

**Interfaces:**

```ts
export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) { super(message); }
}
```

- [ ] **Step 1: Write failing auth/API tests**

Use MSW. Cover login, invalid credentials, session restore, logout, expired
session redirect, CSRF header on mutations only, `credentials: 'same-origin'`,
reauthentication retry flow, network failure, JSON error validation, and no
secret persistence in local/session storage.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth/auth.test.tsx
```

- [ ] **Step 3: Implement strict client**

Keep CSRF token only in React memory. Validate response shapes with small
runtime guards; malformed responses throw `AdminApiError` rather than silently
defaulting. Abort requests on component unmount/timeouts.

- [ ] **Step 4: Implement auth UI**

Use native labels/autocomplete (`username`, `current-password`), visible error
summary, disabled submitting state, and focus management. Reauthentication
dialog collects only the password and retries the pending operation after
success.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth/auth.test.tsx
git add packages/dashboard/src/api packages/dashboard/src/auth packages/dashboard/src/App.tsx
git commit -m "feat(dashboard): add admin authentication flow"
```

### Task 5: Status-first overview and member management

**Files:**
- Create: `packages/dashboard/src/overview/OverviewPage.tsx`
- Create: `packages/dashboard/src/overview/OverviewPage.test.tsx`
- Create: `packages/dashboard/src/members/MembersPage.tsx`
- Create: `packages/dashboard/src/members/MembersPage.test.tsx`
- Create: `packages/dashboard/src/components/StatusLabel.tsx`
- Create: `packages/dashboard/src/components/AsyncState.tsx`
- Modify: `packages/dashboard/src/App.tsx`

- [ ] **Step 1: Write failing component tests**

Overview tests cover healthy, degraded, stale backup, running operation,
partial operator failure, loading, and hard-error states. Member tests cover
active/inactive users, immutable admin control, confirmation, optimistic
disable prevention, API failure rollback, and accessible status text.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/overview src/members
```

- [ ] **Step 3: Implement overview**

Render one prioritized status list:

1. active failures/actions required;
2. service/database state;
3. latest backup verification;
4. running/recent failed operations;
5. task/member/sync counts.

Timestamps include absolute UTC and relative text. Refresh every 30 seconds
only while visible and provide a manual refresh button.

- [ ] **Step 4: Implement member management**

Use a compact table/list with role, state, joined date, and one explicit
activate/deactivate action. Require confirmation; never render an admin
deactivation control. Successful and failed membership changes append
sanitized admin audit events.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/overview src/members
git add packages/dashboard/src/overview packages/dashboard/src/members packages/dashboard/src/components packages/dashboard/src/App.tsx
git commit -m "feat(dashboard): add status and member views"
```

### Task 6: Timeline-first task audit and file viewer

**Files:**
- Create: `packages/dashboard/src/tasks/TasksPage.tsx`
- Create: `packages/dashboard/src/tasks/TaskTimeline.tsx`
- Create: `packages/dashboard/src/tasks/FileViewer.tsx`
- Create: `packages/dashboard/src/tasks/tasks.test.tsx`
- Create: `packages/dashboard/src/components/VirtualText.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/sync-server/src/routes/adminTasks.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

- [ ] **Step 1: Write failing task-view tests**

Cover task search/status filters, selected-task URL state, ordered mixed event
timeline, command redaction display, capture/file selection, snapshot/diff
toggle with unified and side-by-side modes, empty capture,
missing/decrypt-failed content, HTML/script text shown
literally, large-file virtualization, copy action, keyboard navigation, and
mobile pane stacking. Server/component tests cover deleting a capture only
after CSRF, recent reauthentication, exact capture-ID confirmation, immutable
audit recording, and shared encrypted-blob preservation.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks
```

- [ ] **Step 3: Implement task explorer**

Use three conceptual regions:

- task list/filter;
- chronological event timeline;
- selected event/file detail.

Do not fetch file content until selected. Cache only in component memory and
clear on task change/logout. Use `<pre><code>{text}</code></pre>` or virtual
text rows; never `dangerouslySetInnerHTML`. Show line numbers and diff prefixes
as separate text spans. Add
`DELETE /api/v1/admin/tasks/:taskId/file-captures/:captureId`; require CSRF and
recent reauthentication, call the transactional deletion API from Plan 02, and
return `204` without deleted plaintext.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks
git add packages/dashboard/src/tasks packages/dashboard/src/components/VirtualText.tsx packages/dashboard/src/App.tsx packages/sync-server/src/routes/adminTasks.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(dashboard): add task history and file viewer"
```

### Task 7: Backups, services, deployments, logs, and safe controls

**Files:**
- Create: `packages/dashboard/src/operations/BackupsPage.tsx`
- Create: `packages/dashboard/src/operations/ServicesPage.tsx`
- Create: `packages/dashboard/src/operations/DeploymentsPage.tsx`
- Create: `packages/dashboard/src/operations/LogsPage.tsx`
- Create: `packages/dashboard/src/operations/AuditPage.tsx`
- Create: `packages/dashboard/src/operations/OperationProgress.tsx`
- Create: `packages/dashboard/src/operations/operations.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`

- [ ] **Step 1: Write failing operations tests**

Cover backup list/status/download, create/verify/restore confirmations, reauth
prompt for restart/deploy/restore/delete-history, disabled controls while busy,
SSE progress/reconnect, terminal success/failure, safe retry, sync-server and
PostgreSQL service controls, trusted revision selection, deployment rollback
status, service degradation, log source/time/severity filters, bounded
pagination, ANSI-free rendering, secret redaction marker, immutable audit
pagination, and no arbitrary command/path inputs.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/operations
```

- [ ] **Step 3: Implement safe operations UX**

Use explicit verbs and impact text:

- `Create backup`
- `Verify backup`
- `Restore this backup`
- `Restart sync server`
- `Restart PostgreSQL`
- `Deploy tracked revision`

Restore requires typing the exact backup basename after reauthentication.
Deployment/restart require confirmation and reauthentication. Deployment
selects only trusted revisions returned by the server; it never accepts
free-form refs. Subscribe to the operation SSE endpoint and always show
persisted final status after reconnect.

- [ ] **Step 4: Implement logs**

Fixed source selector only, fixed time/severity controls, 100-line default,
load-more cursor, pause/resume, client text filter, and copy selected lines.
Never offer arbitrary journal unit, file path, shell expression, or unbounded
download. Render admin audit events in a separate immutable table with actor,
action, outcome, artifact, and timestamp.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/operations
git add packages/dashboard/src/operations packages/dashboard/src/App.tsx
git commit -m "feat(dashboard): add audited operational controls"
```

### Task 8: Serve the dashboard from the sync server

**Files:**
- Modify: `packages/dashboard/vite.config.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/src/config.ts`
- Modify: `packages/sync-server/package.json`
- Modify: `packages/sync-server/test/routes.test.ts`
- Modify: `deploy/nodem2/sync-server.Dockerfile`
- Modify: `deploy/nodem2/compose.yaml`
- Modify: `package.json`

- [ ] **Step 1: Write failing static-delivery tests**

Assert:

- `/admin` and `/admin/tasks/...` return dashboard `index.html`;
- hashed assets have immutable cache headers;
- HTML has `no-cache`;
- `/api/*` and unknown non-admin paths are never swallowed by SPA fallback;
- CSP forbids inline script/object/frame and limits connect to self;
- security headers include nosniff, frame deny, strict referrer policy, and
  HSTS only under production HTTPS assumptions;
- missing dashboard assets fail startup in production.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/routes.test.ts
```

- [ ] **Step 3: Configure dashboard build**

Set Vite base `/admin/` and output deterministic hashed assets. Add root build
dependency/order so dashboard builds before sync-server packaging.

- [ ] **Step 4: Serve static assets safely**

Mount admin API before static routes. Use exact filesystem root from config,
deny dotfiles, and fallback only for `GET /admin` and `/admin/*` accepting
HTML. Add CSP/security header middleware without weakening API behavior.

- [ ] **Step 5: Package assets into production image**

Copy `packages/dashboard/dist` into a fixed runtime path and set
`DASHBOARD_DIST_DIR`. Keep image non-root/read-only.

- [ ] **Step 6: Run tests/build and commit**

```bash
pnpm --filter @ariadne-dev/dashboard build
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example build sync-server
git add packages/dashboard/vite.config.ts packages/sync-server deploy/nodem2/sync-server.Dockerfile deploy/nodem2/compose.yaml package.json
git commit -m "feat(dashboard): serve console from the sync server"
```

### Task 9: Browser end-to-end tests and finish gate

**Files:**
- Create: `packages/dashboard/playwright.config.ts`
- Create: `packages/dashboard/e2e/admin-dashboard.spec.ts`
- Create: `packages/dashboard/e2e/fixtures.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add Playwright and deterministic test fixtures**

Provision a real test PostgreSQL database, injected test encryption keyring,
fake operator Unix socket, one admin, one member, one task with checkpoint,
commit, command, and encrypted file capture.

- [ ] **Step 2: Write E2E flows**

Cover:

1. login → degraded/healthy overview;
2. activate/deactivate member;
3. open task timeline → snapshot → diff and verify HTML text remains inert;
4. create and verify backup with live progress;
5. reauthenticate and restart;
6. failed deployment surfaces error and rollback status;
7. inspect paginated redacted logs;
8. logout and direct admin-route denial.

- [ ] **Step 3: Run E2E and accessibility**

```bash
pnpm install
pnpm --filter @ariadne-dev/dashboard exec playwright install chromium
pnpm --filter @ariadne-dev/dashboard test
pnpm --filter @ariadne-dev/dashboard run test:e2e
```

- [ ] **Step 4: Run UI finish gate**

Invoke `anti-ui-slop` finish gate and React Reviewer. Test at 360×800,
768×1024, and 1440×900. Fix all required-state, accessibility, overflow,
focus, and generic-UI findings.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard pnpm-lock.yaml
git commit -m "test(dashboard): cover admin operations end to end"
```

### Task 10: Full security and code-review gate

- [ ] **Step 1: Run all local validation**

```bash
pnpm -r build
pnpm -r test
pnpm --filter @ariadne-dev/dashboard run test:e2e
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example config --quiet
systemd-analyze verify deploy/nodem2/systemd/*.service deploy/nodem2/systemd/*.timer
git diff --check
```

- [ ] **Step 2: Run mandatory reviewers**

Invoke TypeScript Reviewer, React Reviewer, Security Reviewer, and
Silent Failure Hunter. Explicitly inspect session fixation, CSRF, Origin
validation, reauthentication, cookie flags, rate limiting, XSS/CSP, decrypted
content caching, SSE cleanup, operator input boundaries, audit completeness,
and error propagation.

- [ ] **Step 3: Fix accepted findings test-first**

Add a regression test for every accepted issue and rerun the narrow then full
suite.

- [ ] **Step 4: Commit fixes**

```bash
git add packages/dashboard packages/sync-server packages/operator deploy/nodem2
git commit -m "fix(admin): harden the operations console"
```

### Task 11: Safety-backup-first nodem2 rollout

**Files:**
- Modify: `docs/05-USER-GUIDE.md`
- Modify: `packages/sync-server/README.md`
- Modify: `deploy/nodem2/README.md`

- [ ] **Step 1: Record pre-deployment state**

```bash
git rev-parse HEAD
git status --short
ssh root@nodem2 'systemctl is-active ariadne-sync-server.service; docker ps --filter name=ariadne-pg --format "{{.Names}} {{.Image}} {{.Status}}"; ss -ltnp | grep -E ":(4300|5432)\b" || true'
```

Expected: local tree clean, old sync service active, PostgreSQL container
healthy, public interfaces not listening on 4300/5432.

- [ ] **Step 2: Take and verify a safety backup before migration**

Copy only the tracked backup script to a temporary root-owned path, run it
against the current `ariadne-pg`, verify SHA-256 and `pg_restore --list`, and
record the basename. Do not modify the old service yet.

- [ ] **Step 3: Install tracked production assets**

```bash
rsync -a --delete --exclude '.git' ./ root@nodem2:/opt/ariadne/source/
ssh root@nodem2 'cd /opt/ariadne/source && deploy/nodem2/scripts/install'
```

The installer must preserve `/etc/ariadne/*.env`, create the first encryption
key if absent, install units, and stop for missing required values rather than
inventing secrets.

- [ ] **Step 4: Build and migrate without traffic cutover**

```bash
ssh root@nodem2 'cd /opt/ariadne/source && docker compose -f deploy/nodem2/compose.yaml --env-file /etc/ariadne/compose.env build && docker compose -f deploy/nodem2/compose.yaml --env-file /etc/ariadne/compose.env run --rm migrate'
```

Verify migration version `9`, singleton team count `1`, task count unchanged,
and no null `tasks.team_id`.

- [ ] **Step 5: Cut over with rollback ready**

Stop/disable the old `ariadne-sync-server.service` only after migration passes.
Start operator, backup timers, and Compose services. Poll:

```bash
ssh root@nodem2 'curl --fail --silent http://127.0.0.1:4300/health'
```

If health, migration, or smoke tests fail, run the tracked rollback path and
restart the old service. Do not continue to admin registration.

- [ ] **Step 6: Relink the local CLI to this repository**

```bash
pnpm build
pnpm install:cli
command -v ariadne
readlink -f "$(command -v ariadne)"
```

Expected target is under `/home/lkumar/Ariadne`, not the older
`jcnr-solution-testing/ariadne` checkout.

- [ ] **Step 7: Create the single admin through the normal tunnel**

If production still has zero users:

```bash
ariadne sync setup admin --register
```

Enter the password only at the hidden prompt. If a user already exists from
the migrated database, verify the oldest user is admin and do not register a
replacement.

- [ ] **Step 8: Run production smoke tests**

Through local `127.0.0.1:14300`:

- login to `/admin` as `admin`;
- verify overview health and service states;
- verify member list;
- push and pull a disposable smoke task from two workspaces;
- create checkpoint/file capture and inspect snapshot/diff in dashboard;
- verify command and Git timeline entries;
- create backup, verify it, and confirm files/modes/metadata on nodem2;
- inspect fixed-source logs;
- restart sync server and confirm automatic recovery;
- run a no-change deployment and confirm operation audit/SSE completion;
- log out and confirm admin APIs reject the old session.

- [ ] **Step 9: Verify persistence and network boundary**

Restart nodem2 Compose services and operator, then recheck:

```bash
ssh root@nodem2 'docker compose -f /opt/ariadne/source/deploy/nodem2/compose.yaml --env-file /etc/ariadne/compose.env restart && systemctl restart ariadne-operator.service && curl --fail --silent http://127.0.0.1:4300/health && ss -ltnp | grep -E ":(4300|5432)\b"'
```

Expected: data/admin login persists; listeners are loopback only; operator is
Unix-socket only; no Docker socket is mounted into sync server.

- [ ] **Step 10: Update operational docs**

Document install, upgrade, rollback, admin login, member controls, tunnel URL,
backup locations/retention/verification, encryption key backup and rotation,
restore procedure, service/log controls, and incident recovery. Do not include
real secrets or private nodem2 values beyond the already approved public host
fingerprint/config.

- [ ] **Step 11: Commit rollout documentation**

```bash
git add docs/05-USER-GUIDE.md packages/sync-server/README.md deploy/nodem2/README.md
git commit -m "docs(operations): document nodem2 cloud administration"
```

- [ ] **Step 12: Final evidence**

```bash
pnpm -r build
pnpm -r test
git status --short
git --no-pager log --oneline --decorate -15
```

Record the deployed Git SHA, safety backup basename, latest verified backup,
service states, dashboard URL `http://127.0.0.1:14300/admin`, and any deferred
non-blocking issue in the final handoff.
