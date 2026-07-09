# Ariadne for VS Code

**Chats are disposable, tasks are permanent.**

Ariadne persists what actually matters about the work you're doing — goals,
decisions, files touched, todos, errors, and commands — in a local SQLite
database (`.ariadne/state.db`), independent of any single chat transcript or
AI assistant. This extension is one of three interchangeable surfaces
(alongside a [CLI](https://github.com/LAKSHYAKUMAR45/Ariadne/tree/main/packages/cli)
and an MCP server) built on the same shared `@ariadne-dev/core` library, so your
task state is identical no matter which one you use.

## What it does

- Adds an **`@ariadne` chat participant** to Copilot Chat, so you can recall
  or update the current task's state directly from the chat you're already
  using.
- Adds two commands to the Command Palette: **Ariadne: New Task**,
  **Ariadne: Show Task Status**, and **Ariadne: Select Workspace Folder**
  (for multi-root workspaces).
- Shows a **status bar item** (bottom-right) with the current task's title,
  or "no task" if none is set for the workspace — click it to jump to
  `/status` (or start a new task if there isn't one yet).
- Passively captures saved files, terminal commands, and git commits against
  the current task in the background (toggle via the
  `ariadne.passiveCapture.enabled` setting).
- Guards against silent misattribution: a one-time notice if you start
  working in a workspace with no current task (so passive capture doesn't
  silently drop everything), and a warning if the checked-out git branch no
  longer matches the branch the current task was last tracked on (in case
  you switched branches — or tasks — without telling Ariadne).

## Chat commands

Type `@ariadne` in Copilot Chat, optionally followed by one of the slash
commands below — or just describe what you want in plain language (e.g.
"remind me to write the changelog", "decision: use SQLite for storage",
"mark todo abc123 done"); Ariadne uses simple rule-based phrase matching
(no LLM calls) to route common phrasings to the same handlers.

| Command | What it does |
|---|---|
| `/status [id] [--budget <tokens>]` (default) | Show a task's workspace root, tracked git branch, goal, latest checkpoint, open questions, unresolved errors, blocked todos, pending todos, recent files, recent commits, and recent commands. Defaults to the current task; an explicit id works even if it belongs to a different workspace. `--budget` trims the output to fit a token budget, like the CLI/MCP surfaces. |
| `/resume [id] [--budget <tokens>]` | Alias of `/status`. |
| `/checkpoint <summary>` | Record a checkpoint summary for the current task. |
| `/todo add <text>` / `/todo list` / `/todo done <id>` / `/todo reopen <id>` / `/todo block <id>` / `/todo edit <id> --text <t>` / `/todo delete <id>` (all `[--task <taskId>]`) | Manage todos, including curation (edit/delete) and reopening/blocking. `--task` tells id-based subcommands which task/workspace the todo belongs to, if not the current one. |
| `/task new <title>` / `/task list [--all-workspaces]` / `/task use <id>` | Create, list, or switch the current task. `--all-workspaces` lists tasks from every workspace Ariadne has ever seen (tagged with each task's workspace root). |
| `/task pause [id]` / `/task done [id]` / `/task archive [id]` / `/task reopen [id]` / `/task edit --title <t> --goal <g>` | Change a task's lifecycle status, or edit its title/goal (curation). Defaults to the current task; an explicit id works even if it belongs to a different workspace. |
| `/decision <text>` / `/decision list` / `/decision edit <id> --text <t> --rationale <r>` / `/decision delete <id>` (last two `[--task <taskId>]`) | Record, list, edit, or delete a decision. |
| `/error <message>` / `/error resolve <id>` / `/error reopen <id>` / `/error edit <id> --message <m>` / `/error delete <id>` (all `[--task <taskId>]`) | Record, resolve, reopen, edit, or delete an error. `--task` tells id-based subcommands which task/workspace the error belongs to, if not the current one. |
| `/question add <text>` / `/question list` / `/question resolve <id>` / `/question reopen <id>` / `/question edit <id> --text <t>` / `/question delete <id>` (id-based ones `[--task <taskId>]`) | Record, list, resolve, reopen, edit, or delete an open question blocking the task. `--task` works the same way. |
| `/search <query> [--all-workspaces]` | Cross-entity search over task titles/goals, checkpoints, decisions, todos, errors, open questions, files, and commits. `--all-workspaces` searches every known workspace, tagging each result with its workspace root. |
| `/git-sync [id]` | Sync the current git branch and any new commits (since the last sync) into a task. Defaults to the current task; an explicit id works even for a task in a different workspace (using that workspace's repo root). Same underlying logic as the CLI's `git-sync` and MCP's `git_sync`. |
| `/export [id] [--out <path>]` | Render a task to Markdown, write it to `.ariadne/export/<task-id>.md` (or `--out <path>` for a custom location, relative to the workspace root unless absolute), and show it inline in the chat response. |

Any command above that resolves a task by id (not just the current task) —
`/status|/resume <id>`, `/task pause|done|archive|reopen <id>` —
transparently falls back to the global cross-workspace registry
(`~/.ariadne/registry.db`) if the id isn't in the currently open workspace,
and operates on whichever workspace actually owns it. Sub-entity ids
(todos, errors, open questions, decisions) aren't indexed by the registry, so
their id-based subcommands (`done`, `reopen`, `block`, `edit`, `delete`,
`resolve`) need an explicit `--task <taskId>` hint to resolve across
workspaces — without it they operate on the current workspace only, as before.

## Requirements

- An open folder/workspace (Ariadne stores state at
  `<workspace-root>/.ariadne/state.db`, gitignored by default).

## Known limitations (early/pre-release)

- Passive capture only ever appends to an *explicitly started* task (via
  `/task new` or "Ariadne: New Task") — it never creates or auto-switches
  tasks. Terminal command capture requires VS Code's shell integration API
  (stable since 1.93) and a shell that supports it.

## Development

```bash
pnpm install
pnpm --filter @ariadne-dev/core build   # @ariadne-dev/core must be built first
pnpm --filter ariadne-vscode build  # bundles dist/extension.js via esbuild
pnpm --filter ariadne-vscode package  # produces a .vsix via vsce (current machine's platform only)
```

See `esbuild.js` for why `better-sqlite3` is bundled the way it is (its
native binding can't be inlined by esbuild).

### Multi-platform packaging

`better-sqlite3`'s native binding is platform/ABI-specific, so a single
`.vsix` can only run on the platform it was built on. Real, per-platform
`.vsix` files are produced without needing that OS, by downloading
`better-sqlite3`'s official prebuilt binaries (via `prebuild-install`,
targeting VS Code's bundled Electron ABI — see `VSCODE_ELECTRON_VERSION` in
`esbuild.js`) instead of relying on whatever's locally compiled:

```bash
pnpm --filter ariadne-vscode run package:linux-x64
pnpm --filter ariadne-vscode run package:linux-arm64
pnpm --filter ariadne-vscode run package:darwin-x64
pnpm --filter ariadne-vscode run package:darwin-arm64
pnpm --filter ariadne-vscode run package:win32-x64
pnpm --filter ariadne-vscode run package:all   # all five, into dist-vsix/
```

Each script fetches the correct native binary for that target before
running `vsce package --target <platform>-<arch>`, so `dist-vsix/` ends up
with one correctly-targeted `.vsix` per platform, ready to publish with
`vsce publish --target <platform>-<arch> --packagePath dist-vsix/*.vsix` (or
upload individually via the Marketplace UI/`vsce publish -i <file>`).

If `engines.vscode`'s floor is ever raised, bump `VSCODE_ELECTRON_VERSION`
in `esbuild.js` to match the new floor's bundled Electron version (check
`electron` in https://github.com/microsoft/vscode/blob/<tag>/package.json).

## License

MIT — see [LICENSE](./LICENSE).
