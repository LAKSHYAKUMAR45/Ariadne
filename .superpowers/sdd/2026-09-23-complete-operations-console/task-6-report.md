# Task 6 Report — Guarded Task Capture Deletion

## RED evidence

- Added failing coverage in `packages/dashboard/src/tasks/TasksPage.test.tsx` for guarded capture deletion, exact confirmation, reauthentication, operation progress, cancellation, aborts, and refresh-confirmed removal.
- `pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks/TasksPage.test.tsx`
  - **Failed as expected** before implementation: `TasksPage > shows delete controls only for the selected capture and removes it only after a refreshed timeline confirms success`
  - First failure: `Unable to find role="button" and name "Delete capture capture-1"`

## GREEN evidence

- `pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks/TasksPage.test.tsx`
  - **Passed**: 5 tests
- `pnpm --filter @ariadne-dev/dashboard exec vitest run src/tasks`
  - **Passed**: 5 tests
- `pnpm --filter @ariadne-dev/dashboard exec tsc --noEmit`
  - **Passed**
- `pnpm --filter @ariadne-dev/dashboard exec vitest run src/components/ConfirmationDialog.test.tsx`
  - **Passed**: 2 tests

## Files changed

- `.superpowers/sdd/2026-09-23-complete-operations-console/task-6-report.md`
- `packages/dashboard/src/components/ConfirmationDialog.tsx`
- `packages/dashboard/src/components/OperationProgress.tsx`
- `packages/dashboard/src/styles/global.css`
- `packages/dashboard/src/tasks/CaptureDeleteDialog.tsx`
- `packages/dashboard/src/tasks/TasksPage.test.tsx`
- `packages/dashboard/src/tasks/TasksPage.tsx`

## Commit

- `7998f37` — `feat(dashboard): add guarded capture deletion`

## Self-review

- Reused the shared `ConfirmationDialog` and `OperationProgress` rather than duplicating confirmation or operation-state handling.
- The delete flow only appears for the actively selected capture, requires exact `DELETE <captureId>` confirmation, and prompts for password reauthentication when the session is not fresh.
- Decrypted plaintext is cleared immediately on task switch and on successful deletion; the capture row itself stays visible until the refreshed server timeline confirms removal.
- Pending delete requests are aborted on task changes, and focus moves to the next available capture after a successful refresh.
- Added mobile-pane state so narrow layouts return to the timeline with a success status instead of leaving an empty file inspector.

## Concerns

- `pnpm --filter @ariadne-dev/dashboard exec vitest run src/components/ConfirmationDialog.test.tsx src/operations/OperationsPages.test.tsx` still reports an **unrelated** pre-existing failure in `src/operations/OperationsPages.test.tsx` (`Unable to find an element with the text: Operational`) inside the overview test, not in the touched task-deletion flow.
