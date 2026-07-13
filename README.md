# Ariadne

**Chats are disposable, tasks are permanent.**

Ariadne is an open-source tool for individual developers that persists what
actually matters about the work you're doing — goals, decisions, files
touched, todos, errors, and commands — in a local SQLite database, instead of
relying on a chat transcript. It's built to be **model-agnostic**: it works
the same whether you're using GitHub Copilot, Claude Code, Gemini CLI, Codex,
or anything else, because task state lives outside any single chat session.

When you close a chat, switch AI assistants, or come back to a task days
later, Ariadne lets you (or your assistant) reload exactly where you left
off — no re-explaining the goal, re-pasting file paths, or re-describing
decisions already made.

## Why

AI coding assistants are great in the moment, but their context dies with the
chat window. Switch tools, hit a context limit, or come back tomorrow, and
you're re-explaining everything from scratch. Ariadne's answer: stop treating
the chat as the source of truth. Treat the **task** as the source of truth,
and let any assistant read and write to it.

## Features

- **Task lifecycle** — create, list, switch, pause, complete, archive, and
  reopen tasks; edit a task's title/goal after the fact (curation).
- **Goals & checkpoints** — set a goal per task, and record leveled
  checkpoint summaries (`micro`/`session`/`milestone`) as you make progress.
- **Decisions** — record decisions with an optional rationale; list, edit,
  or delete them; supersede an older decision with a newer one.
- **Todos** — add, list, complete, reopen, block, edit, and delete todos;
  blocked todos are surfaced separately from merely-pending ones.
- **Errors** — record errors, mark them resolved/reopened, edit, or delete
  them; list defaults to unresolved-only, with an `--all`/`all:true` option
  to see everything.
- **Open questions** — track things blocking progress that you're unsure
  about, and resolve/reopen/edit/delete them like todos/errors.
- **Ranked, token-budgeted status/resume** — `status`/`resume` (and the
  `get_context`/`/status` equivalents) assemble goal, latest checkpoint,
  open questions, unresolved errors, blocked todos, decisions, pending
  todos, recent files, commits, and commands into one ranked summary,
  trimmed to a token budget — fully rule-based, no LLM calls.
- **Workspace + branch visibility** — status output shows which workspace
  root and git branch a task belongs to, so cross-workspace results are
  never ambiguous about where they came from.
- **Search** — substring search across task titles/goals, checkpoints,
  decisions, todos, errors, open questions, files, and commits.
- **Passive capture (VS Code)** — saved files, terminal commands (secret-
  redacted), and diagnostics (new/resolved errors) are recorded against the
  current task automatically, with guardrails for "no current task" and
  git branch/task mismatches.
- **`ariadne exec`** — a CLI-native passive-capture equivalent for
  non-VS Code workflows: runs a command live and auto-records it (and any
  failure) against the current task.
- **Git integration** — `git-sync`/`/git-sync`/`git_sync` records the
  current branch and any new commits into a task on demand, for workflows
  where the background watcher hasn't run yet.
- **Markdown export** — render a task to Markdown (`export`/`/export`/
  `export_task`), the only opt-in way task history leaves the SQLite
  database (e.g. to paste into a PR description).
- **Cross-workspace task discovery** — a global registry (`~/.ariadne/registry.db`)
  lets you list/search/act on tasks from *any* workspace you've used Ariadne
  in, without needing to `cd` there first — while each workspace's own
  database stays the sole source of truth for its own tasks.
- **Registry maintenance & backup** — `workspace list`/`prune`/`forget` to
  manage the cross-workspace index, and `backup`/`restore` to snapshot and
  recover a workspace's state database.
- **Three interchangeable surfaces, one shared core** — CLI, MCP server,
  and VS Code chat participant all read/write the exact same
  `@ariadne-dev/core` data, so nothing is surface-specific or out of sync.

## How it works

One shared core library, wrapped by three thin, interchangeable surfaces —
because UX is intentionally secondary here. The primary way you'll use
Ariadne day-to-day is through the chat participant or the CLI, not a custom
dashboard.

```
┌─────────────────┐   ┌─────────────────┐   ┌──────────────────────────┐
│   CLI (ariadne)  │   │   MCP server    │   │  VS Code extension +    │
│                  │   │                 │   │  Copilot Chat participant│
└────────┬─────────┘   └────────┬────────┘   └────────────┬─────────────┘
         │                      │                          │
         └──────────────────────┼──────────────────────────┘
                                 │
                         ┌───────▼────────┐
                         │  @ariadne-dev/core │   SQLite schema + TaskStore
                         └───────┬────────┘
                                 │
                    <workspace-root>/.ariadne/state.db
```

- **Storage**: SQLite, local to each workspace, gitignored by default.
  Markdown export is opt-in for sharing task state.
- **Summarization**: rule-based and fully deterministic for now — no LLM
  calls, no network access required. LLM-based summarization is planned as
  an opt-in plugin later.
- **Integration**: any surface (CLI, MCP server, chat participant) can read
  and write the same task state, so switching AI assistants doesn't lose
  anything.

New to Ariadne? Read [`docs/05-USER-GUIDE.md`](docs/05-USER-GUIDE.md) for a
practical walkthrough of installing and using all three surfaces. See
[`docs/`](docs/) for the full design docs (product requirements,
architecture, data model, and roadmap).

## Packages

This is a pnpm workspace monorepo:

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@ariadne-dev/core` — the shared SQLite schema, `TaskStore`, and context-building logic used by every surface. |
| [`packages/cli`](packages/cli) | `ariadne` — a command-line interface for managing tasks, todos, checkpoints, and status. |
| [`packages/mcp-server`](packages/mcp-server) | `@ariadne-dev/mcp-server` — an MCP server exposing task state as tools to any MCP-capable AI client (Claude Code, Gemini CLI, Codex, Copilot, etc.), no VS Code required. |
| [`packages/vscode-extension`](packages/vscode-extension) | `ariadne-vscode` — a VS Code extension that adds an `@ariadne` Copilot Chat participant, commands, and passive background capture (saved files, terminal commands, git commits). |
| [`packages/sync-server`](packages/sync-server) | `@ariadne-dev/sync-server` — an optional, self-hosted cloud sync server (Express + Postgres) for syncing tasks/checkpoints across machines/teammates. |

## Getting started

Requires Node.js 20+ and [pnpm](https://pnpm.io/) (10.34.4, see
`packageManager` in `package.json`).

```bash
git clone https://github.com/LAKSHYAKUMAR45/Ariadne.git
cd Ariadne
pnpm install
pnpm build   # builds all packages, in dependency order
pnpm test    # runs the full test suite across all packages
```

### One-command install (recommended)

These work on a completely fresh machine — no manual `pnpm install` needed
first, and no assumptions about what's already on the box:

```bash
pnpm run install:cli      # builds the CLI, npm links it -> `ariadne` on PATH
pnpm run install:mcp      # builds the MCP server, npm links it, prints the client config snippet
pnpm run install:vscode   # builds + packages the extension for your OS/arch, installs it via `code`
pnpm run install:all      # runs all three of the above in sequence
```

Each of these first runs `scripts/preflight.mjs` (checks Node 20+, npm,
git, and pnpm — auto-enabling pnpm via corepack if it's missing — and
warns, non-fatally, if a C/C++ build toolchain isn't present, which is
only needed as a fallback if `better-sqlite3` has no prebuilt binary for
your exact platform/Node version) and then runs `pnpm install` itself, so
they're safe to run as the very first command on a brand-new clone/server.

You can also run the preflight check on its own:

```bash
pnpm run preflight   # verifies Node/npm/git/pnpm/build-toolchain, no build/install side effects
```

`install:vscode` auto-detects your platform/arch, produces the dual
desktop+server ABI `.vsix` (see "multi-platform packaging" in
[`packages/vscode-extension/README.md`](packages/vscode-extension/README.md)),
and installs it with the `code` (or `code-insiders`) CLI if present —
otherwise it prints the manual install command. Re-run any of these any
time you pull new changes; they're idempotent. Scripts live in
[`scripts/`](scripts/) if you want to see or tweak the exact steps.

### Verifying the install (smoke test)

Once installed, sanity-check that the CLI, MCP server, and VS Code
extension are actually working end to end — not just that unit tests pass:

```bash
pnpm run verify:install
```

This creates a scratch task with `ariadne`, spawns `ariadne-mcp-server`
and performs a real MCP `initialize` handshake over stdio, and checks the
extension is present in `code --list-extensions`. It's a smoke test of the
*installed* binaries, complementary to the package-level unit test suites
below.

### Running the test suite

```bash
pnpm test                                   # every package's unit tests
pnpm --filter @ariadne-dev/core test        # just the storage layer
pnpm --filter @ariadne-dev/cli test         # just the CLI
pnpm --filter @ariadne-dev/mcp-server test  # just the MCP server
pnpm --filter ariadne-vscode test           # just the VS Code extension
```

### Using the CLI

```bash
pnpm --filter @ariadne-dev/cli build
node packages/cli/dist/index.js task new "Fix login bug"
node packages/cli/dist/index.js status
```

Common commands: `task new <title>`, `task list`, `task use <id>`,
`task pause` / `task done` / `task archive` / `task reopen`,
`checkpoint <summary>`, `decision <text>`, `error add <message>` / `error list` / `error resolve <id>`,
`todo add <text>` / `todo list` / `todo done <id>`,
`question add <text>` / `question list` / `question resolve <id>`,
`search <query>`, `status`, `resume`, `git-sync`, `export`, `where`,
`sync login` / `sync push` / `sync pull` (see "Cloud sync" below). Run `ariadne --help` for the full list.

Any command that takes `--task <id>` (or `[id]`) works across workspaces:
if the id isn't a task in your current workspace, Ariadne transparently
looks it up in the global cross-workspace registry (`~/.ariadne/registry.db`)
and operates on the workspace that actually owns it — no need to `cd` there
first. `task list --all-workspaces` and `search <query> --all-workspaces`
list/search every workspace you've ever used Ariadne in, not just the
current one. See "Cross-workspace task discovery" below.

### Cross-workspace task discovery

Each workspace's `.ariadne/state.db` is still the source of truth for that
workspace's tasks — but Ariadne also maintains a small global index at
`~/.ariadne/registry.db` (which task ids live in which workspace, kept live
automatically as you work) purely so you can discover and act on tasks
without needing to remember, or `cd` into, every workspace:

```bash
ariadne task list --all-workspaces     # every task in every workspace you've used
ariadne search "flaky test" -a         # search every workspace's checkpoints/decisions/todos/etc
ariadne status --task <id>             # works even if <id> belongs to a different workspace
```

This is index-only, not sync — nothing is copied between workspaces, and a
workspace that's been deleted from disk is just skipped rather than
breaking the search.

### Cloud sync (optional, self-hosted)

For teams that want tasks/checkpoints to follow them across machines (or be
shared with teammates), Ariadne can optionally sync to a self-hosted
`@ariadne-dev/sync-server` instance — see
[`docs/06-CLOUD-SYNC-DESIGN.md`](docs/06-CLOUD-SYNC-DESIGN.md) for the
product decisions and [`docs/07-CLOUD-SYNC-API-CONTRACT.md`](docs/07-CLOUD-SYNC-API-CONTRACT.md)
/ [`packages/sync-server/README.md`](packages/sync-server/README.md) for
running the server itself. This is entirely opt-in — nothing leaves your
machine unless you run these commands.

```bash
ariadne sync register <username> <password> --server https://your-sync-server
ariadne sync push          # push local task/checkpoint changes
ariadne sync pull          # pull changes made by teammates / other machines
ariadne sync list-remote   # browse every task on the server, including ones never linked here
ariadne sync unlink <id>   # clear a task's link to the sync server, locally only
```

`sync push`/`sync pull` take an optional `--task <id>` to scope to a single
task. `sync pull --import-new` also creates local tasks for remote ones this
workspace has never linked, instead of skipping them. Phase 1 syncs `tasks`
and `checkpoints` only (todos/decisions/open questions/commands/files stay
local for now); access is flat (any account on the server can read/write
any synced task) and conflicts are resolved remote-wins.

### Using the MCP server

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/mcp-server build
node packages/mcp-server/dist/index.js   # speaks MCP over stdio
```

Point any MCP-capable client (Claude Code, Gemini CLI, Codex, Copilot Chat's
MCP integration, or a custom agent) at that command. See
[`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the full
tool list.

### Using the VS Code extension

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter ariadne-vscode build
pnpm --filter ariadne-vscode package   # produces a .vsix for your current platform
```

Install the generated `.vsix` via the Extensions view → "Install from
VSIX...", then open a folder and type `@ariadne` in Copilot Chat (or use the
**Ariadne: New Task** / **Ariadne: Show Task Status** commands). See
[`packages/vscode-extension/README.md`](packages/vscode-extension/README.md)
for chat commands, natural-language phrasing, passive capture, and
multi-platform packaging details.

`@ariadne /task list --all-workspaces` and `@ariadne /search <query>
--all-workspaces` (or natural language like "list tasks in all
workspaces") work the same way as the CLI — plus `@ariadne /task done
<id>` (and `pause`/`archive`/`reopen`) transparently resolve and update a
task even if it belongs to a workspace other than the one currently open
in the editor.

## Project status

Early / pre-release. The CLI, MCP server, and VS Code extension are all
functional and tested. Expect rough edges — see each package's README for
known limitations.

## Contributing

Issues and PRs welcome. CI runs build/typecheck/test on every push and PR
(see `.github/workflows/ci.yml`); tagged releases (`v*`) automatically build
and publish multi-platform `.vsix` artifacts (see
`.github/workflows/release.yml`).

If your PR changes the behavior of `@ariadne-dev/core`, `ariadne` (CLI), or
`@ariadne-dev/mcp-server` (the VS Code extension is released separately as a
`.vsix`, not to npm), add a changeset describing it:

```bash
pnpm changeset
```

This records what changed and what kind of version bump it warrants
(patch/minor/major). `.github/workflows/packages-release.yml` turns pending
changesets into a "Version Packages" PR, and publishes to npm once that PR is
merged.

## License

MIT — see [LICENSE](LICENSE).
