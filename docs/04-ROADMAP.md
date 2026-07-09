# Ariadne — Roadmap, MVP Scope, Risks (v0.2 — updated post-MVP)

> **Status: MVP is shipped.** All items in §2 below are implemented and tested
> across `@ariadne-dev/core`, `@ariadne-dev/cli`, `@ariadne-dev/mcp-server`, and
> the (unpublished) VS Code extension. See §8 for what's actually left.

## 1. Locked Decisions (recap)
- Summarization/checkpoints: **rule-based only for MVP**, no LLM dependency. LLM
  summarization is an optional future plugin.
- Storage: `.ariadne/state.db` (SQLite) **gitignored by default**; Markdown
  export is opt-in.
- v1 ships **all three surfaces together**: Copilot Chat participant, MCP server,
  and CLI — all wrapping one shared `@ariadne-dev/core`.

## 2. MVP Feature List — all shipped
- [x] `@ariadne-dev/core`: TaskStore (SQLite), ContextBuilder (ranked, budgeted),
      CheckpointEngine (rule-based, hierarchical), GitWatcher, Redactor, Exporter,
      cross-workspace Registry. (`packages/core/src/*`, 13 test files.)
- [x] `@ariadne-dev/mcp-server`: exposes task/checkpoint/todo/decision/error/
      question/search/export/context tools, including cross-workspace variants.
      (`packages/mcp-server/src/tools.ts`, `server.ts`.)
- [x] `@ariadne-dev/cli` (`ariadne` binary): full command surface (`task`,
      `status`, `resume`, `checkpoint`, `todo`, `decision`, `error`, `question`,
      `search`, `export`, `git-sync`, `workspace`, `exec`, `backup`/`restore`),
      usable by any agent/CLI (Copilot CLI included) without VS Code.
- [x] `ariadne-vscode` extension:
  - Registers `@ariadne` Copilot Chat participant with the full command set
    above, plus a status-bar guardrail showing the current task.
  - Background passive capture: file saves, git commits/branch switches, terminal
    command+exit code (redacted), diagnostics — all opt-out via settings.
- [x] `ariadne export` → Markdown export command (opt-in, for sharing/PRs).
- [x] Baseline redaction of secrets in captured terminal output (`Redactor.ts`).
- [x] Single active task + task switching, including cross-workspace task
      resolution via `~/.ariadne/registry.db` (dependency graph UI remains
      deferred; the underlying `todo_deps`-style data model ships).

## 3. Explicitly Deferred (Stretch Goals)
- ~~Tree view / timeline / knowledge-base browser UI~~ — **a minimal
  read-only version shipped**: `packages/vscode-extension/src/treeView.ts`'s
  `AriadneTreeDataProvider` contributes an "Ariadne" activity-bar view
  (`ariadneTasks`) showing every task in the current workspace, expandable
  into Checkpoints/Todos/Decisions/Errors/Open Questions per task, with a
  refresh command/button. It's intentionally read-only (browse only; use the
  chat participant or CLI to mutate). A richer timeline/knowledge-base view
  (cross-task chronological view, filtering, search) remains out of scope
  for now.
- LLM-assisted summarization plugin (opt-in, bring-your-own-model) —
  **the pluggable hook now exists**: `CheckpointSummarizer`
  (`packages/core/src/CheckpointEngine.ts`) is an interface any summarizer
  (rule-based or LLM-backed) can implement, and `ruleBasedSummarizer` is the
  MVP default. The `*WithSummarizer` triggers (`maybeCheckpointOnFileActivityWithSummarizer`,
  `checkpointOnCommitWithSummarizer`, `checkpointOnErrorWithSummarizer`,
  `maybeCheckpointOnIdleWithSummarizer`) accept a custom summarizer and are
  otherwise identical to the existing sync rule-based triggers. **Not yet
  done:** no actual LLM-backed `CheckpointSummarizer` implementation exists,
  and no call site (CLI/MCP server/VS Code extension) opts into the
  `*WithSummarizer` triggers yet — they all still call the original
  synchronous rule-based triggers.
- Reference plugins beyond `console-logger` (Jira, GitHub Issues, Linear,
  Slack, Obsidian export, local LLM backends) — the `PluginRegistry`
  interface exists (§4 Phase 5) but none of these have been built, and no
  call site wires the registry in yet.
- Cloud sync / team-shared task graph.
- True cross-repo tasks (one task entity spanning multiple repos as a single
  linked unit) — **the data model now exists**:
  `packages/core/src/CrossRepoLinks.ts` adds `task_link_groups`/`task_links`
  tables to the shared `~/.ariadne/registry.db`, letting independent tasks
  in different workspaces (each still a normal task in its own
  `.ariadne/state.db`) be grouped as members of one logical "link group"
  (`createTaskLinkGroup`/`linkTaskToGroup`/`listGroupMembers`/
  `findGroupsForTask`/`deleteTaskLinkGroup`). **Not yet done:** no CLI/MCP
  server/VS Code extension surface exposes link groups yet (no `ariadne
  link` command, no chat participant support, no tree-view grouping) — this
  is data-model-only for now, deliberately validated before building UI on
  top of it.
- Smarter (embedding-based) context ranking beyond the rule-based v0.1 scorer
  — **now shipped at the interface level:**
  `packages/core/src/ContextBuilder.ts` adds an `EmbeddingProvider` interface
  (`embed(texts): Promise<number[][]>`), a `cosineSimilarity` utility, and a
  new `buildContextWithEmbeddingRanking(store, taskId, query, embed,
  options)` function that gathers the exact same candidate pool as
  `buildContext` but re-ranks it by similarity-to-query instead of
  tier/recency (with an optional `topK` to prioritize the most relevant
  items first, falling back to tier order for the remainder so nothing is
  silently dropped when budget allows). `buildContext` itself is completely
  unmodified — its candidate-gathering was extracted into a shared internal
  helper reused by both ranking strategies, with zero behavior change to
  the original rule-based path (all pre-existing tests pass unchanged).
  **Not yet done:** no real embedding-model integration exists (only the
  interface + tests with a fake bag-of-words provider), and no CLI/MCP
  server/VS Code extension call site opts into embedding ranking yet — they
  all still call the original synchronous `buildContext`. The `chars / 4`
  token-count heuristic is unchanged.

## 4. Technical Roadmap (Phased) — Phases 0–4 complete, Phase 5 interfaces shipped
1. ✅ **Phase 0 — Core skeleton:** SQLite schema + TaskStore CRUD + unit tests.
   Shipped (`packages/core/src/TaskStore.ts` + tests).
2. ✅ **Phase 1 — Context loop:** ContextBuilder + CheckpointEngine (rule-based).
   Shipped (`packages/core/src/ContextBuilder.ts`, `CheckpointEngine.ts`).
3. ✅ **Phase 2 — Surfaces:** MCP server wrapping core; VS Code extension wiring
   background capture + chat participant. Shipped, but note the VS Code chat
   participant calls `@ariadne-dev/core` in-process rather than hopping through
   the MCP server — MCP is used for external clients (Copilot CLI, other
   editors), not as an internal transport within the extension itself.
4. ✅ **Phase 3 — Git integration & redaction hardening:** GitWatcher, commit
   linking, branch-switch detection, secret redaction test suite. Shipped
   (`GitWatcher.ts`, `Redactor.ts`, `/git-sync` command).
5. ✅ **Phase 4 — Polish + optional UI:** Markdown export shipped (`Exporter.ts`,
   `ariadne export`). Packaging scripts for the VS Code extension (`vsce
   package`) and npm (CLI/core/mcp-server via Changesets) are in place and the
   release workflows are green. `packages/vscode-extension/package.json` is
   now `"private": false` (marketplace-publish-ready: icon, keywords,
   categories, license all present) but has **not actually been submitted to
   the VS Code Marketplace yet** (needs an Azure DevOps PAT + publisher
   account) — deferred by choice, not blocked. The minimal read-only tree
   view has since shipped (see §3) rather than being folded indefinitely
   into deferred UI work.
6. 🟡 **Phase 5 (post-MVP) — Plugin platform: interface shipped, no real
   plugins yet.** `PluginRegistry` (`packages/core/src/PluginRegistry.ts`) is
   a minimal in-process event bus — plugins implement `AriadnePlugin.activate()`
   and subscribe to lifecycle events (`checkpoint.created`,
   `task.statusChanged`, `todo.added`, `decision.added`, `error.added`,
   `question.added`); a throwing/rejecting plugin hook is isolated per-plugin
   and never breaks core or other plugins (`emit` returns settled results
   instead of throwing). `packages/plugins/console-logger` is the reference
   implementation (kept `private: true` and changeset-ignored — not published
   to npm). **Not yet done:** the registry isn't wired into any call site
   (CLI/MCP server/VS Code extension never construct one or call `emit(...)`
   today), and no real-world plugin (Jira/GitHub Issues/Linear/Slack sync,
   Obsidian export, LLM summarization) has been built against it yet.
7. 🟡 **LLM summarization hook: interface shipped, no LLM implementation
   yet.** `CheckpointSummarizer` and the `*WithSummarizer` triggers
   (`packages/core/src/CheckpointEngine.ts`) let a caller swap in a custom
   summarizer (e.g. LLM-backed) in place of the rule-based default,
   independently of `PluginRegistry`. **Not yet done:** no LLM-backed
   `CheckpointSummarizer` exists, and no call site opts into the
   `*WithSummarizer` triggers — everything still uses the original
   synchronous rule-based triggers.

## 5. Repo / OSS Structure
- **Monorepo** (pnpm workspaces): `packages/core`, `packages/cli`,
  `packages/mcp-server`, `packages/vscode-extension`, `packages/plugins/*`
  (currently just the `console-logger` reference plugin), `docs/`.
  Justification: shared core changes constantly touch all surfaces during
  early development — multi-repo coordination overhead isn't worth it
  pre-1.0.
- CI: per-package build/test/typecheck on push (`.github/workflows/ci.yml`,
  `release.yml`); `release.yml` also builds and packages the VS Code extension
  `.vsix` on tagged release.
- Versioning/release: [Changesets](https://github.com/changesets/changesets),
  independent semver per package, since CLI/MCP server may need to move faster
  than the VS Code extension (marketplace review lag). Shipped and **verified
  working end-to-end**: `.changeset/config.json`, root `pnpm changeset` /
  `pnpm version-packages` / `pnpm release` scripts, and
  `.github/workflows/packages-release.yml` (opens/updates a "Version Packages"
  PR on master, publishes to npm once merged). The npm scope is
  **`@ariadne-dev`** (not `@ariadne` — that name/org was already taken on npm),
  and the CLI package is `@ariadne-dev/cli` (not the unscoped `ariadne` — also
  taken). `core@0.1.0`, `cli@0.1.0`, and `mcp-server@0.1.0` have been published
  to npm. `NPM_TOKEN` is a granular access token with 2FA-bypass enabled.
- Testing: unit tests for core (ContextBuilder ranking, CheckpointEngine rollup,
  Redactor patterns) are the highest-value tests and have the deepest coverage
  (13 test files in `packages/core`); CLI (5), MCP server (3), and the VS Code
  extension (5) have lighter but real coverage, including cross-workspace
  integration tests per surface.

## 6. Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| Secret leakage via captured terminal output | High (security/privacy) | Redact at capture time, local-only storage by default, redaction pattern test suite before any capture ships |
| MCP spec/client support still maturing | Medium (integration risk) | CLI remains a fully independent fallback path; don't couple core to MCP internals |
| Rule-based summaries feel "dumb" vs LLM summaries | Medium (perceived value) | Make LLM summarization a clean opt-in plugin point early so power users can upgrade without core rework |
| Scope creep into "another AI chat UI" | High (identity risk) | Explicit non-goals section in PRD; UI work gated behind "is this required for the core loop?" test |
| SQLite multi-process contention (extension + CLI + MCP server) | Medium (reliability) | **Resolved differently than originally planned:** no daemon/IPC layer was built — each surface opens the workspace's SQLite DB directly in WAL mode (`packages/core/src/db.ts`), which has proven sufficient so far. Revisit only if real contention issues surface. |
| Token-budget context still too large for very long-running tasks | Medium (value delivery) | Hierarchical checkpoint rollup keeps summaries compact even as task history grows |

## 7. Open Questions — resolution status
1. ~~Automatic vs explicit task detection~~ — **resolved: explicit-only.**
   Passive capture (file saves, git activity, terminal commands) never
   auto-creates or auto-switches the current task; the user always sets it
   explicitly via `/task new`, `ariadne task new`, or `task_new`. See the
   "Known limitations" note in `docs/05-USER-GUIDE.md` and
   `packages/vscode-extension/src/passiveCapture.ts`.
2. ~~IPC transport choice~~ — **resolved: no IPC/daemon at all.** Each surface
   (CLI, MCP server, VS Code extension) opens the workspace's SQLite DB
   directly (`packages/core/src/db.ts`, WAL mode), sidestepping the daemon
   question entirely. See §6's updated risk mitigation above.
3. ~~Token-counting method~~ — **resolved: `chars / 4` heuristic** in
   `packages/core/src/ContextBuilder.ts`, not a real tokenizer. Simple and
   good enough for budget enforcement so far; embedding/tokenizer-based
   ranking remains a stretch goal (§3).
4. ~~Daemon lifecycle policy~~ — **moot**, since no daemon was built (see #2).
5. ~~Multi-repo task support~~ — **resolved for the cross-workspace
   discovery/operation case**: the `tasks` table never assumed a single
   global workspace root (each workspace already had its own DB), and the
   `~/.ariadne/registry.db` (see `02-ARCHITECTURE.md` §4a) lets any
   surface find and operate on a task from any workspace it's ever seen.
   True single-task-spans-multiple-repos linking remains deferred (§3).

All five original open questions are now resolved (mostly by turning out to be
non-issues once the no-daemon, direct-SQLite-access architecture was chosen).
No new open architectural questions have surfaced since.

## 8. Suggested Immediate Next Steps (post-MVP)
The MVP (§2) is done and the release pipeline (npm + VS Code packaging) is
verified working. Remaining work is about *shipping what exists* and *choosing
what's next*, not building the core loop:

1. **Publish the VS Code extension to the Marketplace.** `"private": false`
   is already set and the package is publish-ready (icon, keywords,
   categories, license) — the remaining step is obtaining an Azure DevOps PAT
   and publisher account and deciding on a publish date, or documenting why
   it's staying VSIX-only for now.
2. **Wire `PluginRegistry` (and/or `CheckpointSummarizer`) into a real call
   site, and build one real, non-reference implementation.** Both
   interfaces are shipped (`packages/core/src/PluginRegistry.ts`,
   `CheckpointEngine.ts`'s `CheckpointSummarizer` + `*WithSummarizer`
   triggers; reference `packages/plugins/console-logger`), but nothing in
   the CLI/MCP server/VS Code extension constructs a `PluginRegistry` or
   opts into the `*WithSummarizer` triggers yet, and no plugin talks to a
   real external system. Picking one thin real plugin (e.g. GitHub Issues
   sync on `todo.added`, or an actual LLM-backed `CheckpointSummarizer`)
   would validate both interface shapes before more are built against them.
3. **Decide on a richer timeline/knowledge-base view** (§3): the minimal
   read-only tree view (`ariadneTasks`) has shipped; a cross-task
   chronological timeline or full-text search/filter view remains
   optional/deferred.
4. **Wire cross-repo task linking into a real surface** (§3):
   `CrossRepoLinks.ts`'s data model is shipped but unreachable from any
   surface — a minimal CLI (`ariadne link create/add/list`) would be the
   thinnest way to validate it before deciding whether the tree view or
   chat participant should also show link groups.
5. **Broaden integration-test coverage** on the lighter-tested surfaces (CLI,
   MCP server, VS Code extension) now that the core loop is stable, rather
   than continuing to add core-only tests.
6. **Wire `buildContextWithEmbeddingRanking` into a real surface with a real
   embedding backend.** The interface, cosine-similarity ranking, and tests
   are shipped (`packages/core/src/ContextBuilder.ts`), but there's no
   concrete `EmbeddingProvider` implementation yet (e.g. a local ONNX
   model or a hosted embeddings API) and no CLI/MCP/extension call site
   opts into it. A natural first target: an optional `--query` flag on
   `ariadne context`/the MCP `get_context` tool that, when a provider is
   configured, ranks by relevance-to-query instead of tier/recency.
7. **`cloud-sync-team-graph`** remains explicitly out of scope for
   autonomous implementation — it needs product/infra decisions (hosting,
   auth, conflict resolution across a shared task graph) before any code
   should be written.
