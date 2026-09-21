# Task 2 Report — Create the typed operator service

## Outcome

Implemented the new workspace package `@ariadne-dev/operator` on
`feat/nodem2-cloud`, adding a strict Unix-socket-only operator service with:

- exact Zod-validated discriminated-union request parsing
- allowlisted `execFile` command execution with no shell strings
- fixed command mappings for deploy/backup/restart operations
- single-operation concurrency with duplicate-ID idempotent acceptance
- safe Unix socket startup/cleanup rules and `0660` socket permissions

## Design

### Protocol

`src/protocol.ts` defines the exact accepted request union:

- `service_restart` with `service: 'sync-server' | 'postgres'`
- `deployment_apply` with a strict lowercase 40-character hex revision
- `backup_create`
- `backup_verify` / `backup_restore` with basename-only `backupName`

Every variant is `.strict()` so unknown fields are rejected.

### Executor

`src/executor.ts` maps requests to compile-time executable paths only:

- `/usr/local/lib/ariadne/restart-sync-server`
- `/usr/local/lib/ariadne/restart-postgres`
- `/usr/local/lib/ariadne/deploy`
- `/usr/local/lib/ariadne/backup`
- `/usr/local/lib/ariadne/verify-backup`
- `/usr/local/lib/ariadne/restore-backup`

Execution uses `execFile` with:

- `shell: false`
- fixed minimal env (`PATH`, `LANG`, `LC_ALL`)
- bounded timeout (`15m`)
- bounded output buffer (`256 KiB`)

Validated revision/backup basename values are appended only where required.
Progress/result delivery stays injectable through `OperatorEventSink`.

### Server

`src/server.ts` exposes only `POST /v1/operations` over a Unix socket path
loaded from `OPERATOR_SOCKET_PATH`.

Startup behavior:

1. require an absolute socket path
2. `lstat` any existing path
3. remove it only when it is a Unix socket owned by the current UID
4. fail closed for non-socket paths or foreign-owned sockets
5. `chmod 0660` after `listen`

Request handling:

- rejects non-POST with `405 method_not_allowed`
- rejects oversized bodies with `413 request_too_large`
- rejects malformed JSON with `400 invalid_json`
- rejects schema violations with `400 invalid_request`
- returns prior `202` acceptance for duplicate active operation IDs
- returns `409 operator_busy` for a different concurrent active operation

## Files Changed

- `packages/operator/package.json`
- `packages/operator/tsconfig.json`
- `packages/operator/src/protocol.ts`
- `packages/operator/src/executor.ts`
- `packages/operator/src/server.ts`
- `packages/operator/src/index.ts`
- `packages/operator/test/protocol.test.ts`
- `packages/operator/test/server.test.ts`
- `pnpm-lock.yaml`

## RED Evidence

### Initial package-level RED

Command:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run
```

Observed result before scaffolding:

```text
No projects matched the filters in "/home/lkumar/Ariadne/.worktrees/nodem2-cloud"
```

### Test-level RED after writing tests

Command:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run
```

Observed failing result:

```text
FAIL  test/protocol.test.ts
Error: Cannot find module '../src/executor.js'

FAIL  test/server.test.ts
Error: Cannot find module '../src/server.js'

Test Files  2 failed (2)
Tests       no tests
```

## GREEN Evidence

### Focused package tests

Command:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run
```

Passing result:

```text
✓ test/protocol.test.ts (4 tests)
✓ test/server.test.ts (6 tests)

Test Files  2 passed (2)
Tests      10 passed (10)
Duration   582ms
```

### Build

Command:

```bash
pnpm --filter @ariadne-dev/operator build
```

Passing result:

```text
> @ariadne-dev/operator@0.1.0 build /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/operator
> tsc -p tsconfig.json
```

## Exact Results

- `pnpm install` — passed (`Already up to date`)
- `pnpm --filter @ariadne-dev/operator build` — passed
- `pnpm --filter @ariadne-dev/operator exec vitest run` — passed (`10/10`)

## Commit

- `011673d4235680be7324cc727114d0b51b512a19` — `feat(operator): add allowlisted Unix socket service`

## Concerns

- Custom `executeOperation` injections are responsible for their own terminal
  reporting semantics when they bypass the built-in executor; Task 6 is still
  the place where authenticated callback/result delivery becomes concrete.
