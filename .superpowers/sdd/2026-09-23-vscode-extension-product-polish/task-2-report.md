# Task 2 Report

- **Status:** DONE
- **Commit(s):** `fae7dd7` (`feat: add vscode activity and context panels`)

## Files changed

- `packages/vscode-extension/src/extension.ts`
- `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- `packages/vscode-extension/src/webview/messages.ts`
- `packages/vscode-extension/src/webview/panel.ts`
- `packages/vscode-extension/test/panel.test.ts`
- `packages/vscode-extension/test/webviewMessage.test.ts`
- `packages/vscode-extension/webview-ui/src/App.test.tsx`
- `packages/vscode-extension/webview-ui/src/App.tsx`
- `packages/vscode-extension/webview-ui/src/panels/ActivityPanel.tsx`
- `packages/vscode-extension/webview-ui/src/panels/ContextPanel.tsx`
- `packages/vscode-extension/webview-ui/src/panels/OverviewPanel.tsx`
- `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

## Rulings

- **Host wiring beyond the brief file list:** the brief's step-8 `git add` list did not include `src/extension.ts`, `src/webview/panel.ts`, or `test/panel.test.ts`, but Task 2 explicitly required host support for `context.copy` and `context.open` with injected dependencies. I implemented and tested those files to satisfy the requirement while keeping the scope limited to Task 2.
- **Overview handoff surface:** the previous Overview panel "Resume context" section overlapped with the new dedicated Activity and Context tabs. I replaced that inline handoff UI with guidance pointing users to the new tabs so the product polish intent stays consistent.

## Tests run

1. **RED / expected fail**
   - `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx`
   - **FAIL** — missing `./ActivityPanel` import target, confirming the new panel tests failed before implementation.

2. **Task brief required webview tests**
   - `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx`
   - **PASS** — `2` files, `26` tests passed.

3. **Task brief required host dispatcher tests**
   - `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`
   - **PASS** — `1` file, `17` tests passed.

4. **Targeted host wiring validation for changed panel code**
   - `cd packages/vscode-extension && pnpm vitest run test/panel.test.ts`
   - **PASS** — `1` file, `5` tests passed.

5. **Targeted typecheck for changed extension-host files**
   - `cd packages/vscode-extension && pnpm exec tsc --noEmit`
   - **PASS**

6. **Targeted typecheck for changed React webview files**
   - `cd packages/vscode-extension/webview-ui && pnpm exec tsc --noEmit`
   - **PASS**

## Concerns / self-review

- **No blocking concerns.** Activity and Context are now dedicated tabs, task-switch-safe request guards are in place, and `context.copy` / `context.open` are handled through host-injected clipboard/editor helpers instead of direct webview access.
- **Scope guard respected:** I did not stage or commit the pre-existing optional Activity Bar icon hardening changes in `packages/vscode-extension/package.json`, `packages/vscode-extension/test/extension.test.ts`, or `packages/vscode-extension/resources/activitybar.svg`.

---

## Fix round 1

- **Status:** DONE

### Findings addressed

1. **Critical — stale budget response guard**
   - `ContextPanel` now invalidates the active preview generation on every token-budget input change, so a slow preview response for an older budget cannot populate after the user edits the field.

2. **Important — busy state clearing on invalidation**
   - `ContextPanel` now tracks the active preview generation separately and clears `onBusy(undefined)` when an in-flight preview is invalidated by task/budget changes, without allowing stale completions to clear a newer request's busy state.

3. **Important — capture health without current task**
   - `ActivityPanel` now always requests/render `capture.health`, even when `taskId` is undefined. The panel correctly shows the host-provided no-current-task warning and unknown branch state while `activity.list` remains empty.

### Files changed in fix round 1

- `packages/vscode-extension/webview-ui/src/panels/ActivityPanel.tsx`
- `packages/vscode-extension/webview-ui/src/panels/ContextPanel.tsx`
- `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

### Tests run in fix round 1

1. **RED / expected fail**
   - `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx`
   - **FAIL** — new regression tests failed before implementation:
     - stale budget response rendered old preview
     - busy state stayed set after invalidation
     - no-current-task capture health stayed in loading state

2. **Focused validation after fixes**
   - `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx`
   - **PASS** — `2` files, `29` tests passed.

3. **Targeted typecheck**
   - `cd packages/vscode-extension/webview-ui && pnpm exec tsc --noEmit`
   - **PASS**

### Concerns / self-review for fix round 1

- **No blocking concerns.** The invalidation logic is now explicit: changing tasks or budget clears stale preview state, clears busy only for the invalidated request, and preserves correctness for any newer preview request.
- **Scope guard still respected:** the pre-existing optional Activity Bar icon hardening changes in `packages/vscode-extension/package.json`, `packages/vscode-extension/test/extension.test.ts`, and `packages/vscode-extension/resources/activitybar.svg` remain unstaged and uncommitted.
