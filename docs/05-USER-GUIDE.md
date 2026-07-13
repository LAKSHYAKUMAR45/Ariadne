# Ariadne — User Guide

*A practical, task-oriented guide to using Ariadne day-to-day. For design
rationale and internals, see the other files in [`docs/`](.); for
contributor/build details, see the top-level [README](../README.md) and each
package's own README.*

**Contents:**
[1. What Ariadne does](#1-what-ariadne-actually-does-for-you) ·
[2. Three surfaces](#2-the-three-ways-to-use-it) ·
[3. Installing](#3-installing) ·
[4. Quick start](#4-quick-start) ·
[5. CLI](#5-using-the-cli) ·
[6. MCP client](#6-using-an-mcp-client-claude-code-gemini-cli-codex-custom-agents-etc) ·
[7. VS Code + Copilot Chat](#7-using-the-vs-code-extension-copilot-chat) ·
[8. Cross-workspace](#8-working-across-multiple-workspaces) ·
[9. Cloud sync](#9-cloud-sync-optional-self-hosted) ·
[10. Data & privacy](#10-data-privacy) ·
[11. Troubleshooting](#11-troubleshooting) ·
[12. Project status](#12-project-status)

## 1. What Ariadne actually does for you

Every AI coding assistant forgets everything the moment you close the chat,
switch tools, or hit a context limit. Ariadne fixes that by treating the
**task** — not the chat — as the thing that persists. While you work, it
keeps a running record of:

- **Goal** — what you're actually trying to accomplish.
- **Decisions** — things you (or the assistant) decided along the way, and why.
- **Todos** — what's left to do.
- **Errors** — unresolved problems, and when they get fixed.
- **Open questions** — things you're unsure about, blocking progress.
- **Checkpoints** — periodic summaries of progress.
- **Files touched, commands run, git commits/branches** — captured
  automatically as you work (in the editor).

All of it lives in a local SQLite database (`.ariadne/state.db`), not in a
chat transcript. That means: switch from Copilot to Claude Code to a plain
CLI session, or close VS Code and come back next week — the task state is
still there, in full, ready to be reloaded.

## 2. The three ways to use it

Ariadne intentionally has **no primary UI** — you use it through whichever
interface you're already in:

| Surface | Best for |
|---|---|
| **CLI** (`ariadne`) | Scripting, terminal-first workflows, any assistant that can run shell commands. |
| **MCP server** (`@ariadne-dev/mcp-server`) | Any MCP-capable AI client (Claude Code, Gemini CLI, Codex, Copilot's MCP integration, custom agents) — task state becomes tools/resources the assistant can call directly. |
| **VS Code extension** (`@ariadne` chat participant) | Copilot Chat users in VS Code — type `@ariadne ...` like any other chat participant. |

All three read and write the exact same data. Use whichever fits the moment;
there's nothing to keep in sync manually.

## 3. Installing

Requires Node.js 20+.

**CLI:**
```bash
npm install -g ariadne   # once published — see package status below
# or, from source:
git clone https://github.com/LAKSHYAKUMAR45/Ariadne.git && cd Ariadne
pnpm install && pnpm build
node packages/cli/dist/index.js --help
```

**VS Code extension:** install the `.vsix` from a
[release](https://github.com/LAKSHYAKUMAR45/Ariadne/releases) (or build one
yourself — see the main README) via Extensions view → "Install from VSIX...".

**MCP server:** point your MCP client's config at
`node packages/mcp-server/dist/index.js` (built from source today; see
"Setting up the MCP server in an MCP client" below).

> The project is early/pre-release — npm publishing of `ariadne` and
> `@ariadne-dev/mcp-server` is set up (via changesets) but may not have happened
> yet. Building from source always works.

## 4. Quick start

Pick one surface to start with — the CLI is the fastest way to see it work:

```bash
cd your-project           # any git repo or folder works
ariadne task new "Fix the flaky login test" --goal "Make CI green again"
ariadne checkpoint "Reproduced the failure locally, seems like a race condition"
ariadne todo add "Add a retry with backoff around the login call"
ariadne decision "Use exponential backoff, not a fixed delay" --rationale "Fixed delay masks races non-deterministically"
ariadne status
```

`ariadne status` prints exactly what a fresh chat session (in any assistant)
needs to pick up where you left off — workspace root, tracked git branch,
goal, latest checkpoint, open questions, unresolved errors, blocked todos,
decisions, pending todos, recently touched files, recent commits, and recent
commands, trimmed to a token budget so it's cheap to paste or auto-inject
into a prompt.

That's the whole loop: **start a task once, then keep checkpointing/
recording as you go, and reload with `status`/`resume` whenever you (or a
new chat) need the context back.**

## 5. Using the CLI

Every command operates on the "current task" for the current workspace by
default (set via `task new` or `task use`), or an explicit task via
`--task <id>` / a positional `[id]`.

```bash
ariadne task new <title> [--goal <goal>]       # create a task, mark it current
ariadne task list [--status <s>] [-a]          # list tasks (-a = every workspace)
ariadne task use <id>                          # switch current task
ariadne task pause|done|archive|reopen [id]    # change lifecycle status
ariadne task edit [id] [--title <t>] [--goal <g>]  # rename/reword a task (curation)

ariadne checkpoint <summary> [--level micro|session|milestone] [--task <id>]
ariadne decision <text> [--rationale <text>] [--task <id>]     # record a decision
ariadne decisions list [--task <id>]                           # list decisions
ariadne decisions edit <id> [--text <t>] [--rationale <r>] [--task <id>]
ariadne decisions delete <id> [--task <id>]

ariadne todo add <text> [--task <id>]
ariadne todo list [--status pending|done|blocked] [--task <id>]
ariadne todo done <id> [--task <id>]
ariadne todo reopen <id> [--task <id>]         # set a done/blocked todo back to pending
ariadne todo block <id> [--task <id>]
ariadne todo edit <id> --text <text> [--task <id>]
ariadne todo delete <id> [--task <id>]

ariadne error add <message> [--task <id>]
ariadne error list [--all] [--task <id>]
ariadne error resolve <id> [--resolution <text>] [--task <id>]
ariadne error reopen <id> [--task <id>]
ariadne error edit <id> -m <message> [--task <id>]
ariadne error delete <id> [--task <id>]

ariadne question add <text> [--task <id>]
ariadne question list [--all] [--task <id>]
ariadne question resolve <id> [--task <id>]
ariadne question reopen <id> [--task <id>]
ariadne question edit <id> --text <text> [--task <id>]
ariadne question delete <id> [--task <id>]

ariadne status [--task <id>] [--budget <tokens>]   # ranked context summary
ariadne resume [--task <id>] [--budget <tokens>]   # alias of status

ariadne search <query> [--limit <n>] [-a]      # substring search, -a = every workspace
ariadne git-sync [--task <id>]                 # record current branch + new commits
ariadne export [--task <id>] [--out <path>]    # render task to Markdown
ariadne where                                  # print resolved workspace root + db path

ariadne exec -- <command> [args...]            # run a command, auto-recording it and any failure

ariadne workspace list                         # list every known workspace (cross-workspace registry)
ariadne workspace prune                        # remove registry entries for deleted workspaces
ariadne workspace forget <root>                # remove one workspace from the registry explicitly
ariadne backup [--out <dir>]                   # snapshot state.db + registry.db
ariadne restore <path> [--registry]            # restore a snapshot

ariadne sync register <username> <password> --server <url>  # create an account on a sync server, then log in
ariadne sync login <username> <password> --server <url>     # log in, storing a token in ~/.ariadne/sync-config.json
ariadne sync logout                            # forget the locally-stored token (server account is untouched)
ariadne sync push [--task <id>]                # push new/changed tasks + checkpoints to the sync server
ariadne sync pull [--task <id>] [--import-new]  # pull tasks/checkpoints changed by teammates/other machines
ariadne sync list-remote                       # browse every task on the server, including ones never linked here
```

Run `ariadne --help` or `ariadne <command> --help` for the authoritative list
and flags at any time.

**Tip:** `--task <id>` works even for a task from a *different* workspace —
see [§8 Cross-workspace tasks](#8-working-across-multiple-workspaces). The
`edit`/`delete`/`reopen` commands above are curation operations for fixing
typos or discarding stale entries — none of them are auto-generated, so use
them freely without worrying about breaking passive capture.

**`ariadne exec`** is a lightweight passive-capture option for CLI-only
workflows (Claude Code, Gemini CLI, Codex, or any assistant that isn't the
VS Code extension) — the VS Code extension captures file saves, terminal
commands, and git commits automatically in the background; outside VS Code
there's no daemon doing that, so `ariadne exec -- <command>` is the
CLI-native equivalent for at least terminal commands: it runs the command
exactly as if you'd typed it (live stdout/stderr, same exit code, works in
scripts/CI), and against the current task it automatically records the
command (redacted the same way passive capture redacts obvious secrets)
plus, if it fails, an unresolved error summarizing the failure — so a
failing `ariadne exec -- npm test` shows up under `/status`'s unresolved
errors without an extra manual `ariadne error add`. `--` is the recommended
separator so flags meant for the wrapped command aren't parsed by `ariadne`
itself. File-save and git-commit capture, and the "no current task" /
branch-mismatch notices, remain VS Code-only for now.

## 6. Using an MCP client (Claude Code, Gemini CLI, Codex, custom agents, etc.)

The MCP server exposes the same operations as tools an AI assistant can call
directly, plus two read-only resources. Point your client at:

```json
{
  "mcpServers": {
    "ariadne": {
      "command": "node",
      "args": ["/absolute/path/to/Ariadne/packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

(`cwd` determines which workspace's `.ariadne/state.db` the server opens —
set it per-project, or per-MCP-config, if your client supports that.)

Once connected, the assistant can call `task_new`, `task_list`, `task_use`,
`task_pause`/`done`/`archive`/`reopen`, `task_edit`, `checkpoint_add`,
`todo_add`/`list`/`done`/`reopen`/`block`/`edit`/`delete`, `decision_add`/
`list`/`edit`/`delete`, `error_add`/`list`/`resolve`/`reopen`/`edit`/`delete`,
`question_add`/`list`/`resolve`/`reopen`/`edit`/`delete`, `search`,
`get_context`, `git_sync`, and `export_task` — see
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md) for the
full reference and exact input shapes. In practice, you'd typically start a
conversation with something like *"check my current Ariadne task before we
start"* — the assistant calls `get_context` and picks up right where a
previous session left off, even if that previous session was in a
completely different tool.

## 7. Using the VS Code extension + Copilot Chat

Open a folder in VS Code (or attach the workspace root you want to use),
and type `@ariadne` in Copilot Chat. You can use slash commands or plain
language — Ariadne uses rule-based phrase matching (no LLM calls) to route
common phrasings:

```
@ariadne /task new Fix the login bug
@ariadne /status
@ariadne /status --budget 500
@ariadne /git-sync
@ariadne /export
@ariadne remind me to write a changelog entry
@ariadne decision: use SQLite for storage
@ariadne what was I doing?
```

Full command reference:
[`packages/vscode-extension/README.md`](../packages/vscode-extension/README.md).
`/git-sync` records the current git branch and any new commits into the
current (or an explicit) task — the same thing the CLI's `git-sync` and
MCP's `git_sync` do, for whenever passive capture's automatic git watcher
hasn't run yet. `/export` renders the task to Markdown, writes it to
`.ariadne/export/<task-id>.md` by default (or `--out <path>` for a custom
location), and also shows it inline in the chat response.

Two things happen automatically in the background, no chat interaction
needed:
- **Passive capture** — saved files, terminal commands (redacted of obvious
  secrets), and diagnostics (new/resolved errors) are recorded against
  whatever task is current, as long as you've started one.
- **Command Palette** — **Ariadne: New Task** and **Ariadne: Show Task
  Status** work without opening chat at all; **Ariadne: Select Workspace
  Folder** matters if you have a multi-root workspace open.

A **status bar item** always shows the current task's title (or "no task"
if none is set yet for this workspace); click it to open `/status` or start
a new task. Two guardrails help catch silent misattribution:
- If a workspace has no current task, you'll get a one-time notice the
  first time passive capture would otherwise silently drop an event (a
  save, terminal command, or diagnostic) — a nudge to run
  `/task new <title>` rather than losing that context forever.
- If the checked-out git branch no longer matches the branch the current
  task was last tracked on, you'll get a warning suggesting `/task use <id>`
  — useful if you switched branches (or meant to switch tasks) without
  telling Ariadne.

Passive capture never auto-starts or auto-switches tasks — it only appends
to a task you've explicitly started via `/task new` or "Ariadne: New Task".
Toggle it off via the `ariadne.passiveCapture.enabled` setting if you don't
want it.

## 8. Working across multiple workspaces

If you work on more than one repo/project, Ariadne keeps a small global
index at `~/.ariadne/registry.db` (separate from any project's own
`.ariadne/state.db`) so a task started in one workspace is still
discoverable and fully usable — read *and* write — from another:

```bash
ariadne task list --all-workspaces      # every task, from every workspace you've used
ariadne search "flaky test" -a          # search everywhere at once
ariadne status --task <id>              # works even if <id> is from a different workspace
```

The same works in the MCP server (`allWorkspaces: true` on `task_list`/
`search`, and any `taskId` argument on any tool) and in Copilot Chat
(`/task list --all-workspaces`, `/search <query> --all-workspaces`, `/task
done <id>` etc., or "list tasks in all workspaces").

**What this is not:** it's not a sync mechanism, and it doesn't merge repos
into one task. Each workspace's own database is still the sole owner of its
own tasks; the registry is just an index letting you find and route to the
right one without remembering (or `cd`-ing into) every workspace you've
worked in. If a workspace's folder is later deleted, its entries just
disappear from cross-workspace results — nothing else is affected.

**What stays per-workspace, deliberately:** the "current task" concept
(`task use`) is always scoped to the workspace you're in — switching your
current task in workspace A never affects workspace B.

## 9. Cloud sync (optional, self-hosted)

Cross-workspace discovery (§8) only works *on one machine*. If you need
tasks/checkpoints to follow you across machines, or to be shared with
teammates, Ariadne optionally supports syncing to a self-hosted
`@ariadne-dev/sync-server` instance (Express + Postgres, built and run by
you or your team — there's no Ariadne-hosted cloud). This is entirely
opt-in: nothing leaves your machine unless you explicitly run `ariadne
sync` commands.

```bash
ariadne sync register <username> <password> --server https://your-sync-server   # first time only
ariadne sync login <username> <password> --server https://your-sync-server     # subsequent machines/logins
ariadne sync push                       # push local task/checkpoint changes
ariadne sync pull                       # pull changes made by teammates / other machines
ariadne sync list-remote                # browse every task on the server, including ones never linked here
ariadne sync logout                     # forget the locally-stored token
```

What to know:
- **Scope (Phase 1):** only `tasks` and `checkpoints` sync today — todos,
  decisions, open questions, commands, and files stay local-only for now.
- **`push`** sends every task that's new or changed since it was last
  synced (or just `--task <id>`), then pushes any not-yet-synced
  checkpoints for those tasks. The server assigns each a permanent id,
  stored locally as that task's/checkpoint's `remote_id`. Each push also
  sends a `workspaceLabel` (e.g. `laptop1:org/atom` — hostname + git
  remote/folder name), so the server (and teammates) can tell which
  machine/repo a task came from, not just which user account pushed it.
- **`pull`** applies remote changes to tasks *already linked* to this
  workspace (i.e., ones pushed from here before) and downloads any new
  checkpoints for them. By default it does not fabricate brand-new local
  tasks for ones pushed from a workspace you've never linked here — you'll
  see a list of "skipped" remote workspace labels in that case. Pass
  `ariadne sync pull --import-new` to instead create a local task for each
  of those (already linked via `remote_id`, using the server's own
  timestamps), including pulling in their existing checkpoints.
  **Caveat:** pull only asks the server for tasks changed since your last
  pull — if you already pulled (and skipped) a task once, a later
  `--import-new` run won't re-import it unless it changes again remotely.
  Run `--import-new` from the start (or use `list-remote` first to see
  what exists) rather than adding it as an afterthought.
- **`list-remote`** is browse-only: it lists *every* task on the server
  (owner + workspace label + status), including ones from workspaces
  you've never linked, without creating or changing anything locally. Use
  this to see what's out there *before* deciding whether to `pull
  --import-new` it.
- **Access is flat:** any account on the server can read/write any synced
  task — there's no per-task ACL. Treat the server as a shared, trusted
  team space, not a permissions boundary.
- **Conflict resolution is "remote wins"** in Phase 1 — the simplest
  possible rule. Real last-write-wins-by-field is a later-phase
  improvement.
- **No delete propagation:** archiving/deleting a task locally never
  deletes it from the server, and there's no delete endpoint at all yet.
- Credentials/token are stored locally at `~/.ariadne/sync-config.json`.

See [`docs/06-CLOUD-SYNC-DESIGN.md`](06-CLOUD-SYNC-DESIGN.md) for the
product decisions behind this, [`docs/07-CLOUD-SYNC-API-CONTRACT.md`](07-CLOUD-SYNC-API-CONTRACT.md)
for the schema/API contract, and
[`packages/sync-server/README.md`](../packages/sync-server/README.md) for
running your own server.

## 10. Data & privacy

- Everything lives locally at `<workspace-root>/.ariadne/state.db`
  (per-workspace) and `~/.ariadne/registry.db` (a cross-workspace index).
  Nothing is sent over the network by Ariadne itself, **unless** you
  explicitly opt in to cloud sync (§9) by running `ariadne sync
  register`/`login`/`push`/`pull` — those are the only commands that ever
  talk to a network address, and only to the self-hosted server you point
  them at.
- `.ariadne/` is gitignored by default — task state doesn't get committed or
  pushed unless you explicitly export it.
- `ariadne export` (or the `export_task` MCP tool, or asking the chat
  participant) renders a task to Markdown — the only opt-in way task
  history leaves the database, e.g. to paste into a PR description.
- Terminal commands captured by passive capture are redacted for
  obviously secret-bearing patterns (API keys, tokens, `.env`-style
  assignments) before being stored.
- Deleting `.ariadne/` in a workspace removes all of that workspace's task
  history; it will also just stop showing up in cross-workspace results
  the next time the registry is consulted.

**Registry maintenance:**
```bash
ariadne workspace list                  # every workspace root ever seen, flags ones missing on disk
ariadne workspace prune                 # forget every workspace whose directory no longer exists
ariadne workspace forget <root>         # forget one workspace root explicitly (its own state.db is untouched)
```
The registry (`~/.ariadne/registry.db`) is just an index — forgetting or
pruning a workspace only removes it from cross-workspace discovery; it
never touches that workspace's own `.ariadne/state.db`. A forgotten
workspace's tasks reappear automatically the next time its store is opened
again (e.g. `cd`-ing back into it and running any command).

**Backup & restore:**
```bash
ariadne backup [--out <dir>]            # copy state.db + registry.db to a timestamped snapshot
ariadne restore <path> [--registry]     # restore a snapshot over state.db (or the registry, with --registry)
```
`backup` defaults to `<workspace-root>/.ariadne/backups/`. `restore` always
backs up whatever db is currently at the target path first (as
`<path>.pre-restore-<timestamp>.bak`), so a bad restore is itself
recoverable.

## 11. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `No task specified and no current task set` | Run `ariadne task new <title>` first, or pass `--task <id>` explicitly. |
| `@ariadne` doesn't respond in Copilot Chat | Confirm the extension is installed/enabled and a folder is open — Ariadne needs a workspace to find or create `.ariadne/state.db`. Check the "Ariadne" output channel for errors. |
| A task from another workspace isn't found via `--task <id>` | The other workspace must have been opened by *some* Ariadne surface at least once since the registry was introduced, so it gets registered. Open it once (any command) to backfill it. |
| MCP client can't see any tools | Verify the `command`/`args`/`cwd` in your MCP client config point at a built `packages/mcp-server/dist/index.js` and a real project directory. |
| Multi-root VS Code workspace acts on the "wrong" folder | Run **Ariadne: Select Workspace Folder** to pin which folder Ariadne should track. |
| `Not logged in to a sync server` on `ariadne sync push`/`pull` | Run `ariadne sync login <username> <password> --server <url>` first (or `sync register` if you don't have an account yet). |
| `ariadne sync push` says a checkpoint wasn't pushed | Checkpoints can't be pushed until their parent task has a `remote_id` — push happens task-first, automatically, within the same `sync push` call; if the task push itself failed (check the error), fix that first. |
| Want a clean slate | Delete `.ariadne/` in the workspace (removes that workspace's tasks) and/or `~/.ariadne/registry.db` (removes the cross-workspace index only — doesn't touch any workspace's own data). Cloud-synced data on the server, if any, is untouched either way (delete is local-only, per §9). |

## 12. Project status

Early / pre-release. The core CLI/MCP/VS Code trio is built for a single
developer working across one or more workspaces on one machine; cloud sync
(§9) is an optional, opt-in add-on (Phase 1: tasks + checkpoints only) for
teams that want to share state across machines/people via a self-hosted
server. See the main [README](../README.md) and
[`docs/04-ROADMAP.md`](04-ROADMAP.md) for what's shipped vs. deferred.
