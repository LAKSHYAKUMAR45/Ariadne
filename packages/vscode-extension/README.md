# Ariadne for VS Code

**Chats are disposable, tasks are permanent.**

Ariadne persists what actually matters about the work you're doing — goals,
decisions, files touched, todos, errors, and commands — in a local SQLite
database (`.ariadne/state.db`), independent of any single chat transcript or
AI assistant. This extension is one of three interchangeable surfaces
(alongside a [CLI](https://github.com/LAKSHYAKUMAR45/Ariadne/tree/main/packages/cli)
and an MCP server) built on the same shared `@ariadne/core` library, so your
task state is identical no matter which one you use.

## What it does

- Adds an **`@ariadne` chat participant** to Copilot Chat, so you can recall
  or update the current task's state directly from the chat you're already
  using.
- Adds two commands to the Command Palette: **Ariadne: New Task**,
  **Ariadne: Show Task Status**, and **Ariadne: Select Workspace Folder**
  (for multi-root workspaces).
- Passively captures saved files, terminal commands, and git commits against
  the current task in the background (toggle via the
  `ariadne.passiveCapture.enabled` setting).

## Chat commands

Type `@ariadne` in Copilot Chat, optionally followed by one of the slash
commands below — or just describe what you want in plain language (e.g.
"remind me to write the changelog", "decision: use SQLite for storage",
"mark todo abc123 done"); Ariadne uses simple rule-based phrase matching
(no LLM calls) to route common phrasings to the same handlers.

| Command | What it does |
|---|---|
| `/status` (default) | Show the current task's goal, latest checkpoint, open questions, unresolved errors, pending todos, recent files, and recent commits. |
| `/resume` | Alias of `/status`. |
| `/checkpoint <summary>` | Record a checkpoint summary for the current task. |
| `/todo add <text>` / `/todo list` / `/todo done <id>` | Manage todos. |
| `/task new <title>` / `/task list` / `/task use <id>` | Create, list, or switch the current task. |
| `/decision <text>` | Record a decision. |
| `/error <message>` / `/error resolve <id>` | Record or resolve an error. |

## Requirements

- An open folder/workspace (Ariadne stores state at
  `<workspace-root>/.ariadne/state.db`, gitignored by default).

## Known limitations (early/pre-release)

- Passive capture only ever appends to an *explicitly started* task (via
  `/task new` or "Ariadne: New Task") — it never creates or auto-switches
  tasks. Terminal command capture requires VS Code's shell integration API
  (stable since 1.93) and a shell that supports it.
- The packaged native SQLite binding currently targets linux-x64 only;
  multi-platform `.vsix` builds are in progress.

## Development

```bash
pnpm install
pnpm --filter @ariadne/core build   # @ariadne/core must be built first
pnpm --filter ariadne-vscode build  # bundles dist/extension.js via esbuild
pnpm --filter ariadne-vscode package  # produces a .vsix via vsce
```

See `esbuild.js` for why `better-sqlite3` is bundled the way it is (its
native binding can't be inlined by esbuild).

## License

MIT — see [LICENSE](./LICENSE).
