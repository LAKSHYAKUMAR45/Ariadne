# Task 2 report — Safe Git-aware capture engine

## Outcome

Implemented `packages/core/src/FileCapture.ts`, a synchronous, Git-aware,
secret-safe task file capture engine, and wired it into `syncTaskGit` so every
newly recorded commit produces an immutable capture — with failures surfaced and
recorded rather than silently swallowed.

## What changed

- **New `packages/core/src/FileCapture.ts`**
  - `captureTaskFiles(store, request, limits?): CaptureResult` — synchronous per
    the ledger ruling; `syncTaskGit` and its CLI/MCP callers stay synchronous.
  - All Git access goes through `execFileSync('git', ['-C', workspace, ...])`
    with fixed argument arrays (no shell, no interpolation), matching
    `GitWatcher`; `maxBuffer` raised to 64 MiB so the 10 MiB aggregate limit is
    reachable.
  - Candidate sets:
    - `git_commit`: `diff-tree --no-commit-id --name-only -r -z --root <sha>`
      plus an `ls-tree -r -z <sha>` mode map (deletion + symlink detection).
    - `checkpoint` / `explicit`: `TaskStore.listFiles(taskId)` intersected with
      `ls-files -z` (so untracked and git-ignored files are never eligible).
  - Content/diff sources follow the ledger ruling:
    - commit captures read the exact blob via `git show <sha>:<path>` and diff
      against the first parent, or the empty tree (`--- /dev/null`) for a root
      commit;
    - checkpoint/explicit captures read the current worktree and diff against
      `HEAD` (worktree-vs-index when the repo has no commits yet).
  - Always-excluded paths (`isAlwaysExcludedCapturePath`, exported for direct
    testing): `.git/`, `node_modules/`, `dist/`, `build/`, `.ariadne/`, `.env`
    and `.env.*`, `*.pem`, `*.key`, and any segment matching
    credential/token/secret/password/api-key.
  - `.ariadneignore` support (comments, directory patterns, globs, basename
    patterns).
  - Path handling: absolute/Windows/dot-relative inputs normalize to canonical
    POSIX repo-relative paths; anything escaping the canonical (realpath'd)
    workspace root — including via symlinked parents — is skipped.
  - Safety filters: tracked-only, no symlinks, NUL-byte or strict-UTF-8-failure
    means binary, inclusive 1 MiB per-file and 10 MiB aggregate limits, SHA-256
    over UTF-8 bytes.
  - Returns `{ capture: null, skipped }` when nothing is eligible (no empty
    capture rows), and throws for a non-Git workspace or a trigger missing its
    required reference.

- **`packages/core/src/GitWatcher.ts`**
  - After each new commit *and* its touched-file records are committed locally,
    `captureTaskFiles(..., trigger: 'git_commit', gitCommitSha: sha)` runs.
  - `SyncGitResult` gains additive `captures` and `captureFailures` fields;
    `options` gains optional `captureLimits`. Existing fields, function
    signatures, and all callers are unchanged.
  - A capture failure is recorded as an Ariadne error (`store.recordError`) and
    returned in `captureFailures`; no capture row is created, so the commit is
    never silently marked as captured.

- **`packages/core/src/index.ts`** — exports `captureTaskFiles`,
  `isAlwaysExcludedCapturePath`, `DEFAULT_CAPTURE_LIMITS`, the capture types, and
  `GitCaptureFailure`.

## TDD evidence

1. **RED**
   - `packages/core/test/FileCapture.test.ts` (39 tests) covering eligibility,
     untouched/untracked/ignored/symlink/binary/outside-root exclusion, the
     always-excluded matrix, `.ariadneignore`, exact inclusive per-file and
     aggregate boundaries, commit-blob vs worktree content, first-parent and
     `/dev/null` diffs, deleted-in-commit files, commit idempotency, checkpoint
     worktree snapshots, POSIX path canonicalization, and failure modes.
   - `packages/core/test/GitWatcher.test.ts` gains 3 tests: captures per new
     commit (commit blob, not drifted worktree), no duplicate captures on
     re-sync, and surfaced + recorded capture failure with no capture row.
   - Verified failing before implementation:
     - `pnpm --filter @ariadne-dev/core exec vitest run test/FileCapture.test.ts`
       (module missing)
     - `pnpm --filter @ariadne-dev/core exec vitest run test/GitWatcher.test.ts`
       (3 failed | 9 passed)

2. **GREEN**
   - `pnpm --filter @ariadne-dev/core exec vitest run test/FileCapture.test.ts test/GitWatcher.test.ts`
     → 51 passed.

3. **Validation**
   - Full core suite: `pnpm --filter @ariadne-dev/core exec vitest run` →
     19 files, 218 tests passed.
   - Typecheck: `pnpm --filter @ariadne-dev/core exec tsc -p tsconfig.json --noEmit` → clean.
   - Workspace build: `pnpm -r build` → all packages built.

## Notes / deviations

- The brief's `TaskStore.getFiles(taskId)` does not exist; the real API is
  `listFiles(taskId)`, which is what the engine uses.
- The brief's `diff-tree` array omits `--root`; it is required so a root
  commit's files are listed at all (and then diffed against `/dev/null`), so it
  was added, consistent with the existing `listCommitFiles`.
- The Promise-returning signature in the brief was treated as illustrative per
  the binding ruling; the implementation is synchronous.

## Fix round 1/5

The full fix report was accidentally written to the persistent session artifact
`/home/lkumar/.copilot/session-state/659c54a0-6f22-46fd-85ee-9dfeb4a993d9/files/nodem2-cloud-rulings.md`
under `Plan 02 Task 2 review-fix report (2026-09-21)`. It records the RED
regressions and implementation for historical deleted directories, expanded
secret exclusions, literal pathspecs, commit symlinks, explicit Git failures,
and capture-function decomposition.

Validation reported by the implementer:

```text
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/core exec vitest run
  252 tests passed
pnpm --filter @ariadne-dev/cli build
pnpm --filter @ariadne-dev/cli exec vitest run
  83 tests passed
pnpm --filter @ariadne-dev/mcp-server build
pnpm --filter @ariadne-dev/mcp-server exec vitest run
  53 tests passed
```

Commit: `e383341 fix(core): harden git-aware task file capture`.

## 2026-09-21 review-fix round 2

Addressed the commit-candidate regression where commit captures correctly
rejected symlinks (`120000`) but still treated gitlinks/submodule pointers
(`160000`) like blobs, causing `git cat-file blob <commit-oid>` to fail and
abort the entire capture.

- **Commit capture now whitelists regular blob modes and explicitly skips
  gitlinks.**
  - `packages/core/src/FileCapture.ts`
    - added `gitlink` and `unsupported_git_mode` skip reasons
    - classified commit-tree mode `160000` as `gitlink`
    - only allows regular blob modes `100644` / `100755` through to blob reads
    - leaves symlink handling unchanged for `120000`
- **Built-in secret-segment checks now lowercase once before matching.**
  - exact built-in segment/name checks and the secret-word pattern all run on a
    normalized lowercase segment, making the built-in secret matching behavior
    explicitly case-insensitive.
- **Metacharacter tests now skip explicitly instead of silently returning.**
  - the two pathspec-safety tests call Vitest's runtime `skip()` when the host
    filesystem cannot create those filenames.

### Round-2 RED/GREEN evidence

1. **RED**
   - Added a real Git regression in `packages/core/test/FileCapture.test.ts`
     that commits:
     - a normal tracked text file
     - a real gitlink/submodule pointer created with
       `git update-index --cacheinfo 160000,<sha>,vendor/submodule`
   - Added the matching `packages/core/test/GitWatcher.test.ts` regression to
     prove `syncTaskGit` captures the normal file and reports no
     `captureFailures`.
   - Added a direct case-insensitive secret-segment test.
   - Verified failure before the fix with:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/core && pnpm exec vitest run test/FileCapture.test.ts test/GitWatcher.test.ts`
     - failure was the expected `git cat-file blob <gitlink-oid>` abort.

2. **GREEN**
   - Implemented commit-mode classification and reran the same targeted command
     successfully: 88 tests passed.

3. **Validation**
   - Full core suite:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/core && pnpm exec vitest run`
     - 19 files, 255 tests passed
   - Core build:
     - `cd /home/lkumar/Ariadne/.worktrees/nodem2-cloud/packages/core && pnpm run build`

### Deferred by request

- Batch Git-process optimization remains deferred. The fix keeps the current
  one-file-at-a-time `git cat-file` / `git diff` flow and only hardens mode
  classification and test coverage.
