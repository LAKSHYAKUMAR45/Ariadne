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
                         │  @ariadne/core │   SQLite schema + TaskStore
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

See [`docs/`](docs/) for the full design docs (product requirements,
architecture, data model, and roadmap).

## Packages

This is a pnpm workspace monorepo:

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@ariadne/core` — the shared SQLite schema, `TaskStore`, and context-building logic used by every surface. |
| [`packages/cli`](packages/cli) | `ariadne` — a command-line interface for managing tasks, todos, checkpoints, and status. |
| [`packages/mcp-server`](packages/mcp-server) | `@ariadne/mcp-server` — an MCP server exposing task state as tools to any MCP-capable AI client (Claude Code, Gemini CLI, Codex, Copilot, etc.), no VS Code required. |
| [`packages/vscode-extension`](packages/vscode-extension) | `ariadne-vscode` — a VS Code extension that adds an `@ariadne` Copilot Chat participant, commands, and passive background capture (saved files, terminal commands, git commits). |

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

### Using the CLI

```bash
pnpm --filter ariadne build
node packages/cli/dist/index.js task new "Fix login bug"
node packages/cli/dist/index.js status
```

Common commands: `task new <title>`, `task list`, `task use <id>`,
`task pause` / `task done` / `task archive` / `task reopen`,
`checkpoint <summary>`, `decision <text>`, `error add <message>` / `error list` / `error resolve <id>`,
`todo add <text>` / `todo list` / `todo done <id>`,
`question add <text>` / `question list` / `question resolve <id>`,
`search <query>`, `status`, `resume`, `git-sync`, `export`, `where`. Run `ariadne --help` for the full list.

### Using the MCP server

```bash
pnpm --filter @ariadne/core build
pnpm --filter @ariadne/mcp-server build
node packages/mcp-server/dist/index.js   # speaks MCP over stdio
```

Point any MCP-capable client (Claude Code, Gemini CLI, Codex, Copilot Chat's
MCP integration, or a custom agent) at that command. See
[`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the full
tool list.

### Using the VS Code extension

```bash
pnpm --filter @ariadne/core build
pnpm --filter ariadne-vscode build
pnpm --filter ariadne-vscode package   # produces a .vsix for your current platform
```

Install the generated `.vsix` via the Extensions view → "Install from
VSIX...", then open a folder and type `@ariadne` in Copilot Chat (or use the
**Ariadne: New Task** / **Ariadne: Show Task Status** commands). See
[`packages/vscode-extension/README.md`](packages/vscode-extension/README.md)
for chat commands, natural-language phrasing, passive capture, and
multi-platform packaging details.

## Project status

Early / pre-release. The CLI, MCP server, and VS Code extension are all
functional and tested. Expect rough edges — see each package's README for
known limitations.

## Contributing

Issues and PRs welcome. CI runs build/typecheck/test on every push and PR
(see `.github/workflows/ci.yml`); tagged releases (`v*`) automatically build
and publish multi-platform `.vsix` artifacts (see
`.github/workflows/release.yml`).

If your PR changes the behavior of `@ariadne/core`, `ariadne` (CLI), or
`@ariadne/mcp-server` (the VS Code extension is released separately as a
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
