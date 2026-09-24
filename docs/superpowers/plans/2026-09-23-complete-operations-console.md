# Complete Ariadne Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the deployed Ariadne dashboard with member administration, full operational status, guarded restore/restart/deploy/rollback/delete controls, fixed-source logs, immutable audit history, browser-quality tests, and a safety-backup-first nodem2 rollout.

**Architecture:** Extend the existing React dashboard and same-origin admin API. Read-only host/service/deployment/log facts and privileged mutations cross the root-owned Unix socket through strict typed operator protocols; the browser never receives arbitrary command, path, service, Git ref, or journal inputs. All mutations remain session-, Origin-, and CSRF-protected, with recent password reauthentication, exact confirmations, durable operation state, serialization, and append-only audit records for destructive actions.

**Tech Stack:** React 19, TypeScript 5.5, Vite 6, Express 4, PostgreSQL 16, Zod, Vitest, React Testing Library, axe-core, Playwright, Node.js Unix sockets, Docker Compose, systemd.

**Spec:** `docs/superpowers/specs/2026-09-23-complete-operations-console-design.md`

## Global Constraints

- Exactly one active singleton-team administrator can use `/api/v1/admin/*`.
- The browser uses the existing database-backed HttpOnly session and keeps the rotated CSRF token only in React memory.
- Every browser mutation requires the configured `Origin` and `X-CSRF-Token`.
- Destructive actions require password reauthentication no older than five minutes and an exact confirmation value.
- The sync-server container receives neither the Docker socket nor arbitrary shell access.
- The operator accepts only discriminated typed requests over `/run/ariadne/operator.sock`.
- Operator execution remains single-slot; incompatible concurrent requests return `operator_busy`.
- File contents remain escaped, read-only, `Cache-Control: no-store`, and absent from persistent browser storage.
- Log sources are exactly `sync-server`, `operator`, `deployment`, and `backup`; callers cannot supply unit names, paths, journal expressions, or output fields.
- Deployment inputs are immutable 40-character lowercase commit SHAs returned by deployment status; callers cannot supply branches, commands, paths, images, or Git expressions.
- Backup restore accepts only a recorded verified basename and creates a fresh verified safety backup before changing production data.
- All new TypeScript uses explicit exported types, `unknown` narrowing, immutable updates, and no `any`.
- Follow RED → GREEN → IMPROVE for every task; add a regression test before every implementation fix.

---

### Task 1: Typed Operator Read Protocol

**Files:**
- Create: `packages/operator/src/queryProtocol.ts`
- Create: `packages/operator/src/queryExecutor.ts`
- Create: `packages/operator/test/queryProtocol.test.ts`
- Create: `packages/operator/test/queryExecutor.test.ts`
- Create: `deploy/nodem2/scripts/status`
- Create: `deploy/nodem2/scripts/deployment-status`
- Modify: `packages/operator/src/server.ts`
- Modify: `packages/operator/test/server.test.ts`
- Modify: `packages/operator/src/index.ts`
- Modify: `deploy/nodem2/scripts/install`
- Modify: `deploy/nodem2/test/install.test.ts`

**Interfaces:**
- Consumes: existing operator Unix-socket server and fixed nodem2 script/unit names.
- Produces:

```ts
export type OperatorLogSource = 'sync-server' | 'operator' | 'deployment' | 'backup';
export type OperatorLogSeverity = 'error' | 'warning' | 'info';

export type OperatorQuery =
  | { type: 'host_metrics' }
  | { type: 'service_status' }
  | { type: 'deployment_status' }
  | { type: 'backup_read'; backupName: string }
  | {
      type: 'logs_read';
      source: OperatorLogSource;
      cursor?: string;
      limit: number;
      severity?: OperatorLogSeverity;
      since?: string;
    };

export interface HostMetricsResult {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  filesystemUsedBytes: number;
  filesystemTotalBytes: number;
}

export interface ServiceStatusResult {
  services: Array<{
    name: 'sync-server' | 'operator' | 'postgres';
    state: 'running' | 'stopped' | 'failed' | 'unavailable';
    detail?: string;
  }>;
}

export interface DeploymentStatusResult {
  currentRevision: string;
  rollbackRevision: string | null;
  schemaVersion: number;
  candidates: Array<{ revision: string; committedAt: string; subject: string }>;
}

export interface LogsReadResult {
  entries: Array<{
    sequence: number;
    timestamp: string;
    severity: OperatorLogSeverity;
    message: string;
    redacted: boolean;
  }>;
  nextCursor: string | null;
}

export interface BackupReadResult {
  filename: string;
  sha256: string;
  sizeBytes: number;
  stream: NodeJS.ReadableStream;
}

export type OperatorQueryResult =
  | { type: 'host_metrics'; value: HostMetricsResult }
  | { type: 'service_status'; value: ServiceStatusResult }
  | { type: 'deployment_status'; value: DeploymentStatusResult }
  | { type: 'logs_read'; value: LogsReadResult }
  | { type: 'backup_read'; value: BackupReadResult };

export interface OperatorQueryExecutor {
  execute(query: OperatorQuery): Promise<OperatorQueryResult>;
}
```

- The server exposes `POST /v1/queries`; operation submission remains `POST /v1/operations`.

- [ ] **Step 1: Write strict query-schema tests**

Add table-driven tests that accept only the five query variants above and reject unknown keys, path-bearing backup names, limits outside `1..500`, malformed RFC 3339 `since`, arbitrary log sources, unit names, paths, and journal expressions.

```ts
it('rejects caller-selected journal units', () => {
  expect(() =>
    parseOperatorQuery({
      type: 'logs_read',
      source: 'sync-server',
      unit: 'ssh.service',
      limit: 100,
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run test/queryProtocol.test.ts
```

Expected: FAIL because `queryProtocol.ts` and `parseOperatorQuery` do not exist.

- [ ] **Step 3: Implement the strict discriminated query schema**

Use `.strict()` Zod objects. Validate backup names with the same cross-platform basename rule used by `protocol.ts`. Encode log cursors as opaque base64url JSON containing only `{ timestamp, sequence }`; reject decoded values that do not match that exact shape.

- [ ] **Step 4: Write failing fixed-source executor tests**

Inject filesystem, process-spawn, and clock implementations. Cover:

- `/proc` host metrics and filesystem totals;
- `systemctl show` for exactly `ariadne-operator.service`;
- Docker Compose status through the tracked `/usr/local/lib/ariadne/status` script;
- deployment status through `/usr/local/lib/ariadne/deployment-status`;
- journal reads mapped internally from the four fixed sources;
- ANSI stripping, secret redaction, line truncation, response byte cap, cursor generation;
- verified backup streaming metadata without exposing its path;
- timeout, non-zero exit, malformed JSON, and unavailable-source errors.

```ts
it('maps the backup source to a fixed command without caller arguments', async () => {
  await executor.execute({ type: 'logs_read', source: 'backup', limit: 100 });
  expect(spawn).toHaveBeenCalledWith(
    '/usr/bin/journalctl',
    expect.arrayContaining(['--unit', 'ariadne-backup.service']),
    expect.objectContaining({ shell: false }),
  );
});
```

- [ ] **Step 5: Run executor tests and verify RED**

Run:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run test/queryExecutor.test.ts
```

Expected: FAIL because `createOperatorQueryExecutor` does not exist.

- [ ] **Step 6: Implement bounded query execution**

Use fixed command arrays, `shell: false`, the executor's sanitized environment, a 10-second read timeout, a 256 KiB response cap, and explicit typed errors. Return normalized JSON facts; never return internal paths or raw stderr. For `backup_read`, return an opened readable stream plus recorded filename, checksum, and size only after checksum/metadata validation.

- [ ] **Step 7: Write failing tracked-script contract tests**

Extend `deploy/nodem2/test/install.test.ts` to require installation of
`status` and `deployment-status` as root-owned mode `0755`. Execute both
scripts against stubbed `systemctl`, `docker`, `git`, and `psql` binaries and
assert strict JSON output:

```ts
expect(status).toEqual({
  services: [
    { name: 'sync-server', state: 'running' },
    { name: 'operator', state: 'running' },
    { name: 'postgres', state: 'running' },
  ],
});
expect(deployment).toMatchObject({
  currentRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
  rollbackRevision: null,
  schemaVersion: 10,
  candidates: expect.any(Array),
});
```

- [ ] **Step 8: Implement tracked read scripts**

`status` reads only the fixed Ariadne systemd/Compose services. `deployment-status`
reads `/opt/ariadne/worktree`, the configured trusted remote/ref, the recorded
rollback file, and schema version; it emits at most 20 reachable immutable
candidate SHAs. Both scripts use `set -euo pipefail`, fixed paths from
`lib-common`, and JSON escaping helpers; neither evaluates caller input.

- [ ] **Step 9: Add `/v1/queries` server tests**

Cover JSON responses, backup streaming headers, client abort cleanup, `400` invalid query, `404` unknown path, `503` unavailable dependency, and ensure query handling does not reserve the mutation admission slot.

- [ ] **Step 10: Implement and wire the query endpoint**

Parse the request body with `parseOperatorQuery`, call `OperatorQueryExecutor`, and stream backups with backpressure. Keep socket peer-credential checks and body-size limits identical to the existing operation endpoint.

- [ ] **Step 11: Run operator validation**

```bash
pnpm --filter @ariadne-dev/operator build
pnpm --filter @ariadne-dev/operator exec vitest run test/queryProtocol.test.ts test/queryExecutor.test.ts test/server.test.ts
pnpm exec vitest run deploy/nodem2/test/install.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/operator/src/queryProtocol.ts packages/operator/src/queryExecutor.ts packages/operator/src/server.ts packages/operator/src/index.ts packages/operator/test/queryProtocol.test.ts packages/operator/test/queryExecutor.test.ts packages/operator/test/server.test.ts deploy/nodem2/scripts/status deploy/nodem2/scripts/deployment-status deploy/nodem2/scripts/install deploy/nodem2/test/install.test.ts
git commit -m "feat(operator): add bounded status queries"
```

### Task 2: Complete Admin Read APIs

**Files:**
- Create: `packages/sync-server/src/operatorQueryClient.ts`
- Create: `packages/sync-server/src/routes/adminMembers.ts`
- Create: `packages/sync-server/src/routes/adminAudit.ts`
- Create: `packages/sync-server/src/routes/adminDeployments.ts`
- Create: `packages/sync-server/src/routes/adminBackups.ts`
- Create: `packages/sync-server/src/routes/adminLogs.ts`
- Create: `packages/sync-server/test/adminCompleteRead.test.ts`
- Modify: `packages/sync-server/src/routes/adminRead.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/src/operationsStore.ts`
- Modify: `packages/sync-server/test/operatorClient.test.ts`

**Interfaces:**
- Consumes: `OperatorQuery` and normalized results from Task 1.
- Produces:
  - `GET /api/v1/admin/overview`
  - `GET /api/v1/admin/members`
  - `GET /api/v1/admin/backups?limit=`
  - `GET /api/v1/admin/backups/:name/download`
  - `GET /api/v1/admin/services`
  - `GET /api/v1/admin/deployments`
  - `GET /api/v1/admin/logs?source=&cursor=&limit=&severity=&since=`
  - `GET /api/v1/admin/audit?cursor=&limit=&action=&outcome=`

```ts
export interface OperatorQueryClient {
  query(
    request: Exclude<OperatorQuery, { type: 'backup_read' }>,
  ): Promise<HostMetricsResult | ServiceStatusResult | DeploymentStatusResult | LogsReadResult>;
  downloadBackup(
    backupName: string,
    signal: AbortSignal,
  ): Promise<OperatorBackupDownload>;
}

export interface OperatorBackupDownload {
  filename: string;
  sha256: string;
  sizeBytes: number;
  stream: NodeJS.ReadableStream;
}
```

- [ ] **Step 1: Write failing operator-query client tests**

Mirror the existing operation client's transport tests. Cover timeout, response cap, invalid discriminant, fixed path `/v1/queries`, path-free errors, stream abort, and checksum/size header validation.

- [ ] **Step 2: Run the client tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/operatorClient.test.ts
```

Expected: FAIL on the new query-client cases.

- [ ] **Step 3: Implement `operatorQueryClient.ts`**

Reuse transport classification helpers where possible without merging mutation and query interfaces. Query JSON with bounded buffering; stream backup downloads without buffering the dump in memory.

- [ ] **Step 4: Write failing read-route integration tests**

Using the existing real-PostgreSQL harness, cover:

- overview host/database/task/member/sync/backup/operation summaries;
- explicit partial operator errors while database-backed summaries remain visible;
- active/inactive member rows with immutable admin marker;
- verified backup download only, attachment headers, size cap, abort cleanup;
- services and deployment state;
- fixed log source, severity, time, cursor, limit `1..500`, ANSI-free redacted output;
- audit cursor/filter behavior and operation linkage;
- `Cache-Control: no-store` on every response;
- database failure returning `503`, not a fake empty response.

```ts
it('keeps database facts while reporting operator metrics unavailable', async () => {
  const response = await adminRequest('/api/v1/admin/overview');
  expect(response.status).toBe(200);
  expect(response.body.tasks.total).toBe(1);
  expect(response.body.components.operator).toEqual({
    healthy: false,
    code: 'operator_unavailable',
  });
});
```

- [ ] **Step 5: Run route tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/adminCompleteRead.test.ts
```

Expected: FAIL because the complete routes and fields do not exist.

- [ ] **Step 6: Add cursor-capable store reads**

Extend `OperationsStore` with typed methods:

```ts
listAuditEvents(input: {
  afterId?: number;
  limit: number;
  action?: string;
  outcome?: string;
}): Promise<{ events: AdminAuditEvent[]; nextCursor: string | null }>;

listOperations(input: {
  afterCreatedAt?: string;
  limit: number;
}): Promise<{ operations: AdminOperation[]; nextCursor: string | null }>;
```

Use parameterized queries and stable `(created_at, id)` ordering. Update existing callers and tests rather than retaining two ambiguous overloads.

- [ ] **Step 7: Implement focused read routers**

Split `adminRead.ts` so each file owns one resource. Aggregate overview sources with per-source timeouts. Validate all query parameters with strict Zod schemas. Member reads query the singleton team directly. Backup download first verifies the database record is currently `verified`, then requests the exact basename from the operator query client.

- [ ] **Step 8: Wire routes before dashboard static fallback**

Mount all routers behind `requireAdminSession`. Preserve the unauthenticated operator callback ordering and existing admin auth ordering in `app.ts`.

- [ ] **Step 9: Run sync-server validation**

```bash
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run test/adminCompleteRead.test.ts test/adminRead.test.ts test/operatorClient.test.ts test/routes.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/sync-server/src/operatorQueryClient.ts packages/sync-server/src/routes/adminMembers.ts packages/sync-server/src/routes/adminAudit.ts packages/sync-server/src/routes/adminDeployments.ts packages/sync-server/src/routes/adminBackups.ts packages/sync-server/src/routes/adminLogs.ts packages/sync-server/src/routes/adminRead.ts packages/sync-server/src/app.ts packages/sync-server/src/operationsStore.ts packages/sync-server/test/adminCompleteRead.test.ts packages/sync-server/test/operatorClient.test.ts
git commit -m "feat(admin): expose complete console data"
```

### Task 3: Guarded Mutations and Rollback

**Files:**
- Create: `packages/sync-server/migrations/0010_complete_admin_operations.sql`
- Create: `packages/sync-server/src/operationConfirmation.ts`
- Create: `packages/sync-server/test/adminCompleteOperations.test.ts`
- Create: `deploy/nodem2/scripts/rollback`
- Modify: `packages/operator/src/protocol.ts`
- Modify: `packages/operator/src/executor.ts`
- Modify: `packages/operator/test/protocol.test.ts`
- Modify: `packages/operator/test/executor.test.ts`
- Modify: `packages/sync-server/src/operatorClient.ts`
- Modify: `packages/sync-server/src/operationsStore.ts`
- Modify: `packages/sync-server/src/routes/adminOperations.ts`
- Modify: `packages/sync-server/src/routes/adminTasks.ts`
- Modify: `packages/sync-server/src/routes/adminMembers.ts`
- Modify: `packages/sync-server/test/migrate.test.ts`
- Modify: `deploy/nodem2/scripts/install`
- Modify: `deploy/nodem2/test/install.test.ts`
- Modify: `deploy/nodem2/test/deploy.test.ts`

**Interfaces:**
- Produces operation types `deployment_rollback` and `file_capture_delete`.
- Produces mutation routes:
  - `PATCH /api/v1/admin/members/:userId` body `{ active, confirmation }`
  - `DELETE /api/v1/admin/tasks/:taskId/file-captures/:captureId` body `{ confirmation }`
  - `POST /api/v1/admin/operations/service-restart` body `{ service, confirmation }`
  - `POST /api/v1/admin/operations/deploy` body `{ revision, confirmation }`
  - `POST /api/v1/admin/operations/rollback` body `{ revision, confirmation }`
  - existing backup create/verify routes;
  - restore body `{ confirmation }`.

```ts
export type OperatorSubmitRequest =
  | { operationId: string; type: 'service_restart'; service: 'sync-server' | 'postgres' }
  | { operationId: string; type: 'deployment_apply'; revision: string }
  | { operationId: string; type: 'deployment_rollback'; revision: string }
  | { operationId: string; type: 'backup_create' }
  | { operationId: string; type: 'backup_verify'; backupName: string }
  | { operationId: string; type: 'backup_restore'; backupName: string };
```

- [ ] **Step 1: Write migration tests**

Assert migration 0010 accepts the two new operation types, preserves existing operation and audit rows, and remains idempotent through the migration runner.

- [ ] **Step 2: Run migration test and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts
```

Expected: FAIL because migration 0010 does not exist.

- [ ] **Step 3: Add migration 0010**

Update the operation type constraint without rewriting existing rows. Add indexes required by cursor reads only if `EXPLAIN` confirms the current indexes do not cover `(created_at, id)`.

- [ ] **Step 4: Write failing confirmation and authorization tests**

Cover exact values:

```ts
confirmationFor.serviceRestart('postgres') === 'RESTART postgres'
confirmationFor.restore('ariadne-20260923T094609Z.dump') ===
  'RESTORE ariadne-20260923T094609Z.dump'
confirmationFor.deploy(sha) === `DEPLOY ${sha}`
confirmationFor.rollback(sha) === `ROLLBACK ${sha}`
confirmationFor.captureDelete(captureId) === `DELETE ${captureId}`
confirmationFor.memberState('alice', false) === 'DEACTIVATE alice'
```

Also cover stale reauthentication, admin mutation rejection, inactive member handling, unverified restore, revision not returned by deployment status, rollback revision mismatch, operator busy, and audit metadata containing IDs but no plaintext file data or credentials.

- [ ] **Step 5: Run mutation tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/adminCompleteOperations.test.ts
```

Expected: FAIL on missing guards and routes.

- [ ] **Step 6: Implement confirmation helpers and guarded member mutation**

Compare exact UTF-8 strings. Member mutation may change only `active` on a `role='member'` row in the singleton team. Record `member.activate` or `member.deactivate` audit events in the same transaction.

- [ ] **Step 7: Implement durable capture deletion**

Create the operation row, transition it to running, call the existing transactional task-history deletion store, then transition succeeded or failed with sanitized metadata. Return `202 { accepted, operation }`; never return deleted plaintext.

- [ ] **Step 8: Extend operator rollback protocol test-first**

Add `deployment_rollback` with the same strict SHA validation as apply. Map it to `/usr/local/lib/ariadne/rollback <sha>` using `shell: false`. Add executor and server tests before implementation.

- [ ] **Step 9: Write the tracked rollback script test-first**

Add deploy harness tests proving that `rollback` rejects a SHA other than the
recorded rollback revision, takes and verifies a fresh safety backup, checks out
only the recorded immutable SHA, builds/runs migrations through the tracked
Compose file, restores service health, and preserves both failed and previous
artifacts on error.

- [ ] **Step 10: Implement and install `rollback`**

Use the same lock, backup, migration, and health helpers as `deploy`. Read the
eligible revision from the root-owned rollback record, compare it exactly to
the validated SHA argument, and write the new current/rollback records only
after health succeeds. Install it as root-owned mode `0755`.

- [ ] **Step 11: Enforce restore/deploy/restart eligibility**

Before creating an operator operation:

- restore requires a current `verified` backup record;
- deploy requires the SHA in the latest deployment-status candidates;
- rollback requires the exact eligible rollback SHA;
- service restart accepts only `sync-server` or `postgres`;
- all destructive requests require exact confirmation and recent reauthentication.

Create the queued operation before operator submission, retaining the existing uncertain-submission behavior.

- [ ] **Step 12: Run mutation validation**

```bash
pnpm --filter @ariadne-dev/operator build
pnpm --filter @ariadne-dev/operator exec vitest run test/protocol.test.ts test/executor.test.ts test/server.test.ts
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts test/adminCompleteOperations.test.ts test/operationsStore.test.ts test/routes.test.ts
pnpm exec vitest run deploy/nodem2/test/install.test.ts deploy/nodem2/test/deploy.test.ts
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/operator packages/sync-server/migrations/0010_complete_admin_operations.sql packages/sync-server/src/operationConfirmation.ts packages/sync-server/src/operatorClient.ts packages/sync-server/src/operationsStore.ts packages/sync-server/src/routes/adminOperations.ts packages/sync-server/src/routes/adminTasks.ts packages/sync-server/src/routes/adminMembers.ts packages/sync-server/test deploy/nodem2/scripts/rollback deploy/nodem2/scripts/install deploy/nodem2/test/install.test.ts deploy/nodem2/test/deploy.test.ts
git commit -m "feat(admin): guard destructive console actions"
```

### Task 4: Typed Dashboard Foundation

**Files:**
- Create: `packages/dashboard/src/api/types.ts`
- Create: `packages/dashboard/src/api/guards.ts`
- Create: `packages/dashboard/src/auth/AuthProvider.tsx`
- Create: `packages/dashboard/src/auth/LoginPage.tsx`
- Create: `packages/dashboard/src/components/AsyncState.tsx`
- Create: `packages/dashboard/src/components/ConfirmationDialog.tsx`
- Create: `packages/dashboard/src/components/OperationProgress.tsx`
- Create: `packages/dashboard/src/components/StatusLabel.tsx`
- Create: `packages/dashboard/src/hooks/useOperation.ts`
- Create: `packages/dashboard/src/auth/AuthProvider.test.tsx`
- Create: `packages/dashboard/src/components/ConfirmationDialog.test.tsx`
- Modify: `packages/dashboard/src/api/client.ts`
- Modify: `packages/dashboard/src/auth/usePrivilegedAction.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/App.test.tsx`

**Interfaces:**

```ts
export interface AdminApiClient {
  get<T>(path: string, guard: Guard<T>, signal?: AbortSignal): Promise<T>;
  mutate<T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: Record<string, unknown>,
    guard: Guard<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  download(path: string, signal?: AbortSignal): Promise<Blob>;
}

export type Guard<T> = (value: unknown) => value is T;

export interface ConfirmationRequest {
  title: string;
  impact: string;
  expectedConfirmation: string;
  confirmationLabel: string;
  requiresReauthentication: boolean;
}
```

- [ ] **Step 1: Write failing client/auth/component tests**

Cover runtime rejection of malformed JSON, CSRF on mutations only, abort propagation, download errors, session restore token rotation, expired-session logout, focus entering and returning from dialogs, exact confirmation matching, password held only in component state, and operation reconnection after remount.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth/AuthProvider.test.tsx src/components/ConfirmationDialog.test.tsx src/App.test.tsx
```

Expected: FAIL because the typed foundation does not exist.

- [ ] **Step 3: Implement runtime response guards**

Define named interfaces and guards for sessions, overview, members, tasks, captures, backups, services, deployments, logs, audit events, and operations. A malformed response throws `AdminApiError('invalid_response')`; no guard may silently default a missing field.

- [ ] **Step 4: Implement `AuthProvider` and strict API client**

Keep CSRF in provider memory. Convert `401` to a single session-expired transition. Convert `403 reauthentication_required` into the existing privileged-action flow. Do not write session, CSRF, or password values to localStorage, sessionStorage, URLs, logs, or error messages.

- [ ] **Step 5: Implement shared state and confirmation components**

`AsyncState` renders loading, empty, partial failure, and hard failure explicitly. `ConfirmationDialog` requires exact confirmation and optionally password reauthentication before invoking the pending action. `OperationProgress` subscribes to SSE, falls back to bounded polling after disconnect, and fetches the persisted operation after terminal events.

- [ ] **Step 6: Refactor `App.tsx` into composition**

Move login/auth logic out of `App.tsx`; add navigation IDs:

```ts
type Section =
  | 'overview'
  | 'members'
  | 'tasks'
  | 'backups'
  | 'services'
  | 'deployments'
  | 'logs'
  | 'audit';
```

Keep the existing command-center shell and skip link.

- [ ] **Step 7: Run dashboard foundation validation**

```bash
pnpm --filter @ariadne-dev/dashboard build
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth src/components src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard/src/api packages/dashboard/src/auth packages/dashboard/src/components packages/dashboard/src/hooks packages/dashboard/src/App.tsx packages/dashboard/src/App.test.tsx
git commit -m "refactor(dashboard): add typed admin foundation"
```

### Task 5: Complete Overview and Member Management

**Files:**
- Create: `packages/dashboard/src/overview/OverviewPage.tsx`
- Create: `packages/dashboard/src/overview/OverviewPage.test.tsx`
- Create: `packages/dashboard/src/members/MembersPage.tsx`
- Create: `packages/dashboard/src/members/MembersPage.test.tsx`
- Modify: `packages/dashboard/src/operations/OverviewPage.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/styles/global.css`

**Interfaces:**
- Consumes: typed overview/member APIs and shared confirmation flow from Task 4.
- Produces: status-first Overview and guarded Members pages.

- [ ] **Step 1: Write failing overview tests**

Cover healthy, stale backup, failed operation, database hard failure, operator partial failure, loading, refresh, tab-hidden polling pause, absolute/relative timestamps, and the priority ordering failures → services → backup → operations → counts.

- [ ] **Step 2: Write failing member tests**

Cover active/inactive members, immutable admin row, activate/deactivate confirmation text, stale reauthentication, disabled duplicate submission, failed mutation preserving previous state, and refreshed server state after success.

- [ ] **Step 3: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/overview src/members
```

Expected: FAIL because the complete pages do not exist.

- [ ] **Step 4: Implement status-first overview**

Poll every 30 seconds only when `document.visibilityState === 'visible'`; abort prior requests on refresh/unmount. Render host/database metrics as compact operational rows with explicit units and freshness, not charts.

- [ ] **Step 5: Implement member management**

Render username, role, active state, joined date, and one action. Never render an admin action button. After mutation, refetch the list; do not apply an optimistic membership change.

- [ ] **Step 6: Integrate navigation and responsive styles**

At narrow widths, stack status groups and convert the member table to labeled rows without hiding role/state/action information.

- [ ] **Step 7: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/overview src/members src/App.test.tsx
git add packages/dashboard/src/overview packages/dashboard/src/members packages/dashboard/src/operations/OverviewPage.tsx packages/dashboard/src/App.tsx packages/dashboard/src/styles/global.css
git commit -m "feat(dashboard): add status and member administration"
```

### Task 6: Guarded Task Capture Deletion

**Files:**
- Create: `packages/dashboard/src/tasks/CaptureDeleteDialog.tsx`
- Modify: `packages/dashboard/src/tasks/TasksPage.tsx`
- Modify: `packages/dashboard/src/tasks/TasksPage.test.tsx`
- Modify: `packages/dashboard/src/styles/global.css`

**Interfaces:**
- Consumes: `DELETE /api/v1/admin/tasks/:taskId/file-captures/:captureId`.
- Produces: capture deletion followed by durable operation progress and task refresh.

- [ ] **Step 1: Write failing component tests**

Cover delete visibility only for a selected capture, affected-path preview, exact `DELETE <captureId>` confirmation, password reauthentication, queued/running/succeeded/failed operation states, cancellation, task change aborting the pending request, and removal only after server refresh confirms deletion.

- [ ] **Step 2: Run task tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks/TasksPage.test.tsx
```

Expected: FAIL because delete controls do not exist.

- [ ] **Step 3: Implement capture deletion**

Reuse `ConfirmationDialog` and `OperationProgress`. Clear snapshot/diff plaintext from component state immediately when deletion succeeds or the selected task changes. Refetch the timeline and preserve the task selection when possible.

- [ ] **Step 4: Add responsive and keyboard behavior**

Focus the next available capture after deletion. On mobile, return to the timeline pane with a success status rather than leaving an empty inspector.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks
git add packages/dashboard/src/tasks packages/dashboard/src/styles/global.css
git commit -m "feat(dashboard): add guarded capture deletion"
```

### Task 7: Complete Operations Pages

**Files:**
- Create: `packages/dashboard/src/operations/DeploymentsPage.tsx`
- Create: `packages/dashboard/src/operations/AuditPage.tsx`
- Create: `packages/dashboard/src/operations/DeploymentsPage.test.tsx`
- Create: `packages/dashboard/src/operations/AuditPage.test.tsx`
- Modify: `packages/dashboard/src/operations/BackupsPage.tsx`
- Modify: `packages/dashboard/src/operations/ServicesPage.tsx`
- Modify: `packages/dashboard/src/operations/LogsPage.tsx`
- Modify: `packages/dashboard/src/operations/OperationsPages.test.tsx`
- Modify: `packages/dashboard/src/App.tsx`
- Modify: `packages/dashboard/src/styles/global.css`

**Interfaces:**
- Consumes: complete read/mutation APIs from Tasks 2 and 3.
- Produces: backup download/restore, PostgreSQL restart, deploy/rollback, fixed-source logs, and immutable audit UI.

- [ ] **Step 1: Write failing backup/service tests**

Cover backup eligibility explanations, create, verify, browser download filename, restore confirmation, stale reauthentication, operation reconnection, sync-server restart, PostgreSQL restart, operator unavailable, busy conflict, and terminal failure details.

- [ ] **Step 2: Write failing deployment/log/audit tests**

Cover candidate SHA selection only, current/rollback markers, exact deploy/rollback confirmation, no free-form ref input, migration/health progress, fixed four-source logs, severity/time filters, opaque load-more cursor, pause/resume, client text filter, ANSI-free text, redaction marker, audit action/outcome filters, pagination, and operation links.

- [ ] **Step 3: Run operations tests and verify RED**

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/operations
```

Expected: FAIL on the deferred controls and pages.

- [ ] **Step 4: Complete backups**

Add download through the typed client using `URL.createObjectURL`, a temporary `<a download>`, and guaranteed URL revocation. Restore requires the exact backup basename and displays the fresh safety-backup, migration, restart, and health phases from operation events.

- [ ] **Step 5: Complete services**

Expose restart only for sync-server and PostgreSQL. Show the operator as read-only. Disable both restart controls when another operation is active and display the server-provided conflict reason.

- [ ] **Step 6: Implement deployments**

Render current revision, rollback revision, schema version, candidate SHAs, and recent deployments. Accept only a selected candidate object returned by the API. Deploy and rollback use shared confirmation/progress components.

- [ ] **Step 7: Complete logs and audit**

Use server-side source/severity/time filters and cursor pagination. Keep client text filtering limited to already-loaded lines. Audit rows show timestamp, actor, action, outcome, target summary, and an operation link when `metadata.operationId` exists.

- [ ] **Step 8: Finish responsive operations layout**

At 360 px, filters become a labeled vertical control group, tables become semantic labeled rows, long SHAs remain copyable without horizontal page overflow, and dialogs fit within the viewport.

- [ ] **Step 9: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/dashboard build
pnpm --filter @ariadne-dev/dashboard exec vitest run src/operations src/App.test.tsx
git add packages/dashboard/src/operations packages/dashboard/src/App.tsx packages/dashboard/src/styles/global.css
git commit -m "feat(dashboard): complete operational controls"
```

### Task 8: Browser, Accessibility, and Responsive Finish Gate

**Files:**
- Create: `packages/dashboard/playwright.config.ts`
- Create: `packages/dashboard/e2e/fixtures.ts`
- Create: `packages/dashboard/e2e/admin-console.spec.ts`
- Create: `packages/dashboard/e2e/accessibility.spec.ts`
- Create: `packages/dashboard/e2e/responsive.spec.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `packages/dashboard/src/test/setup.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: complete console from Tasks 4–7 and isolated test PostgreSQL/fake operator fixtures.
- Produces: `pnpm --filter @ariadne-dev/dashboard run test:e2e`.

- [ ] **Step 1: Add browser test dependencies**

Add `@playwright/test`, `axe-core`, and `vitest-axe` as dev dependencies. Add scripts:

```json
{
  "test:e2e": "playwright test",
  "test:e2e:headed": "playwright test --headed"
}
```

- [ ] **Step 2: Create deterministic fixtures**

Start the sync server against an isolated PostgreSQL database and fake operator Unix socket. Seed one admin, one mutable member, one task with mixed timeline events, one encrypted capture, one verified backup, deployment candidates, fixed logs, and audit rows. The fake operator must emit queued → running → succeeded/failed callbacks and support reconnect.

- [ ] **Step 3: Write critical-flow Playwright tests**

Cover:

1. login, session restore, and logout;
2. overview partial failure without losing database facts;
3. member deactivate/activate round trip;
4. task snapshot/diff with script text remaining inert;
5. capture deletion confirmation and refresh;
6. backup create/verify/download and guarded restore;
7. sync-server/PostgreSQL restart with reconnect;
8. deploy and rollback from server-returned SHAs;
9. log/audit filters and pagination;
10. session expiry and password reauthentication.

- [ ] **Step 4: Write accessibility tests**

Run axe after each primary page loads. Assert skip-link behavior, landmark names, dialog focus trap/return, error-summary focus, visible focus styles, table/row labels, and status text not conveyed by color alone.

- [ ] **Step 5: Write responsive tests**

Test `360x800`, `768x1024`, and `1440x900`. Assert no document-level horizontal overflow, reachable primary actions, structural pane stacking, and dialogs fully visible.

- [ ] **Step 6: Run RED, then fix UI defects**

```bash
pnpm install
pnpm --filter @ariadne-dev/dashboard exec playwright install chromium
pnpm --filter @ariadne-dev/dashboard run test:e2e
```

For each failure, add or retain the failing browser/component assertion, implement the smallest correction, and rerun the affected spec.

- [ ] **Step 7: Run the UI finish gate**

Invoke `anti-ui-slop`, React Reviewer, and TypeScript Reviewer. Fix all high-confidence accessibility, hook, render, boundary, overflow, focus, and generic-UI findings test-first.

- [ ] **Step 8: Commit**

```bash
git add packages/dashboard pnpm-lock.yaml
git commit -m "test(dashboard): finish critical browser flows"
```

### Task 9: Documentation and Full Review Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/05-USER-GUIDE.md`
- Modify: `docs/07-CLOUD-SYNC-API-CONTRACT.md`
- Modify: `packages/sync-server/README.md`
- Create: `packages/operator/README.md`
- Create: `deploy/nodem2/README.md`
- Modify: `.github/skills/ariadne/SKILL.md`
- Modify: `packages/cli/src/skillTemplates.ts`
- Modify: `packages/cli/test/skillTemplates.test.ts`

**Interfaces:**
- Produces: operator/admin API documentation and generated Copilot guidance matching the implementation.

- [ ] **Step 1: Add failing generated-guidance tests**

Assert generated guidance includes `/admin`, `ariadne sync setup`, fixed guarded operations, backup-before-restore/deploy, no secret display, no arbitrary shell, and the `127.0.0.1:14300` tunnel URL.

- [ ] **Step 2: Run guidance tests and verify RED**

```bash
pnpm --filter @ariadne-dev/cli exec vitest run test/skillTemplates.test.ts
```

Expected: FAIL on the new guidance requirements.

- [ ] **Step 3: Update generated guidance and documentation**

Document each dashboard page, exact confirmation behavior, backup eligibility, restore/deploy/rollback safety, fixed log sources, credential retrieval without embedding a password, expected timers/services, and rollback procedure.

- [ ] **Step 4: Run all local validation**

```bash
pnpm -r build
pnpm -r test
pnpm --filter @ariadne-dev/dashboard run test:e2e
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example config --quiet
systemd-analyze verify deploy/nodem2/systemd/*.service deploy/nodem2/systemd/*.timer
git diff --check
```

Expected: all commands succeed.

- [ ] **Step 5: Build the real production image**

```bash
docker build --file deploy/nodem2/sync-server.Dockerfile --tag ariadne-sync-server:complete-console .
```

Expected: image build succeeds and `/app/dashboard/index.html` exists in the runtime image.

- [ ] **Step 6: Run mandatory reviews**

Invoke React Reviewer, TypeScript Reviewer, Security Reviewer, Silent Failure Hunter, and code review. Explicitly inspect CSRF/Origin/session fixation, reauthentication, confirmations, XSS/CSP, decrypted-content lifetime, backup streaming, revision validation, operator query inputs, log redaction, operation/audit completeness, timeout/error propagation, and rollback safety.

- [ ] **Step 7: Fix accepted findings test-first**

For each accepted issue, add a focused regression test, reproduce the failure, implement one fix, rerun the focused suite, then rerun Step 4.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/05-USER-GUIDE.md docs/07-CLOUD-SYNC-API-CONTRACT.md packages/sync-server/README.md packages/operator/README.md deploy/nodem2/README.md .github/skills/ariadne/SKILL.md packages/cli/src/skillTemplates.ts packages/cli/test/skillTemplates.test.ts packages/dashboard packages/sync-server packages/operator
git commit -m "docs(dashboard): document complete operations console"
```

### Task 10: Safety-Backup-First Nodem2 Rollout

**Files:**
- No source changes unless a rollout defect receives a failing regression test and a separate fix commit.

**Interfaces:**
- Consumes: reviewed production image and tracked deploy/operator scripts.
- Produces: live complete console at `http://127.0.0.1:14300/admin`.

- [ ] **Step 1: Record the pre-rollout state**

```bash
git rev-parse HEAD
git status --short
ssh root@nodem2 '
  systemctl is-active ariadne-operator.service
  systemctl is-active ariadne-backup.timer
  systemctl is-active ariadne-backup-verify.timer
  docker ps --format "{{.Names}} {{.Image}} {{.Status}}"
  ss -ltnp | grep -E ":(4300|5432|15432)\b" || true
'
```

Expected: local tree clean; current operator/timers active; current sync server and PostgreSQL healthy; only approved loopback listeners.

- [ ] **Step 2: Create and verify a fresh safety backup**

Run the tracked backup script through the operator workflow, verify its checksum and `pg_restore --list`, confirm root ownership and mode `0600`, and record the basename in the rollout checkpoint. Do not stop the current stack.

- [ ] **Step 3: Transfer the committed revision**

Create a Git bundle from the reviewed commit, transfer it to nodem2, fetch it into `/opt/ariadne/worktree`, and verify:

```bash
ssh root@nodem2 'cd /opt/ariadne/worktree && git rev-parse HEAD && git status --short'
```

Expected: exact reviewed SHA and clean tree.

- [ ] **Step 4: Build and migrate before cutover**

```bash
ssh root@nodem2 '
  cd /opt/ariadne/worktree &&
  pnpm --filter @ariadne-dev/operator build &&
  docker compose -f deploy/nodem2/compose.yaml -p ariadne-nodem2 \
    --env-file /etc/ariadne/compose.env build &&
  docker compose -f deploy/nodem2/compose.yaml -p ariadne-nodem2 \
    --env-file /etc/ariadne/compose.env run --rm migrate
'
```

Verify schema version `10`, task/member counts unchanged, exactly one active admin, and no null team IDs.

- [ ] **Step 5: Cut over with rollback artifacts preserved**

Restart the operator only after its build succeeds. Recreate the sync-server container with the reviewed image. Do not delete the previous image, old database container/volume, safety backup, or rollback revision.

- [ ] **Step 6: Verify all read surfaces through the tunnel**

At `http://127.0.0.1:14300/admin`, verify login and Overview, Members, Tasks, Backups, Services, Deployments, Logs, and Audit. Confirm file snapshot/diff content renders literally and no admin response is cached.

- [ ] **Step 7: Exercise guarded controls in safe order**

1. create and verify a backup;
2. download it and compare SHA-256;
3. restart sync-server and reconnect with a fresh session;
4. restart PostgreSQL and wait for database plus HTTP health;
5. run isolated restore verification, not a live production restore;
6. activate/deactivate a non-admin test member and restore its original state;
7. delete a test capture and confirm audit/blob-reference behavior;
8. deploy and roll back in the approved rollout harness using eligible SHAs.

Record each durable operation ID and terminal state without recording secrets.

- [ ] **Step 8: Verify persistence and boundaries**

Restart the Compose stack once. Confirm login, tasks, members, audit, backup records, and operation history persist. Confirm:

```bash
ssh root@nodem2 '
  systemctl is-active ariadne-operator.service
  systemctl is-active ariadne-backup.timer
  systemctl is-active ariadne-backup-verify.timer
  ss -ltnp | grep -E ":(4300|5432|15432)\b" || true
  docker inspect ariadne-nodem2-sync-server-1 \
    --format "{{json .Mounts}}"
'
```

Expected: operator/timers active; only `127.0.0.1:4300` and `127.0.0.1:15432`; no unintended `5432`; no Docker socket mount.

- [ ] **Step 9: Roll back on any acceptance failure**

If migration, health, login, persistence, or guarded-control acceptance fails, stop the new sync server, restore the previous tracked image/revision, restart the preserved previous services, verify `/healthz`, and retain all failed-operation evidence and backups. Do not delete the failed stack until root cause and regression tests exist.

- [ ] **Step 10: Record completion**

Record an Ariadne checkpoint containing the deployed SHA, safety/live backup basenames, schema version, service/timer/container/listener state, dashboard URL, tested operation IDs, preserved rollback artifacts, and any explicitly deferred defect. Mark the completion task done only after every acceptance check passes.
