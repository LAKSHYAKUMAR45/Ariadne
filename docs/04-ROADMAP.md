# Ariadne — Roadmap, MVP Scope, Risks (Draft v0.1)

## 1. Locked Decisions (recap)
- Summarization/checkpoints: **rule-based only for MVP**, no LLM dependency. LLM
  summarization is an optional future plugin.
- Storage: `.ariadne/state.db` (SQLite) **gitignored by default**; Markdown
  export is opt-in.
- v1 ships **all three surfaces together**: Copilot Chat participant, MCP server,
  and CLI — all wrapping one shared `@ariadne/core`.

## 2. MVP Feature List
- [ ] `@ariadne/core`: TaskStore (SQLite), ContextBuilder (ranked, budgeted),
      CheckpointEngine (rule-based, hierarchical), GitWatcher, Redactor.
- [ ] `@ariadne/mcp-server`: exposes `task.start/switch/list/checkpoint/
      getContext/addDecision/addTodo/resolveError/search` as MCP tools.
- [ ] `@ariadne/cli` (`ariadne` binary): same operations as plain commands,
      usable by any agent/CLI (Copilot CLI included) without VS Code.
- [ ] `@ariadne/vscode-extension`:
  - Registers `@ariadne` Copilot Chat participant (`/start /checkpoint /resume
    /status /decide /context /switch`).
  - Spawns/registers the MCP server for Copilot Chat's MCP integration.
  - Background passive capture: file saves, git commits/branch switches, terminal
    command+exit code (redacted), diagnostics.
- [ ] `ariadne export` → Markdown export command (opt-in, for sharing/PRs).
- [ ] Baseline redaction of secrets in captured terminal output.
- [ ] Single active task + basic task switching (nested/dependency graph UI is
      stretch — dependency *data model* ships in MVP even if no UI surfaces it).

## 3. Explicitly Deferred (Stretch Goals)
- Tree view / timeline / knowledge-base browser UI (secondary per product
  direction; can ship in v1.1 once core loop is validated).
- LLM-assisted summarization plugin (opt-in, bring-your-own-model).
- Plugins: Jira, GitHub Issues, Linear, Slack, Obsidian export, local LLM backends.
- Cloud sync / team-shared task graph.
- Cross-repo / multi-workspace tasks.
- Smarter (embedding-based) context ranking beyond the rule-based v0.1 scorer.

## 4. Technical Roadmap (Phased)
1. **Phase 0 — Core skeleton:** SQLite schema + TaskStore CRUD + unit tests. No
   AI/editor integration yet. Validates data model independently.
2. **Phase 1 — Context loop:** ContextBuilder + CheckpointEngine (rule-based) on
   top of Phase 0, driven purely by CLI for fast iteration (no VS Code needed to
   test the hardest logic).
3. **Phase 2 — Surfaces:** MCP server wrapping core; VS Code extension wiring
   background capture + chat participant + MCP registration. This is where
   Copilot Chat / Copilot CLI integration becomes real.
4. **Phase 3 — Git integration & redaction hardening:** GitWatcher, commit
   linking, branch-switch detection, secret redaction test suite.
5. **Phase 4 — Polish + optional UI:** Markdown export, minimal read-only tree
   view, docs, packaging for the VS Code Marketplace + npm (CLI).
6. **Phase 5 (post-MVP) — Plugin platform:** formalize plugin interface, ship one
   reference plugin (e.g. GitHub Issues) to prove extensibility.

## 5. Repo / OSS Structure
- **Monorepo** (pnpm workspaces + Turborepo or Nx): `packages/core`, `packages/cli`,
  `packages/mcp-server`, `packages/vscode-extension`, `packages/plugins/*`,
  `docs/`. Justification: shared core changes constantly touch all surfaces during
  early development — multi-repo coordination overhead isn't worth it pre-1.0.
- CI: per-package lint/typecheck/test on PR (Turborepo caching to keep it fast);
  build + package VS Code extension (`vsce package`) and publish CLI to npm on
  tagged release.
- Versioning/release: [Changesets](https://github.com/changesets/changesets),
  independent semver per package, since CLI/MCP server may need to move faster
  than the VS Code extension (marketplace review lag). Shipped: `.changeset/config.json`,
  root `pnpm changeset` / `pnpm version-packages` / `pnpm release` scripts, and
  `.github/workflows/packages-release.yml` (opens/updates a "Version Packages"
  PR on master, publishes to npm once merged — the VS Code extension is
  excluded since it ships as a `.vsix` via `release.yml` instead). Publishing
  is a no-op until an `NPM_TOKEN` secret and the packages' first real release
  are in place.
- Testing: unit tests for core (ContextBuilder ranking, CheckpointEngine rollup,
  Redactor patterns) are the highest-value tests — prioritize these over
  extension-level integration tests early on.

## 6. Risk Analysis

| Risk | Impact | Mitigation |
|---|---|---|
| Secret leakage via captured terminal output | High (security/privacy) | Redact at capture time, local-only storage by default, redaction pattern test suite before any capture ships |
| MCP spec/client support still maturing | Medium (integration risk) | CLI remains a fully independent fallback path; don't couple core to MCP internals |
| Rule-based summaries feel "dumb" vs LLM summaries | Medium (perceived value) | Make LLM summarization a clean opt-in plugin point early so power users can upgrade without core rework |
| Scope creep into "another AI chat UI" | High (identity risk) | Explicit non-goals section in PRD; UI work gated behind "is this required for the core loop?" test |
| SQLite multi-process contention (extension + CLI + MCP server) | Medium (reliability) | Single daemon owns the DB; others talk via IPC, not direct file access; WAL mode |
| Token-budget context still too large for very long-running tasks | Medium (value delivery) | Hierarchical checkpoint rollup keeps summaries compact even as task history grows |

## 7. Open Questions Still Requiring Decisions
1. Automatic vs explicit task detection (heuristic new-branch/new-file-cluster vs.
   always user-named) — PRD flags this; needs a decision before Phase 2.
2. IPC transport choice (unix socket vs named pipe vs loopback TCP) — needed before
   CLI/daemon implementation (Phase 0/2 boundary).
3. Token-counting method for budget enforcement — needed before ContextBuilder
   implementation (Phase 1).
4. Daemon lifecycle policy (idle-timeout value, explicit stop command) — needed
   before Phase 2.
5. Multi-repo task support — explicitly deferred, but worth a one-line design note
   so the schema doesn't accidentally preclude it later (e.g. avoid assuming a
   single workspace root in `tasks` table).

## 8. Suggested Immediate Next Step
Start **Phase 0** (`packages/core` schema + TaskStore) since every other surface
depends on it, and it's fully testable without any editor/AI integration — fastest
path to a concrete, verifiable artifact.
