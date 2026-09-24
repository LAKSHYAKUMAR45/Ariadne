# Task 1 Report: Host Message Contract and Dispatcher

## What I implemented

- Added `packages/vscode-extension/src/webview/messages.ts` with the shared webview host contract:
  - explicit request types for `state.get`, `task.switch`, `tasks.list`, todo/decision/error/question CRUD, `files.list`, `files.getCapture`, `search.run`, `sync.push`, `sync.pull`, `sync.listRemote`, and `export.markdown`
  - `WebviewRequest`, `WebviewResponse`, `WebviewState`, `SyncActions`, and `WebviewDispatcherDeps`
  - host-to-webview `stateUpdate` message typing
- Added `packages/vscode-extension/src/webview/handleWebviewMessage.ts`:
  - `buildWebviewState()` snapshot builder for the current workspace/task
  - `handleWebviewMessage()` dispatcher for all task/entity/search/sync/export requests
  - payload validation and error-response handling instead of throwing across the bridge
  - sync/export injection points using the existing CLI-backed sync commands and export writer
- Added `packages/vscode-extension/test/webviewMessage.test.ts` covering:
  - state snapshot construction
  - todo create/update/status/delete flow
  - missing-current-task error handling
  - injected sync/export flows

## What I tested and test results

- `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`
  - PASS: 4 tests passed
- `cd packages/vscode-extension && pnpm exec tsc --noEmit`
  - PASS: no type errors

## TDD Evidence

### RED

Command:

```bash
cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
```

Output:

```text
undefined
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found

Did you mean "pnpm test"?
```

### GREEN

Command:

```bash
cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
```

Output:

```text
RUN  v3.2.7 /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/vscode-extension

 ✓ test/webviewMessage.test.ts (4 tests) 37ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  12:58:29
   Duration  496ms (transform 153ms, setup 19ms, collect 153ms, tests 37ms, environment 0ms, prepare 91ms)
```

## Files changed

- `packages/vscode-extension/src/webview/messages.ts`
- `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- `packages/vscode-extension/test/webviewMessage.test.ts`

## Self-review findings

- The dispatcher is now typed against the real `TaskStore` surface, not a partial snapshot-only interface, which avoided the structural typing gap caught by `tsc`.
- Mutations return refreshed `WebviewState` snapshots, and read-only requests stay side-effect free.
- Payload validation is explicit for the request types covered in this task, and unsupported request types return a structured error response.

## Concerns

- This task intentionally stops at the host message contract and dispatcher. Panel wiring, webview UI, tree-view removal, and packaging are still pending in later tasks.
- The dispatcher currently returns search results and file-capture data through request responses, but the panel/UI consumer is not implemented yet, so those response shapes may be extended later as the UI shell lands.

## Fix report — 2026-09-23

### Review issues addressed

1. **Cross-workspace task switching**
   - Made `task.switch` explicit and safe at the host-dispatcher layer.
   - It now rejects non-current-workspace task ids with a clear error instead of implying the all-workspaces list can be activated here.
   - This keeps the contract internally consistent until later panel/workspace plumbing can support true cross-workspace activation.

2. **Todo status validation**
   - Tightened `todo.setStatus` to accept only `pending`, `done`, or `blocked`.
   - Invalid values now return a structured error response and do not reach the store.

### Additional tests added

- `task.switch` now has an explicit safety test for unsupported cross-workspace activation.
- `todo.setStatus` now has a regression test that verifies invalid values are rejected and the stored todo status remains unchanged.

### Verification

- `cd packages/vscode-extension && pnpm exec tsc --noEmit`
  - PASS
- `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`
  - PASS: 6 tests passed

## Fix report — 2026-09-23 round 2

### Review issue addressed

- **Cross-workspace task switching**
  - Implemented actual cross-workspace resolution for `task.switch` using the registry:
    - looks up the owning workspace root for the requested task id
    - opens that workspace store read-only
    - sets the selected task as current in that owning store
    - returns a refreshed `WebviewState` built from the resolved workspace
  - Local task switching still uses the current workspace store and continues to work the same way.
  - Unknown ids still return a structured error response.

### Additional tests added

- Switching to a task from another registered workspace succeeds and returns state for the resolved workspace.
- Unknown task ids still fail with a structured error.
- Local task switching still succeeds.

### Verification

- `cd packages/vscode-extension && pnpm exec tsc --noEmit`
  - PASS
- `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`
  - PASS: 8 tests passed
