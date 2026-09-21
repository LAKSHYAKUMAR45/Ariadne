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
