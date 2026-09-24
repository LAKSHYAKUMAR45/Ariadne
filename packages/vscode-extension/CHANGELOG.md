# Changelog

All notable changes to the Ariadne VS Code extension will be documented here.

## [Unreleased]

### Added
- Visible Ariadne Activity Bar launcher/status view that opens the full
  Ariadne panel, creates tasks, and starts cloud sync from the View Bar.
- React webview panel for task switching, overview, editable todos,
  decisions, errors, open questions, captured file diffs, search, sync, and
  Markdown export.
- First-run onboarding inside the panel, including task creation, sync/import
  shortcuts, and context help.
- Built-in task templates (`feature`, `bugfix`, `review`, `research`,
  `incident`) that seed new tasks with starter todos, questions, and
  decisions.
- Activity tab coverage for Capture Health and the filterable Activity
  Timeline, showing capture guardrails and recent checkpoints, todos,
  decisions, errors, questions, file captures, commits, and commands.
- Context handoff preview/copy/open workflow with token-budget metadata and
  truncation summaries.
- Advisory Review tab that summarizes completion checks and links back to the
  relevant cleanup surface.
- Files/Search polish: file-capture filtering, direct file open actions, and
  search navigation that can route file/commit results back into the Files
  tab.
- Graphify webview tab for `update`, `query`, `path`, and `explain` runs
  through the extension host.
- Sync profile/status UI, including current-vs-other profile display, auth
  guidance, action history, and `pull import-new` confirmation.
- Initial `@ariadne` chat participant with `/status`, `/resume`,
  `/checkpoint`, `/todo`, `/task`, `/decision`, and `/error` commands.
- `Ariadne: New Task` and `Ariadne: Show Task Status` commands.
- Per-workspace TaskStore connection caching.
- Friendly error surfacing in chat (with details logged to the "Ariadne"
  output channel) instead of silent failures.
- Multi-root workspace support: resolves the active editor's folder or a
  persisted user selection (`Ariadne: Select Workspace Folder`) instead of
  always assuming the first folder.
- Streamed, progressive `/status`/`/resume` output plus `stream.progress()`
  feedback while commands run.
- Rule-based natural-language intent routing for plain `@ariadne` messages
  (no slash command required for common phrasings).
- Passive capture: saved files, terminal commands (via VS Code's shell
  integration API), and git commits are automatically recorded against the
  current task in the background. Toggle via
  `ariadne.passiveCapture.enabled`.

### Known limitations
- (none currently tracked — see docs/04-ROADMAP.md for deferred/stretch items)

### Infrastructure
- Added `package:<platform>-<arch>` / `package:all` scripts that fetch
  real, correctly-ABI'd `better-sqlite3` prebuilt binaries (targeting VS
  Code's bundled Electron version) for linux-x64/arm64, darwin-x64/arm64,
  and win32-x64, producing one native, working `.vsix` per platform without
  needing to actually run on that OS.
- Hardened the esbuild.js bundling pipeline against silent breakage: it now
  fails loudly if `@ariadne-dev/core`'s `better-sqlite3` dependency moves to an
  unverified major version, validates each fetched cross-platform native
  binary's magic bytes and size, and actually loads + exercises the locally
  bundled native binding as part of every dev build.
