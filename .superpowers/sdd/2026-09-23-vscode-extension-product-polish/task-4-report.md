# Task 4 Report — Onboarding and Task Templates

## Status

- **Complete**
- **Worktree:** `/home/lkumar/Ariadne/.worktrees/nodem2-cloud`
- **Branch:** `feat/nodem2-cloud`

## Commits

- `67b8259` — `feat: add vscode onboarding and task templates`

## Files Changed

- `packages/vscode-extension/src/webview/messages.ts`
- `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- `packages/vscode-extension/test/webviewMessage.test.ts`
- `packages/vscode-extension/webview-ui/src/App.tsx`
- `packages/vscode-extension/webview-ui/src/App.test.tsx`

## Rulings

- The brief required recoverable partial creation when template seeding fails. I implemented that contract in the dispatcher: the task is still created and selected, and the error response includes refreshed `state`.
- The current bridge/panel flow only applies `state` automatically for successful responses. To keep Task 4 scoped exactly to the brief’s listed files and commit surface, I did **not** widen that behavior here; the host contract now returns the partial task state for callers/tests, and the UI still surfaces the failure explicitly.

## Tests Run

### Required TDD failure pass

1. **FAIL (expected before implementation)**  
   `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`  
   - Result: `20 tests | 2 failed`
   - Failures:
     - `creates a task from a built-in template and seeds its entities`
     - `surfaces template seeding failure with the created task state`

2. **FAIL (expected before implementation)**  
   `cd packages/vscode-extension/webview-ui && pnpm vitest run src/App.test.tsx`  
   - Result: `10 tests | 1 failed`
   - Failure:
     - `shows onboarding when no task exists and creates a templated task`

### Required final validation

1. **PASS**  
   `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`  
   - Result: `20 passed`

2. **PASS**  
   `cd packages/vscode-extension/webview-ui && pnpm vitest run src/App.test.tsx`  
   - Result: `10 passed`

3. **PASS**  
   `cd packages/vscode-extension && pnpm run build`  
   - Result:
     - extension bundle built successfully
     - webview Vite build completed successfully
     - bundled `better-sqlite3` runtime verification completed successfully

## Concerns / Self-Review

- Template labels/descriptions were added to satisfy the shared contract; the brief only specified exact built-in todo/question seed text, which was used verbatim.
- Partial template-seeding failures are explicit and test-covered, but the webview does not automatically hydrate error-response state today because that behavior belongs to the existing bridge/panel contract outside Task 4 scope.
- I avoided staging the pre-existing optional activity bar icon hardening changes in `packages/vscode-extension/package.json`, `packages/vscode-extension/test/extension.test.ts`, and `packages/vscode-extension/resources/activitybar.svg`.

---

## Fix Round 1

### Status

- **Complete**

### Findings Addressed

1. **Critical:** Error responses that include refreshed `state` now hydrate end-to-end.  
   - `panel.ts` now posts `stateUpdate` and refreshes host state whenever a dispatcher response carries `state`, regardless of `ok`.
   - `webview-ui/src/bridge.ts` now applies `message.state` before resolving/rejecting the pending request, so the UI updates while the request still rejects and preserves the visible error banner path.
   - Added tests covering both host-panel posting and bridge-side hydration on rejected requests.

2. **Important:** Template ID validation now rejects inherited keys safely.  
   - `isTaskTemplateId()` now uses own-property validation via `Object.prototype.hasOwnProperty.call(...)`.
   - Added a dispatcher test proving `toString` is rejected and no task is created.

### Additional Files Changed in Fix Round

- `packages/vscode-extension/src/webview/panel.ts`
- `packages/vscode-extension/test/panel.test.ts`
- `packages/vscode-extension/webview-ui/src/bridge.ts`
- `packages/vscode-extension/webview-ui/src/bridge.test.ts`
- `packages/vscode-extension/webview-ui/src/App.tsx`
- `packages/vscode-extension/webview-ui/src/App.test.tsx`

### Tests Run

1. **FAIL (expected before implementation)**  
   `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts test/panel.test.ts && cd webview-ui && pnpm vitest run src/bridge.test.ts src/App.test.tsx`  
   - Host result: `2 failed | 30 passed`
   - Expected failures:
     - `posts state updates for error responses that still include refreshed state`
     - `rejects inherited template ids without creating a task`

2. **PASS**  
   `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts test/panel.test.ts`  
   - Result: `32 passed`

3. **PASS**  
   `cd packages/vscode-extension && pnpm exec tsc -p tsconfig.json --noEmit`  
   - Result: no errors

4. **PASS**  
   `cd packages/vscode-extension/webview-ui && pnpm vitest run src/bridge.test.ts src/App.test.tsx`  
   - Result: `11 passed`

5. **PASS**  
   `cd packages/vscode-extension/webview-ui && pnpm exec tsc -p tsconfig.json --noEmit`  
   - Result: no errors

### Concerns / Self-Review

- The fix intentionally keeps the request-level rejection semantics unchanged: callers still receive an error for partial template seeding, but the hydrated state now makes the created task visible/selectable immediately.
- `App.tsx` / `App.test.tsx` were touched only to satisfy webview-ui TypeScript validation introduced by the new bridge-focused coverage.
- Pre-existing optional activity bar hardening changes remained unstaged.
