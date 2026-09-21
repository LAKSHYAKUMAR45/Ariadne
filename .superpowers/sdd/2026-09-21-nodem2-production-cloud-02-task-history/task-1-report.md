# Task 1 report

## Outcome

Implemented local immutable task file capture storage in `@ariadne-dev/core` with schema migration **v5**, typed TaskStore APIs, trigger-specific idempotency, and RED→GREEN validation.

## What changed

- Added new core types in `packages/core/src/types.ts`:
  - `FileCaptureTrigger`
  - `TaskFileCapture`
  - `TaskFileCaptureEntry`
  - `NewTaskFileCaptureEntry`
  - `TaskFileCaptureWithEntries`
  - `CreateTaskFileCaptureInput`
- Bumped `SCHEMA_VERSION` from `4` to `5` in `packages/core/src/schema.ts`.
- Added migration `v5` in `packages/core/src/migrations.ts`:
  - creates `task_file_captures`
  - creates `task_file_capture_entries`
  - adds partial unique indexes for:
    - `(task_id, git_commit_sha)` when `trigger = 'git_commit'`
    - `(task_id, checkpoint_id)` when `trigger = 'checkpoint'`
  - leaves `explicit` captures fully append-only/distinct
- Added immutable TaskStore APIs in `packages/core/src/TaskStore.ts`:
  - `createTaskFileCapture`
  - `getTaskFileCaptures`
  - `getPendingTaskFileCaptures`
  - `markTaskFileCaptureSynced`
- Kept entries immutable after insertion by storing them once and always returning fresh object/array copies from reads.
- Preserved existing exports without changing `packages/core/src/index.ts`; `export * from './types.js'` already exposes the new types.

## TDD notes

1. **RED**
   - Added migration coverage for schema v5, row preservation, and partial-index idempotency.
   - Added TaskStore coverage for explicit capture creation, pending/synced transitions, duplicate `git_commit`/`checkpoint` idempotency, explicit-event distinctness, and entry immutability.
   - Verified failure in the worktree with:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run test/migrations.test.ts test/TaskStore.test.ts`

2. **GREEN**
   - Implemented migration and store API until targeted tests passed.

3. **IMPROVE**
   - Centralized capture row mapping and grouped capture-entry loading.
   - Added trigger validation for missing `gitCommitSha` / `checkpointId`.
   - Returned defensive copies from create/list reads to prevent caller mutation from affecting persisted state.

## Validation

- Targeted RED/GREEN run:
  - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run test/migrations.test.ts test/TaskStore.test.ts`
- Full core suite:
  - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run`

Both passed.

## 2026-09-21 review-fix follow-up

Addressed the Task 1 review findings with a focused schema/store fix:

- **Capture sync state is now independent of task sync state.**
  - Removed the `createTaskFileCapture()` → `touchTask()` coupling in `packages/core/src/TaskStore.ts`.
  - Added a regression showing a synced task stays out of `listTasksNeedingPush()` and keeps the same `updatedAt` before/after creating and acknowledging a file capture.

- **Task-file-capture refs now have same-task DB integrity.**
  - Bumped schema version to **6**.
  - Added composite unique indexes on `commits(sha, task_id)` and `checkpoints(id, task_id)`.
  - Rebuilt `task_file_captures` in migration v6 so SQLite enforces:
    - `(git_commit_sha, task_id) -> commits(sha, task_id)`
    - `(checkpoint_id, task_id) -> checkpoints(id, task_id)`
  - Kept trigger-specific nullability rules with a table `CHECK`, and preserved the existing partial uniqueness for idempotent `git_commit` / `checkpoint` captures.

### Review-fix evidence

1. **RED**
   - Added failing tests for:
     - capture create/ack not mutating parent task `updatedAt` or push eligibility
     - nonexistent git-commit/checkpoint refs
     - cross-task git-commit/checkpoint refs
     - valid same-task refs
   - Verified failure with:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run test/migrations.test.ts test/TaskStore.test.ts`

2. **GREEN**
   - Implemented migration v6 and removed the capture/task sync coupling.
   - Re-ran targeted tests successfully with the same command above.

3. **Validation**
   - Full core suite passed:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run`

SQLite supported the requested composite-foreign-key design directly, so no fallback integrity design was needed.

## 2026-09-21 review-fix round 2

Addressed the follow-up migration finding by removing the artificial `v5 → v6`
upgrade path and folding the same-task integrity rules into the first shipped
capture migration.

- **Schema version returned to `5`.**
  - Removed migration `v6`.
  - Set `packages/core/src/schema.ts` back to `SCHEMA_VERSION = 5`.

- **Migration `v5` now ships the final integrity model directly.**
  - Creates composite unique indexes on:
    - `commits(sha, task_id)`
    - `checkpoints(id, task_id)`
  - Creates `task_file_captures` with:
    - the trigger-shape `CHECK`
    - composite foreign keys enforcing same-task refs
    - the existing partial unique indexes for `git_commit` / `checkpoint`
      idempotency
  - Leaves capture/task sync-state decoupling unchanged.

### Round-2 evidence

1. **RED**
   - Reworked migration coverage to assert the real shipped path:
     - migrate `v4 -> v5`
     - preserve existing v4 task/checkpoint/decision rows
     - allow valid same-task commit/checkpoint refs
     - reject missing and cross-task refs
     - no `v6` expectations remain
   - Verified failure before the code change with:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run test/migrations.test.ts test/TaskStore.test.ts`

2. **GREEN**
   - Collapsed the integrity logic into migration `v5`.
   - Removed the table-rebuild migration entirely.
   - Re-ran the same targeted command successfully.

3. **Validation**
   - Full core suite passed:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud && pnpm --filter @ariadne-dev/core exec vitest run`
