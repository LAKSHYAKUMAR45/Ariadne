# Changelog

All notable changes to the Ariadne VS Code extension will be documented here.

## [Unreleased]

### Added
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
  fails loudly if `@ariadne/core`'s `better-sqlite3` dependency moves to an
  unverified major version, validates each fetched cross-platform native
  binary's magic bytes and size, and actually loads + exercises the locally
  bundled native binding as part of every dev build.
