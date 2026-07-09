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
- Native SQLite binding packaged for linux-x64 only so far.
