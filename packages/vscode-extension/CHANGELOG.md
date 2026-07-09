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

### Known limitations
- Single workspace-folder support only (no multi-root).
- No automatic/passive capture of files, terminal commands, or git commits.
- Native SQLite binding packaged for linux-x64 only so far.
