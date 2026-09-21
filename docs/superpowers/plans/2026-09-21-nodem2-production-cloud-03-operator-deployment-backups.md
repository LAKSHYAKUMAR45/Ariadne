# Operator, Deployment, and Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nodem2 deployment reproducible and expose safe operational controls through a root-owned, allowlisted operator with automated daily backups and weekly restore verification.

**Architecture:** The sync server submits typed operations over a permission-restricted Unix socket. A separate root-owned Node service validates requests and invokes only fixed scripts/commands via `execFile`; it has no generic command endpoint. Compose runs PostgreSQL and the sync server, while systemd owns the operator and backup timers.

**Tech Stack:** TypeScript 5.5, Node.js HTTP/Unix sockets, PostgreSQL 16, Docker Compose v2, systemd, POSIX shell, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md`

## Global Constraints

- No Docker socket in the sync-server container.
- No arbitrary command, command arguments, path, environment, or script body from HTTP clients.
- Operator socket is root-owned and group-readable/writeable only by the sync-server service group.
- Every operation has a stable ID, actor, type, state, timestamps, sanitized output, and audit event.
- PostgreSQL and sync-server ports bind only to `127.0.0.1`.
- Secrets remain under `/etc/ariadne`; keys are never copied into DB backups.
- Deployment must preserve a rollback target and take a verified safety backup first.

---

### Task 1: Persist operational state and audit events

**Files:**
- Create: `packages/sync-server/migrations/0008_admin_operations.sql`
- Create: `packages/sync-server/src/operationsStore.ts`
- Create: `packages/sync-server/test/operationsStore.test.ts`
- Modify: `packages/sync-server/test/migrate.test.ts`

**Interfaces:**

```ts
export type AdminOperationType =
  | 'service_restart'
  | 'deployment_apply'
  | 'backup_create'
  | 'backup_verify'
  | 'backup_restore';

export type AdminOperationState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface AdminOperation {
  id: string;
  requestedBy: string;
  type: AdminOperationType;
  state: AdminOperationState;
  summary: string;
  output: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 1: Write failing migration/store tests**

Cover create, legal state transitions, illegal terminal-state transition,
output truncation/redaction, list ordering, and append-only audit events.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts test/operationsStore.test.ts
```

- [ ] **Step 3: Implement migration**

Create `admin_operations`, `admin_operation_events`, `admin_audit_events`, and
`backup_records`.
Use check constraints for type/state, foreign-key `requested_by`, JSONB event
metadata, and descending time indexes. `backup_records` stores filename,
SHA-256, size, created/verified timestamps, status, and restore verification
message—never backup bytes. `admin_audit_events` is append-only and stores
nullable actor (for failed login), action, sanitized metadata, source, outcome,
and timestamp.

- [ ] **Step 4: Implement repository**

Allow only:

```text
queued -> running -> succeeded|failed
queued -> failed
```

Sanitize likely secrets before persistence and cap operation output at 256 KiB
with an explicit truncation marker.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts test/operationsStore.test.ts
git add packages/sync-server/migrations/0008_admin_operations.sql packages/sync-server/src/operationsStore.ts packages/sync-server/test/migrate.test.ts packages/sync-server/test/operationsStore.test.ts
git commit -m "feat(admin): persist operational audit records"
```

### Task 2: Create the typed operator service

**Files:**
- Create: `packages/operator/package.json`
- Create: `packages/operator/tsconfig.json`
- Create: `packages/operator/src/protocol.ts`
- Create: `packages/operator/src/executor.ts`
- Create: `packages/operator/src/server.ts`
- Create: `packages/operator/src/index.ts`
- Create: `packages/operator/test/protocol.test.ts`
- Create: `packages/operator/test/server.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
export type OperatorRequest =
  | { operationId: string; type: 'service_restart'; service: 'sync-server' | 'postgres' }
  | { operationId: string; type: 'deployment_apply'; revision: string }
  | { operationId: string; type: 'backup_create' }
  | { operationId: string; type: 'backup_verify'; backupName: string }
  | { operationId: string; type: 'backup_restore'; backupName: string };

export interface OperatorAccepted {
  operationId: string;
  accepted: true;
}
```

- [ ] **Step 1: Write failing protocol tests**

Reject unknown fields/types, arbitrary service names, non-40-character
lowercase hexadecimal revisions, path separators or non-basename backup names,
oversized bodies, duplicate operation IDs, and non-POST methods. Accept only
the exact discriminated union.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run
```

Expected initially: package/filter does not exist.

- [ ] **Step 3: Scaffold package and strict protocol**

Use Zod `.strict()`. Listen only on `OPERATOR_SOCKET_PATH`. Before listen,
remove an existing path only if `lstat` confirms it is a Unix socket owned by
the current UID; otherwise fail closed. After listen, chmod socket `0660`.

- [ ] **Step 4: Implement fixed executor mapping**

Map each operation to a compile-time command:

```ts
const commands = {
  service_restart: ['/usr/local/lib/ariadne/restart-sync-server'],
  deployment_apply: ['/usr/local/lib/ariadne/deploy'],
  backup_create: ['/usr/local/lib/ariadne/backup'],
  backup_verify: ['/usr/local/lib/ariadne/verify-backup'],
  backup_restore: ['/usr/local/lib/ariadne/restore-backup'],
} as const;
```

Invoke with `execFile`, a minimal fixed environment, timeout, maxBuffer, and
explicit validated revision/backup basename only where required. Split service
restart into a fixed map for `sync-server` and `postgres`. Stream
progress/result messages to a configured callback; never pass shell strings.

- [ ] **Step 5: Add concurrency/idempotency controls**

Permit one mutating operation at a time. Cache operation IDs until terminal
state and return the prior acceptance for duplicate delivery. A concurrent
different operation returns `409 operator_busy`.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm install
pnpm --filter @ariadne-dev/operator build
pnpm --filter @ariadne-dev/operator exec vitest run
git add packages/operator pnpm-lock.yaml
git commit -m "feat(operator): add allowlisted Unix socket service"
```

### Task 3: Sync-server operator client and admin APIs

**Files:**
- Create: `packages/sync-server/src/operatorClient.ts`
- Create: `packages/sync-server/src/routes/adminOperations.ts`
- Create: `packages/sync-server/test/operatorClient.test.ts`
- Modify: `packages/sync-server/src/config.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/v1/admin/operations`
  - `GET /api/v1/admin/operations/:id`
  - `GET /api/v1/admin/operations/:id/events` as SSE
  - `POST /api/v1/admin/operations/service-restart`
  - `POST /api/v1/admin/operations/deploy` body `{ revision: string }`
  - `POST /api/v1/admin/operations/backups`
  - `POST /api/v1/admin/operations/backups/:name/verify`
  - `POST /api/v1/admin/operations/backups/:name/restore`

- [ ] **Step 1: Write failing client/route tests**

Use a temporary Unix socket fake. Cover successful acceptance, unavailable
socket `503 operator_unavailable`, timeout, malformed response, admin-only
access, duplicate request handling, operation persistence, and SSE events.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/operatorClient.test.ts test/routes.test.ts
```

- [ ] **Step 3: Implement Unix-socket client**

Use `http.request({ socketPath, path: '/v1/operations', method: 'POST' })`.
Cap response bytes and timeout. Verify the configured socket path is absolute.
Map transport failures to explicit API errors without leaking OS paths.

- [ ] **Step 4: Implement operation routes**

Require singleton admin and the dashboard reauthentication marker that Plan 04
will provide. Until Plan 04, tests inject `req.adminReauthenticated = true`.
Create queued DB record before submission; mark failed if submission fails.
SSE sends persisted events and heartbeat comments, then closes on terminal
state or client disconnect.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run test/operatorClient.test.ts test/routes.test.ts
git add packages/sync-server/src/operatorClient.ts packages/sync-server/src/routes/adminOperations.ts packages/sync-server/src/config.ts packages/sync-server/src/app.ts packages/sync-server/test/operatorClient.test.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(admin): expose audited operator actions"
```

### Task 4: Tracked production container deployment

**Files:**
- Create: `deploy/nodem2/compose.yaml`
- Create: `deploy/nodem2/sync-server.Dockerfile`
- Create: `deploy/nodem2/.env.example`
- Create: `deploy/nodem2/scripts/deploy`
- Create: `deploy/nodem2/scripts/restart-sync-server`
- Create: `deploy/nodem2/scripts/restart-postgres`
- Create: `deploy/nodem2/test/deploy.test.ts`
- Modify: `.dockerignore`
- Modify: `packages/sync-server/README.md`

- [ ] **Step 1: Write failing deployment contract tests**

Spawn scripts with a fake `docker` executable first in `PATH`. Assert:

- deployment checks required secret/key files before Compose;
- `docker compose config --quiet` precedes build/migrate/up;
- migrations run as a one-shot service before replacing app;
- health verification failure invokes rollback to prior image tag;
- commands use fixed compose/project paths;
- no secret values appear in output;
- restart targets only `sync-server` or `postgres`;
- deployment rejects a commit that is not reachable from the configured
  trusted remote/ref.

- [ ] **Step 2: Run test and verify RED**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/deploy.test.ts
```

- [ ] **Step 3: Add hardened sync-server image**

Use a multi-stage Node 20 image, `pnpm deploy --prod`, non-root runtime user,
read-only root filesystem compatibility, init, healthcheck, and no build tools
in runtime.

- [ ] **Step 4: Add Compose topology**

Define:

- `postgres`: PostgreSQL 16, named data volume, loopback-only optional
  maintenance port, healthcheck;
- `migrate`: same immutable app image, runs migration, no restart;
- `sync-server`: loopback `127.0.0.1:4300:4300`, read-only key mount,
  operator socket mount, non-root UID/GID, `read_only`, `tmpfs: /tmp`,
  `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`.

Use `/etc/ariadne/compose.env` and `/etc/ariadne/sync-server.env`; `.env.example`
contains names only.

- [ ] **Step 5: Implement deploy/rollback script**

The script records current image ID, validates config, builds tagged candidate,
runs migrations, starts candidate, polls `/health`, and restores the previous
tag on failure. It accepts one validated commit SHA, verifies that commit is
reachable from the configured trusted remote/ref, checks out the detached
revision in the fixed deployment worktree, and rejects dirty or untrusted
source. Use `set -eu`, fixed absolute paths, `umask 077`, and traps.

- [ ] **Step 6: Run tests and config validation**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/deploy.test.ts
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example config --quiet
```

- [ ] **Step 7: Commit**

```bash
git add deploy/nodem2/compose.yaml deploy/nodem2/sync-server.Dockerfile deploy/nodem2/.env.example deploy/nodem2/scripts deploy/nodem2/test .dockerignore packages/sync-server/README.md
git commit -m "feat(deploy): add tracked nodem2 Compose stack"
```

### Task 5: Backup, restore, and weekly verification scripts

**Files:**
- Create: `deploy/nodem2/scripts/backup`
- Create: `deploy/nodem2/scripts/restore-backup`
- Create: `deploy/nodem2/scripts/verify-backup`
- Create: `deploy/nodem2/scripts/prune-backups`
- Create: `deploy/nodem2/test/backups.test.ts`
- Create: `deploy/nodem2/systemd/ariadne-backup.service`
- Create: `deploy/nodem2/systemd/ariadne-backup.timer`
- Create: `deploy/nodem2/systemd/ariadne-backup-verify.service`
- Create: `deploy/nodem2/systemd/ariadne-backup-verify.timer`

- [ ] **Step 1: Write failing backup tests**

With fake `docker`, `sha256sum`, and clock inputs, assert:

- backup creates `*.dump`, `*.sha256`, and `*.json` atomically;
- dump uses PostgreSQL custom format;
- mode is `0600` and directory mode is `0700`;
- incomplete temporary files are removed on failure;
- metadata contains DB/image/schema/timestamp/size/hash but no secrets;
- metadata lists required encrypted-blob key IDs but never key material;
- restore verifies basename, hash, and `pg_restore --list` before mutation;
- restore creates and verifies a fresh pre-restore safety backup before stopping
  the application;
- weekly verification restores to an isolated temporary database, runs schema
  checks, then drops it;
- pruning deletes only complete backup triplets older than 30 days;
- encryption key directory is neither archived nor referenced as backup input.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/backups.test.ts
```

- [ ] **Step 3: Implement backup scripts**

Use fixed `/var/backups/ariadne`, `umask 077`, ISO-8601 UTC filenames, and:

```bash
docker compose exec -T postgres pg_dump --format=custom --no-owner --no-acl ...
```

Write to `.tmp`, fsync where available, rename only after hash and metadata
succeed, then prune. Never source untrusted metadata.

- [ ] **Step 4: Implement restore and verification**

`restore-backup <basename>` accepts only
`ariadne-YYYYMMDDTHHMMSSZ.dump`, validates sidecars, requires a separately
provided confirmation environment from the fixed operator script, creates and
verifies a fresh safety backup, stops the application, and restores through a
new DB before a controlled swap. Any restore failure leaves the application
stopped and prints the exact recovery command and safety-backup basename.
`verify-backup` always uses a temporary DB and records result.

- [ ] **Step 5: Add timers**

Daily backup timer uses `OnCalendar=*-*-* 02:15:00`, `Persistent=true`, and
randomized delay. Weekly verification uses Sunday 03:30. Services include
hardening (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`) with only
required write paths.

- [ ] **Step 6: Run tests and verify systemd syntax**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/backups.test.ts
systemd-analyze verify deploy/nodem2/systemd/ariadne-backup.service deploy/nodem2/systemd/ariadne-backup.timer deploy/nodem2/systemd/ariadne-backup-verify.service deploy/nodem2/systemd/ariadne-backup-verify.timer
```

- [ ] **Step 7: Commit**

```bash
git add deploy/nodem2/scripts/backup deploy/nodem2/scripts/restore-backup deploy/nodem2/scripts/verify-backup deploy/nodem2/scripts/prune-backups deploy/nodem2/test/backups.test.ts deploy/nodem2/systemd
git commit -m "feat(backup): automate PostgreSQL backup verification"
```

### Task 6: Operator service installation and callback channel

**Files:**
- Create: `deploy/nodem2/systemd/ariadne-operator.service`
- Create: `deploy/nodem2/scripts/install`
- Create: `deploy/nodem2/scripts/transfer-admin`
- Create: `deploy/nodem2/scripts/rotate-encryption-key`
- Create: `deploy/nodem2/test/install.test.ts`
- Modify: `packages/operator/src/server.ts`
- Modify: `packages/operator/test/server.test.ts`
- Modify: `packages/sync-server/src/routes/adminOperations.ts`
- Modify: `packages/sync-server/test/routes.test.ts`

- [ ] **Step 1: Write failing installer/callback tests**

Assert installation creates service group/directories with correct modes,
copies only tracked artifacts, preserves existing secret files, installs and
enables units, and refuses wrong ownership. Assert root-only admin transfer
keeps exactly one admin and writes an audit row. Assert key rotation creates a
new mode-0600 key, atomically switches `active-key-id`, retains old keys, and
never prints key material. Operator callback messages require a shared socket
credential or peer-UID validation and update only their own operation ID.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run test/server.test.ts ../../deploy/nodem2/test/install.test.ts
pnpm --filter @ariadne-dev/sync-server exec vitest run test/routes.test.ts
```

- [ ] **Step 3: Implement systemd operator**

Run as root with the smallest possible filesystem access. Set
`OPERATOR_SOCKET_PATH=/run/ariadne/operator.sock`, group `ariadne-web`, and
fixed script directory `/usr/local/lib/ariadne`. Deny network access if
systemd version supports `IPAddressDeny=any`.

- [ ] **Step 4: Implement authenticated result reporting**

Prefer a second root-created Unix socket and Linux peer credentials. If Node
runtime support is insufficient, use a 32-byte callback token in
`/run/ariadne/operator-callback-token`, readable only by operator and web
group. Never persist it or include it in logs.

- [ ] **Step 5: Implement idempotent installer**

Install Compose/scripts/units, create `/etc/ariadne/keys` and backup/runtime
directories, generate an encryption key only when none exists, and print
explicit next steps for missing env secrets. Do not overwrite existing keys.
`transfer-admin <username>` requires UID 0, locks the singleton-team
membership rows, verifies an active target member, changes the old admin to
member and target to admin in one transaction, then appends an admin audit
event. `rotate-encryption-key` requires UID 0 and atomically creates/switches a
new key ID without rewriting old blobs.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm --filter @ariadne-dev/operator exec vitest run
pnpm --filter @ariadne-dev/sync-server exec vitest run
git add deploy/nodem2/systemd/ariadne-operator.service deploy/nodem2/scripts/install deploy/nodem2/scripts/transfer-admin deploy/nodem2/scripts/rotate-encryption-key deploy/nodem2/test/install.test.ts packages/operator packages/sync-server/src/routes/adminOperations.ts packages/sync-server/test/routes.test.ts
git commit -m "feat(deploy): install the privileged Ariadne operator"
```

### Task 7: Deployment/backups review gate

- [ ] **Step 1: Run complete validation**

```bash
pnpm --filter @ariadne-dev/operator build
pnpm --filter @ariadne-dev/operator exec vitest run
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example config --quiet
systemd-analyze verify deploy/nodem2/systemd/*.service deploy/nodem2/systemd/*.timer
git diff --check
```

- [ ] **Step 2: Run mandatory reviews**

Invoke TypeScript Reviewer, Security Reviewer, and load `docker-patterns`.
Review socket ownership, request allowlist, command construction, output
redaction, container capabilities/mounts, secret handling, backup atomicity,
restore safety, and rollback behavior.

- [ ] **Step 3: Fix accepted findings test-first and commit**

```bash
git add packages/operator packages/sync-server deploy/nodem2
git commit -m "fix(operations): harden deployment and backup controls"
```
