# Task 3 report — Sync-server operator client and admin APIs

Commit: `d868a71` — `feat(admin): expose audited operator actions`

## What shipped

- **`packages/sync-server/src/operatorClient.ts`** (new): Unix-socket client
  posting to `/v1/operations`. Verifies the configured socket path is absolute
  at construction (`SyncServerConfigError`), bounds the response body
  (8 KiB default) and the whole exchange with a timeout (10 s default, plus
  `request.setTimeout`). Failures map to `OperatorClientError` with fixed,
  path-free messages: `operator_unavailable` (503), `operator_timeout` (504),
  `operator_busy` (409), `operator_invalid_response` (502),
  `operator_rejected` (502). An acceptance is only honoured on HTTP 202 with
  `accepted: true` and a matching `operationId`.
- **`packages/sync-server/src/routes/adminOperations.ts`** (new): the eight
  planned routes. Every route requires the singleton admin
  (`requireSingletonAdmin`) *and* `req.adminReauthenticated === true`, failing
  closed with `403 reauthentication_required` until Plan 04 supplies the
  middleware. Mutating routes validate parameters first, create the `queued`
  record through `operationsStore.createOperation` before submission, and mark
  the operation `failed` via `transitionOperation` when submission fails (no
  direct row updates anywhere). SSE replays persisted events (honouring
  `Last-Event-ID`), emits `: heartbeat` comments, and closes with an
  `event: complete` on a terminal state, on client disconnect, or at a bounded
  max stream duration.
- **`packages/sync-server/src/config.ts`**: optional `OPERATOR_SOCKET_PATH`,
  rejected when not absolute.
- **`packages/sync-server/src/app.ts`** / **`src/index.ts`**: mount the router
  with an injectable `operatorClient` (`null` when unconfigured → `503
  operator_unavailable` with a recorded failed operation).

## Interface compatibility

The client mirrors the Task 2 request union structurally
(`packages/operator/src/protocol.ts`) instead of importing the operator package
at runtime: the two are separate services at different privilege levels and
there is no existing workspace dependency between them. Tests assert the exact
wire JSON (`operationId`/`type`/`service`/`revision`/`backupName`) so drift
fails loudly.

## Tests

- `test/operatorClient.test.ts` (new, 14 tests) — real temporary Unix-socket
  fake: acceptance, all request variants, duplicate replay, missing socket,
  refused connection, timeout, non-JSON body, mismatched id, `accepted:false`,
  oversized body, busy, protocol rejection, relative/empty path rejection, and
  assertions that no message contains the socket path.
- `test/routes.test.ts` (new `admin operator operations` suite, 17 tests) —
  acceptance + persistence + audit rows, list/fetch/404, unique operation ids,
  fail-closed without the reauth marker (via the real `createApp`, no bypass),
  non-admin denial, 401, parameter validation (service enum, revision, backup
  basename/traversal), deploy and backup verify/restore wire shape,
  unavailable/unconfigured/timeout/malformed/busy → failed operation with the
  mapped status, SSE heartbeat + replay + terminal close, SSE authorization,
  and a no-secrets/no-OS-paths assertion over operations, events, and audit.

Commands (all green):

- `pnpm --filter @ariadne-dev/sync-server exec vitest run test/operatorClient.test.ts test/routes.test.ts` → 97 passed
- `pnpm --filter @ariadne-dev/sync-server build` → clean
- `pnpm --filter @ariadne-dev/sync-server test` → 181 passed (12 files)

RED was observed before implementation (module resolution failure for
`../src/operatorClient.js` and `../src/routes/adminOperations.js`).

## Notes / concerns

- A bare `..` path segment is normalised away by the HTTP client/router, so it
  never reaches the backup handler; the encoded traversal forms
  (`%2e%2e%2fetc%2fpasswd`, `nested%2Fbackup.dump`) are rejected with
  `400 invalid_request`, and the normalised case is asserted as 404.
- SSE progress is served by polling the persisted event table (default 1 s).
  Task 6's authenticated operator callbacks will write those events; no
  push/notify channel is required by this plan.
- `POST /operations/backups*` bodies are parsed leniently (unknown keys
  stripped, never persisted), so a caller cannot smuggle extra fields into
  metadata.
- `OPERATOR_SOCKET_PATH` documentation lives with the deployment artifacts
  owned by Tasks 4/6; `packages/sync-server/README.md` was intentionally left
  for those tasks to avoid conflicting edits.

## Review fix follow-up — uncertain submission failures stay queued

- **Finding addressed:** transport uncertainty after the operator's `202`
  acceptance window (`operator_timeout`, runtime `operator_unavailable`) was
  being persisted as terminal `failed`, which would block Task 6 callbacks from
  moving the same operation through `queued -> running -> terminal`.
- **Route handling change:** `adminOperations.ts` now treats only definite
  submission failures as terminal (`null`/unconfigured client,
  `operator_busy`, `operator_rejected`, `operator_invalid_response`, and the
  generic unexpected fallback). Uncertain transport failures leave the row
  `queued`, return the existing mapped API error, and append only a fixed
  sanitized audit record:
  - `action: admin_operation.submission_uncertain`
  - `outcome: queued`
  - metadata `{ operationId, state: 'queued', reason, message }`
- **Test-first evidence:** the route expectations were updated first, focused
  tests were run and failed on the old behavior (`expected 'failed' to be
  'queued'` for unavailable/timeout), then the route was changed and the suite
  was rerun green.
- **New route coverage:** `packages/sync-server/test/routes.test.ts` now
  distinguishes uncertain vs definite cases and asserts that uncertain ids can
  still transition later via the store (`queued -> running -> succeeded` for a
  delayed acceptance path, `queued -> running -> failed` for a delayed failure
  path).
- **Validation after the fix:**
  - `pnpm --filter @ariadne-dev/sync-server exec vitest run test/operatorClient.test.ts test/routes.test.ts`
  - `pnpm --filter @ariadne-dev/sync-server test`
  - `pnpm --filter @ariadne-dev/sync-server build`
- **Fix commit:** `fix(admin): keep uncertain operator submissions queued`
