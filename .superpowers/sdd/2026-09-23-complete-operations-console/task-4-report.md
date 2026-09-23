# Task 4 Report — Typed Dashboard Foundation

## Outcome

Implemented the typed dashboard foundation in `/packages/dashboard` without pulling Task 5–7 feature pages forward. The MVP shell still works, login/auth moved out of `App.tsx`, typed response guards now protect all dashboard API reads/mutations used here, and the new composition includes placeholder navigation targets for later page work.

## RED evidence

Command:

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth/AuthProvider.test.tsx src/components/ConfirmationDialog.test.tsx src/App.test.tsx
```

Initial result:

- `FAIL src/App.test.tsx` — missing `./components/OperationProgress`
- `FAIL src/auth/AuthProvider.test.tsx` — missing `../api/guards`
- `FAIL src/components/ConfirmationDialog.test.tsx` — missing `./ConfirmationDialog`

This confirmed the typed/auth/component foundation did not exist yet.

## GREEN evidence

Required validation:

```bash
pnpm --filter @ariadne-dev/dashboard build
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth src/components src/App.test.tsx
```

Result:

- `build` passed
- `9/9` tests passed across `src/auth`, `src/components`, and `src/App.test.tsx`

Additional regression check I ran because the refactor touched existing MVP pages:

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/operations/OperationsPages.test.tsx src/tasks/TasksPage.test.tsx
```

Result:

- `7/7` page regression tests passed

## Files

### Created

- `packages/dashboard/src/api/types.ts`
- `packages/dashboard/src/api/guards.ts`
- `packages/dashboard/src/auth/AuthProvider.tsx`
- `packages/dashboard/src/auth/LoginPage.tsx`
- `packages/dashboard/src/auth/AuthProvider.test.tsx`
- `packages/dashboard/src/components/AsyncState.tsx`
- `packages/dashboard/src/components/ConfirmationDialog.tsx`
- `packages/dashboard/src/components/ConfirmationDialog.test.tsx`
- `packages/dashboard/src/components/OperationProgress.tsx`
- `packages/dashboard/src/components/StatusLabel.tsx`
- `packages/dashboard/src/hooks/useOperation.ts`

### Modified

- `packages/dashboard/src/api/client.ts`
- `packages/dashboard/src/auth/usePrivilegedAction.tsx`
- `packages/dashboard/src/App.tsx`
- `packages/dashboard/src/App.test.tsx`
- `packages/dashboard/src/operations/OverviewPage.tsx`
- `packages/dashboard/src/operations/BackupsPage.tsx`
- `packages/dashboard/src/operations/ServicesPage.tsx`
- `packages/dashboard/src/operations/LogsPage.tsx`
- `packages/dashboard/src/tasks/TasksPage.tsx`
- `packages/dashboard/src/operations/OperationsPages.test.tsx`
- `packages/dashboard/src/tasks/TasksPage.test.tsx`

## What changed

- Added explicit exported dashboard API types and runtime guards for sessions, overview, members, tasks, captures, backups, services, deployments, logs, audit, and operations.
- Replaced the loose JSON client with a strict guarded client that:
  - validates success bodies with guards
  - throws `AdminApiError('invalid_response')` for malformed/unexpected JSON
  - sends CSRF headers on mutations only
  - preserves abort propagation
  - handles download error bodies
- Added an in-memory `AuthProvider` that:
  - restores sessions and uses rotated CSRF tokens
  - keeps session/CSRF/password state out of storage
  - collapses `401` into a single session-expired transition
  - exposes reauthentication for privileged actions
- Extracted `LoginPage` from `App.tsx`.
- Refactored `App.tsx` into auth-aware composition with the required section IDs:
  - `overview`
  - `members`
  - `tasks`
  - `backups`
  - `services`
  - `deployments`
  - `logs`
  - `audit`
- Added placeholder pages for `members`, `deployments`, and `audit` only; no Task 5–7 implementations were pulled in.
- Added shared confirmation/progress foundation:
  - exact-match `ConfirmationDialog`
  - `OperationProgress`
  - `useOperation` SSE + bounded polling reconnection behavior
  - `StatusLabel`
  - `AsyncState`
- Updated existing MVP pages to consume the typed auth/client foundation while keeping their current behavior.

## Commit

- `02ff87a` — `refactor(dashboard): add typed admin foundation`

## Self-review

- **Boundary check:** kept Task 4 scoped to foundation/refactor work; only placeholders were added for deferred pages.
- **Type safety:** no `any`; all new public/shared APIs have explicit exported types.
- **Runtime safety:** untrusted API JSON is narrowed before use; no silent defaulting of missing required fields.
- **Credential handling:** session, CSRF, and password values remain in memory only; no storage or URL persistence added.
- **Cleanup:** abort cleanup is present on auth restore, page reads, and operation streaming/polling.
- **Regression check:** existing MVP overview/tasks/backups/services/logs pages still render and their focused tests now pass on the refactored foundation.

## Concerns

- `AsyncState` is in place as shared foundation, but this task intentionally did not force a broad UI rewrite of every page around it; deeper adoption can happen in Tasks 5–7 as those pages expand.

## Fix Round 1

### Finding addressed

- `useOperation` treated malformed SSE JSON and guard-failing `operation_event` / `complete` payloads like ordinary disconnects or harmless skips. That violated the Task 4 binding rule for untrusted success payloads.

### Root cause

- `parseEventBlock()` returned `null` on JSON parse failure, so malformed data was silently ignored.
- Guard-failing `operation_event` and `complete` payloads were also silently skipped because only truthy guard matches changed state; invalid payloads never raised protocol errors.
- After the stream ended, the hook treated the situation as a transport disconnect and fell into polling, which could mask protocol corruption and continue on a bad stream.

### RED evidence

Added focused tests in `packages/dashboard/src/App.test.tsx` for:

- malformed SSE JSON
- structurally invalid `operation_event`
- structurally invalid `complete`

RED command:

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/App.test.tsx
```

Initial failing result:

- `3 failed`
- visible error was **not** `The server returned an invalid response.`
- hook fell through to polling and surfaced `Cannot read properties of undefined (reading 'operation')`

### GREEN evidence

Fix:

- malformed SSE JSON now throws `AdminApiError(200, 'invalid_response', 'The server returned an invalid response.')`
- guard-failing `operation_event` / `complete` payloads now throw the same explicit protocol error
- invalid SSE data aborts the stream and stops without polling fallback
- bounded polling fallback remains only for real transport disconnects

Validation:

```bash
pnpm --filter @ariadne-dev/dashboard exec vitest run src/App.test.tsx
pnpm --filter @ariadne-dev/dashboard exec vitest run src/auth src/components src/App.test.tsx
```

Results:

- `src/App.test.tsx`: `7/7` passed
- foundation suite: `12/12` passed across auth/components/App

### Files changed in fix round 1

- `packages/dashboard/src/hooks/useOperation.ts`
- `packages/dashboard/src/App.test.tsx`
