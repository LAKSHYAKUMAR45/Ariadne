# Task 2 Report — Make queue ownership project-scoped and renewable

## Status
Completed on branch `feat/ariadne-knowledge-wiki-plan`.

## Commit
- `a3bff8f` — `fix(knowledge): scope queue leases to projects`

## Files Changed
- `packages/core/src/index.ts`
- `packages/core/src/knowledge/KnowledgeQueue.ts`
- `packages/core/test/knowledge/KnowledgeQueue.test.ts`
- `packages/cli/src/knowledgeCommands.ts`
- `packages/cli/test/knowledgeCommands.test.ts`
- `packages/mcp-server/src/knowledgeTools.ts`
- `packages/mcp-server/test/knowledgeTools.test.ts`

## What Changed
- Scoped `KnowledgeQueue.claim()` to `projectId` and updated its SQL selection/update guards.
- Added `KnowledgeJobResult` persistence on `complete()` and redacted warning messages before storing `knowledge_jobs.result_json`.
- Added `renewLease(jobId, workerId)`, project-aware `recoverExpiredKnowledgeJobs(projectId?)`, and `getQueueStatus(projectId)`.
- Exposed new queue result/status types from `@ariadne-dev/core`.
- Updated CLI queue claim to pass the positional project ID.
- Tightened MCP queue cancellation so a caller must supply the owning project ID and cannot mutate another project’s job.
- Added cross-project and lease-renewal coverage in core/CLI/MCP tests.

## RED Evidence
### 1) Initial failing queue test run after writing tests first
Command:
```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts
```
Output excerpt:
```text
FAIL  test/knowledge/KnowledgeQueue.test.ts > KnowledgeQueue > persists enqueue, claim, completion, and progress events
AssertionError: expected { … } to match object { … }
-   "workerId": "worker-a",
+   "workerId": "project_1"

FAIL  test/knowledge/KnowledgeQueue.test.ts > KnowledgeQueue > claims jobs within a project, renews leases for the owning worker, and reports project-scoped status
AssertionError: expected 'project_1' to be 'project_2'
```
This demonstrated the old `claim(workerId)` behavior was still active and not project-scoped.

### 2) Iteration issue caught by tests
Command:
```bash
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts && pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts && pnpm --filter @ariadne-dev/mcp-server test -- knowledgeTools.test.ts
```
Output excerpt:
```text
FAIL  test/knowledge/KnowledgeQueue.test.ts > KnowledgeQueue > claims jobs within a project, renews leases for the owning worker, and reports project-scoped status
Error: Knowledge job ... is owned by another worker
```
I fixed the test setup to ensure deterministic per-project claim ordering.

## GREEN Evidence
### Targeted/build validation used during implementation
Commands:
```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/cli build
pnpm --filter @ariadne-dev/mcp-server build
pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts
pnpm --filter @ariadne-dev/cli test -- knowledgeCommands.test.ts
pnpm --filter @ariadne-dev/mcp-server test -- knowledgeTools.test.ts
```
Passing output excerpts:
```text
> @ariadne-dev/core@0.1.0 build ...
> tsc -p tsconfig.json

> @ariadne-dev/cli@0.1.0 build ...
> tsc -p tsconfig.json

> @ariadne-dev/mcp-server@0.1.0 build ...
> tsc -p tsconfig.json

Test Files  54 passed (54)
Tests  399 passed (399)

Test Files  12 passed (12)
Tests  115 passed (115)

Test Files  7 passed (7)
Tests  68 passed (68)
```

## Final Full Validation Before Commit
Command:
```bash
pnpm --filter @ariadne-dev/core build && \
  pnpm --filter @ariadne-dev/cli build && \
  pnpm --filter @ariadne-dev/mcp-server build && \
  pnpm --filter @ariadne-dev/core test && \
  pnpm --filter @ariadne-dev/cli test && \
  pnpm --filter @ariadne-dev/mcp-server test
```
Output excerpt:
```text
> @ariadne-dev/core@0.1.0 build ...
> tsc -p tsconfig.json
> @ariadne-dev/cli@0.1.0 build ...
> tsc -p tsconfig.json
> @ariadne-dev/mcp-server@0.1.0 build ...
> tsc -p tsconfig.json

Test Files  54 passed (54)
Tests  399 passed (399)

Test Files  12 passed (12)
Tests  115 passed (115)

Test Files  7 passed (7)
Tests  68 passed (68)
```

## Self-Review
- Verified both `SELECT` and `UPDATE` in `claim()` are project-scoped, matching the brief.
- Verified lease renewal requires `status='running'` and matching `worker_id`.
- Verified queue recovery can be scoped to a project and does not recover other projects when a project ID is supplied.
- Verified job completion persists `result_json` and uses shared redaction for persisted warning messages.
- Verified CLI `knowledge queue claim <project-id>` now routes the project ID into the shared queue API.
- Verified MCP cannot cancel a job through a different project context.
- Verified no unrelated command behavior was changed outside the scoped queue claim/cancel surfaces and their tests.

## Diff Summary
```text
 packages/cli/src/knowledgeCommands.ts              |   4 +-
 packages/cli/test/knowledgeCommands.test.ts        |  37 ++++-
 packages/core/src/index.ts                         |   2 +
 packages/core/src/knowledge/KnowledgeQueue.ts      | 181 +++++++++++++++++++--
 packages/core/test/knowledge/KnowledgeQueue.test.ts| 103 ++++++++++--
 packages/mcp-server/src/knowledgeTools.ts          |   7 +-
 packages/mcp-server/test/knowledgeTools.test.ts    |  36 ++++
```

## Concerns
- CLI test output still includes pre-existing noisy stderr/log lines from unrelated passing tests (`running tests... AssertionError: expected 1 to be 2` and cross-workspace notices). The suites still pass cleanly, but the noise may merit separate cleanup.
- CLI/MCP tests depend on rebuilt `@ariadne-dev/core` outputs; I therefore ran the required package builds before final test validation.

## Fix Round 1

### Changes
- Made `recoverExpiredKnowledgeJobs(projectId?)` perform candidate selection and recovery updates inside a single transaction.
- Added the lease-expiration compare-and-swap predicate to every recovery `UPDATE` so renewed leases are not stolen.
- Only append a recovered job ID when the recovery `UPDATE` changed exactly one row.
- Added a focused regression test that renews the lease after candidate selection and proves the job stays `running` and is not reported recovered.

### Validation

Command:
```bash
cd /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki && pnpm --filter @ariadne-dev/core test -- KnowledgeQueue.test.ts
```
Output:
```text
> @ariadne-dev/core@0.1.0 test /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core
> vitest run -- KnowledgeQueue.test.ts


 RUN  v3.2.7 /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core

 ✓ test/ContextBuilder.test.ts (11 tests) 143ms
 ✓ test/knowledge/knowledgeMigrations.test.ts (5 tests) 288ms
 ✓ test/CheckpointEngine.test.ts (16 tests) 230ms
 ✓ test/knowledge/KnowledgeSearch.test.ts (8 tests) 171ms
 ✓ test/knowledge/KnowledgeSourceWatcher.test.ts (4 tests) 284ms
 ✓ test/TaskStore.test.ts (37 tests) 424ms
 ✓ test/concurrency.test.ts (2 tests) 464ms
 ✓ test/knowledge/KnowledgeChat.test.ts (10 tests) 194ms
 ✓ test/knowledge/KnowledgeGeneratorService.test.ts (4 tests) 409ms
 ✓ test/workspace.test.ts (6 tests) 725ms
   ✓ workspace resolution > persists and reads back the current task id  370ms
 ✓ test/knowledge/KnowledgeResearch.test.ts (5 tests) 120ms
 ✓ test/knowledge/KnowledgeQueue.test.ts (8 tests) 202ms
 ✓ test/Search.test.ts (7 tests) 152ms
 ✓ test/knowledge/KnowledgeReview.test.ts (3 tests) 43ms
 ✓ test/ContextBuilderEmbeddingRanking.test.ts (10 tests) 69ms
 ✓ test/knowledge/KnowledgeExtractionStore.test.ts (6 tests) 66ms
 ✓ test/knowledge/TaskKnowledgeProjection.test.ts (4 tests) 91ms
 ✓ test/knowledge/KnowledgeOutputs.test.ts (4 tests) 81ms
 ✓ test/knowledge/KnowledgeArchive.test.ts (3 tests) 67ms
 ✓ test/knowledge/KnowledgeSourceScanner.test.ts (3 tests) 88ms
 ✓ test/knowledge/KnowledgeProjectStore.test.ts (2 tests) 31ms
 ✓ test/knowledge/graph/KnowledgeGraph.test.ts (3 tests) 43ms
 ✓ test/knowledge/KnowledgeReconciliation.test.ts (5 tests) 90ms
 ✓ test/knowledge/KnowledgeSourceStore.test.ts (3 tests) 43ms
 ✓ test/knowledge/KnowledgeManifest.test.ts (2 tests) 32ms
 ✓ test/CheckpointEngineSummarizer.test.ts (5 tests) 50ms
 ✓ test/migrations.test.ts (9 tests) 48ms
 ✓ test/Exporter.test.ts (3 tests) 38ms
 ✓ test/CrossRepoLinks.test.ts (10 tests) 1691ms
 ✓ test/knowledge/graph/KnowledgeGraphTraversal.test.ts (3 tests) 52ms
 ✓ test/knowledge/KnowledgeProviders.test.ts (5 tests) 11ms
 ✓ test/knowledge/KnowledgePageStore.test.ts (2 tests) 31ms
 ✓ test/knowledge/KnowledgeProvenance.test.ts (2 tests) 25ms
 ✓ test/knowledge/KnowledgeSkills.test.ts (5 tests) 43ms
 ✓ test/gitignore.test.ts (6 tests) 17ms
 ✓ test/knowledge/KnowledgeOperationLog.test.ts (3 tests) 33ms
 ✓ test/knowledge/graph/KnowledgeCommunities.test.ts (2 tests) 23ms
 ✓ test/knowledge/graph/KnowledgeInsights.test.ts (2 tests) 29ms
 ✓ test/Graphify.test.ts (8 tests) 16ms
 ✓ test/knowledge/KnowledgeRenderer.test.ts (2 tests) 13ms
 ✓ test/knowledge/KnowledgeAnalysis.test.ts (4 tests) 9ms
 ✓ test/PluginRegistry.test.ts (7 tests) 9ms
 ✓ test/knowledge/formats/DocumentIngestor.test.ts (3 tests) 6ms
 ✓ test/Redactor.test.ts (13 tests) 7ms
 ✓ test/knowledge/SourcePolicy.test.ts (3 tests) 6ms
 ✓ test/knowledge/KnowledgeTypes.test.ts (5 tests) 8ms
 ✓ test/knowledge/formats/MediaIngestor.test.ts (3 tests) 6ms
 ✓ test/knowledge/GraphifyImport.test.ts (2 tests) 6ms
 ✓ test/knowledge/KnowledgeEmbeddings.test.ts (3 tests) 9ms
 ✓ test/knowledge/formats/Ingestors.test.ts (5 tests) 10ms
 ✓ test/GitWatcher.test.ts (17 tests) 3135ms
   ✓ GitWatcher > syncTaskGit records new commits oldest-first and dedupes already-recorded ones  442ms
 ✓ test/Registry.test.ts (9 tests) 3632ms
   ✓ Registry (cross-workspace task index) > TaskStore linked to a workspaceRoot keeps the registry in sync automatically on create/status/branch/touch  620ms
   ✓ Registry (cross-workspace task index) > openWorkspaceStore backfills all of a workspace's existing tasks into the registry on open  339ms
   ✓ Registry (cross-workspace task index) > two separate workspaces both show up in the registry after each is opened  852ms
   ✓ Registry (cross-workspace task index) > forgetWorkspace removes a workspace root and all of its indexed tasks  588ms
   ✓ Registry (cross-workspace task index) > pruneMissingWorkspaces removes only workspaces whose directory no longer exists on disk  532ms
 ✓ test/FileCapture.test.ts (78 tests) 6144ms
 ✓ test/CrossWorkspace.test.ts (10 tests) 11280ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > listTasksAcrossWorkspaces sees tasks from multiple workspaces  583ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > listKnownWorkspaces lists every workspace root that has been opened  757ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces finds matches across multiple workspaces and tags each with its workspace root  764ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces skips a workspace whose directory no longer exists  756ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces defaults to recent workspaces only, but can explicitly scan everything  6848ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > resolveTaskAnyWorkspace transparently opens the owning workspace when the task is elsewhere  450ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces does not write a .gitignore into workspaces it only reads from  322ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > resolveTaskAnyWorkspace does not write a .gitignore into the other workspace it transparently opens  340ms

 Test Files  54 passed (54)
      Tests  400 passed (400)
   Start at  00:43:44
   Duration  12.14s (transform 2.62s, setup 734ms, collect 10.53s, tests 30.94s, environment 13ms, prepare 5.41s)
```

Command:
```bash
cd /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki && pnpm --filter @ariadne-dev/core test
```
Output:
```text
> @ariadne-dev/core@0.1.0 test /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core
> vitest run


 RUN  v3.2.7 /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core

 ✓ test/CheckpointEngine.test.ts (16 tests) 131ms
 ✓ test/knowledge/KnowledgeQueue.test.ts (8 tests) 88ms
 ✓ test/knowledge/KnowledgeSearch.test.ts (8 tests) 157ms
 ✓ test/knowledge/knowledgeMigrations.test.ts (5 tests) 311ms
 ✓ test/knowledge/KnowledgeChat.test.ts (10 tests) 179ms
 ✓ test/knowledge/KnowledgeSourceWatcher.test.ts (4 tests) 253ms
 ✓ test/TaskStore.test.ts (37 tests) 413ms
 ✓ test/knowledge/KnowledgeGeneratorService.test.ts (4 tests) 368ms
 ✓ test/concurrency.test.ts (2 tests) 667ms
   ✓ concurrent TaskStore access to the same db file > interleaves writes from two connections without data loss or corruption  335ms
   ✓ concurrent TaskStore access to the same db file > reopening a fresh connection after another closes sees all committed writes  330ms
 ✓ test/Search.test.ts (7 tests) 83ms
 ✓ test/ContextBuilder.test.ts (11 tests) 148ms
 ✓ test/knowledge/KnowledgeSourceScanner.test.ts (3 tests) 45ms
 ✓ test/knowledge/KnowledgeResearch.test.ts (5 tests) 108ms
 ✓ test/knowledge/KnowledgeReconciliation.test.ts (5 tests) 85ms
 ✓ test/knowledge/KnowledgeOutputs.test.ts (4 tests) 75ms
 ✓ test/knowledge/TaskKnowledgeProjection.test.ts (4 tests) 84ms
 ✓ test/workspace.test.ts (6 tests) 988ms
   ✓ workspace resolution > persists and reads back the current task id  317ms
   ✓ workspace resolution > prefers the DB value over a stale legacy file if both somehow exist  352ms
 ✓ test/ContextBuilderEmbeddingRanking.test.ts (10 tests) 82ms
 ✓ test/knowledge/graph/KnowledgeGraphTraversal.test.ts (3 tests) 40ms
 ✓ test/knowledge/KnowledgeArchive.test.ts (3 tests) 102ms
 ✓ test/CheckpointEngineSummarizer.test.ts (5 tests) 94ms
 ✓ test/knowledge/graph/KnowledgeGraph.test.ts (3 tests) 32ms
 ✓ test/knowledge/KnowledgeSkills.test.ts (5 tests) 37ms
 ✓ test/knowledge/KnowledgeExtractionStore.test.ts (6 tests) 73ms
 ✓ test/migrations.test.ts (9 tests) 108ms
 ✓ test/knowledge/KnowledgeSourceStore.test.ts (3 tests) 62ms
 ✓ test/knowledge/KnowledgeReview.test.ts (3 tests) 64ms
 ✓ test/knowledge/KnowledgeOperationLog.test.ts (3 tests) 33ms
 ✓ test/Exporter.test.ts (3 tests) 39ms
 ✓ test/knowledge/KnowledgeProjectStore.test.ts (2 tests) 39ms
 ✓ test/knowledge/KnowledgeManifest.test.ts (2 tests) 97ms
 ✓ test/knowledge/KnowledgeProvenance.test.ts (2 tests) 19ms
 ✓ test/knowledge/graph/KnowledgeCommunities.test.ts (2 tests) 24ms
 ✓ test/knowledge/graph/KnowledgeInsights.test.ts (2 tests) 27ms
 ✓ test/knowledge/KnowledgePageStore.test.ts (2 tests) 29ms
 ✓ test/gitignore.test.ts (6 tests) 56ms
 ✓ test/knowledge/KnowledgeProviders.test.ts (5 tests) 10ms
 ✓ test/knowledge/KnowledgeRenderer.test.ts (2 tests) 13ms
 ✓ test/Graphify.test.ts (8 tests) 19ms
 ✓ test/CrossRepoLinks.test.ts (10 tests) 2214ms
   ✓ CrossRepoLinks (task_links / task_link_groups) > linkTaskToGroup requires the group to exist  369ms
 ✓ test/PluginRegistry.test.ts (7 tests) 8ms
 ✓ test/knowledge/KnowledgeAnalysis.test.ts (4 tests) 7ms
 ✓ test/Redactor.test.ts (13 tests) 10ms
 ✓ test/knowledge/KnowledgeTypes.test.ts (5 tests) 8ms
 ✓ test/knowledge/KnowledgeEmbeddings.test.ts (3 tests) 9ms
 ✓ test/knowledge/formats/MediaIngestor.test.ts (3 tests) 6ms
 ✓ test/knowledge/formats/DocumentIngestor.test.ts (3 tests) 10ms
 ✓ test/knowledge/SourcePolicy.test.ts (3 tests) 8ms
 ✓ test/knowledge/GraphifyImport.test.ts (2 tests) 7ms
 ✓ test/knowledge/formats/Ingestors.test.ts (5 tests) 10ms
 ✓ test/GitWatcher.test.ts (17 tests) 2965ms
   ✓ GitWatcher > syncTaskGit records new commits oldest-first and dedupes already-recorded ones  302ms
   ✓ GitWatcher > syncTaskGit updates the task branch when it changes  347ms
   ✓ GitWatcher > syncTaskGit also records the files each new commit touched, with role derived from git status  305ms
   ✓ GitWatcher > syncTaskGit captures the committed file contents for each new commit  326ms
 ✓ test/Registry.test.ts (9 tests) 3525ms
   ✓ Registry (cross-workspace task index) > TaskStore linked to a workspaceRoot keeps the registry in sync automatically on create/status/branch/touch  439ms
   ✓ Registry (cross-workspace task index) > openWorkspaceStore backfills all of a workspace's existing tasks into the registry on open  478ms
   ✓ Registry (cross-workspace task index) > two separate workspaces both show up in the registry after each is opened  729ms
   ✓ Registry (cross-workspace task index) > forgetWorkspace removes a workspace root and all of its indexed tasks  479ms
   ✓ Registry (cross-workspace task index) > pruneMissingWorkspaces removes only workspaces whose directory no longer exists on disk  574ms
 ✓ test/FileCapture.test.ts (78 tests) 6580ms
 ✓ test/CrossWorkspace.test.ts (10 tests) 10574ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > listTasksAcrossWorkspaces sees tasks from multiple workspaces  654ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > listKnownWorkspaces lists every workspace root that has been opened  686ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces finds matches across multiple workspaces and tags each with its workspace root  742ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces skips a workspace whose directory no longer exists  871ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces defaults to recent workspaces only, but can explicitly scan everything  6172ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > resolveTaskAnyWorkspace transparently opens the owning workspace when the task is elsewhere  309ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > searchAcrossWorkspaces does not write a .gitignore into workspaces it only reads from  311ms
   ✓ CrossWorkspace (orchestration over Registry + real per-workspace stores) > resolveTaskAnyWorkspace does not write a .gitignore into the other workspace it transparently opens  345ms

 Test Files  54 passed (54)
      Tests  400 passed (400)
   Start at  00:44:02
   Duration  11.29s (transform 2.60s, setup 586ms, collect 9.46s, tests 31.22s, environment 11ms, prepare 5.55s)
```

Command:
```bash
cd /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki && pnpm --filter @ariadne-dev/core build
```
Output:
```text
> @ariadne-dev/core@0.1.0 build /home/lkumar/Ariadne/.worktrees/ariadne-knowledge-wiki/packages/core
> tsc -p tsconfig.json
```
