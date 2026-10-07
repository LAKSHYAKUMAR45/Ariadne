# Ariadne — User Guide

*A practical, task-oriented guide to using Ariadne day-to-day. For design
rationale and internals, see the other files in [`docs/`](.); for
contributor/build details, see the top-level [README](../README.md) and each
package's own README.*

For a complete capability inventory and interface availability matrix, see
the [feature reference](FEATURES.md). This guide covers standalone Ariadne;
JCNR-specific deployment/SSO overlays have their own repository runbooks.

**Contents:**
[1. What Ariadne does](#1-what-ariadne-actually-does-for-you) ·
[2. Interfaces](#2-the-three-ways-to-use-it) ·
[3. Installing](#3-installing) ·
[4. Quick start](#4-quick-start) ·
[5. CLI](#5-using-the-cli) ·
[5.1 Knowledge workspace](#51-knowledge-workspace) ·
[6. MCP client](#6-using-an-mcp-client-claude-code-gemini-cli-codex-custom-agents-etc) ·
[7. VS Code + Copilot Chat](#7-using-the-vs-code-extension-copilot-chat) ·
[8. Cross-workspace](#8-working-across-multiple-workspaces) ·
[9. Cloud sync](#9-cloud-sync-optional-self-hosted) ·
[9.1. Operations console](#91-operations-console) ·
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

Ariadne provides three local interfaces and an optional self-hosted browser
console. Choose the interface that fits your workflow:

| Surface | Best for |
|---|---|
| **CLI** (`ariadne`) | Scripting, terminal-first workflows, any assistant that can run shell commands. |
| **MCP server** (`@ariadne-dev/mcp-server`) | Any MCP-capable AI client (Claude Code, Gemini CLI, Codex, Copilot's MCP integration, custom agents) — task state becomes tools/resources the assistant can call directly. |
| **VS Code extension** (`@ariadne` chat participant) | Copilot Chat users in VS Code — type `@ariadne ...` like any other chat participant. |
| **VS Code panel** | Task switching, editable working memory, captures, context handoff, and review readiness without typing chat commands. |
| **Browser console** | Server-side tasks and guarded administration of an optional self-hosted deployment. |

The local CLI, MCP server, and extension share the same workspace database.
The browser console reads server-side state; use explicit task sync to move
supported local task memory to it. Knowledge data does not cloud-sync.

## 3. Installing

Requires Node.js 20+.

**Install from source** (Node.js 20+, Git, npm, and pnpm 10.34.4):
```bash
git clone https://github.com/LAKSHYAKUMAR45/Ariadne.git
cd Ariadne
pnpm run install:cli
ariadne --help
```

The installer runs preflight, installs workspace dependencies, builds the CLI,
and links `ariadne` onto `PATH`. Use `install:mcp`, `install:vscode`, or
`install:all` for the other surfaces. Native SQLite bindings may need a C/C++
toolchain when a matching prebuilt binary is unavailable.

Without a global CLI link:

```bash
pnpm install
pnpm build
node /absolute/path/to/Ariadne/packages/cli/dist/index.js --help
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

After installation, run `ariadne where` in the target project to confirm the
workspace root and database path. In a plain folder, `ariadne init` establishes
storage and project guidance; inspect generated `.github` files before
committing them. It does not itself register a cloud account or push data.
Re-run the appropriate installer after updating the source. For installation
diagnostics, use `pnpm run preflight`; `pnpm run verify:install` exercises the
installed binaries and creates a scratch task.

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

Replace example titles with your own. Commands that return IDs print them;
copy those IDs into later `<task-id>`, `<todo-id>`, `<project-id>`, and other
placeholders rather than typing the angle-bracket notation literally.

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
ariadne capture [task-id]                    # safe snapshots of eligible task-touched files
ariadne decision <text> [--rationale <text>] [--task <id>]     # record a decision
ariadne decision <text> --supersedes <decision-id>             # replace an obsolete decision
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

ariadne sync setup [username] [--register]     # configured tunnel + secure password prompt
ariadne sync logout [--profile <name>]         # forget the locally-stored token (server account is untouched)
ariadne sync push [--task <id>] [--profile <name>]                # push new/changed tasks, checkpoints, todos, decisions, errors, open questions, commands
ariadne sync pull [--task <id>] [--import-new] [--on-conflict <remote-wins|local-wins>] [--profile <name>]  # pull the same, changed by teammates/other machines
ariadne sync list-remote [--profile <name>]    # browse every task on the server, including ones never linked here
ariadne sync unlink <taskId>                   # clear a task's link to the sync server, locally only
ariadne sync profile list                      # list every configured sync profile, flagging which is current
ariadne sync profile use <name>                # switch which sync profile is current
```

Run `ariadne --help` or `ariadne <command> --help` for the authoritative list
and flags at any time.

### Daily task loop

At session start, run `resume`, then select the intended task with `task use`
if necessary. Keep decisions and blockers current as you work; checkpoint at
natural handoff points. For example:

```bash
ariadne resume --budget 2000
ariadne task use <task-id>
ariadne exec -- pnpm test
ariadne git-sync
ariadne checkpoint "Implemented the fix; remaining review work is tracked" --level session
ariadne export --task <task-id>
```

`exec` preserves live command output and exit status, records a redacted
command, and records failures as errors. It is not a shell-history importer.
Checkpoint/explicit capture only retain eligible tracked, task-touched text;
they skip unsafe/ignored files rather than taking a full workspace snapshot.
Use `.ariadneignore` to exclude additional sensitive content.

Before completion, resolve relevant todos/errors/questions and inspect the
evidence yourself, then run `task done`. Completion is a lifecycle label, not
an automatic assertion that tests passed. Use `task reopen` to continue work
and `task archive` to retire it without deleting its history.

### 5.1 Knowledge workspace

The knowledge workspace is the local-first, core-backed wiki surface. It uses
the same `.ariadne/state.db` as task history, but keeps projects, sources,
versioned Markdown pages, provenance, graph data, reviews, and queued work in
knowledge-specific tables. The CLI and MCP server are two adapters over this
same data.

Create a project and ingest a source:

```bash
ariadne knowledge project create "Project wiki" --roots src,docs
ariadne knowledge source scan <project-id> docs --max-bytes 1048576
ariadne knowledge ingest file <project-id> docs/02-ARCHITECTURE.md
ariadne knowledge worker run <project-id> --once
ariadne knowledge worker status <project-id>
ariadne knowledge page list <project-id>
ariadne knowledge search <project-id> "storage boundary"
```

Run the ingestion example in the Ariadne checkout, or substitute a real
workspace-relative document from your project. No provider is needed.
Ingestion registers a source version and queues work; the worker performs
analysis, graph materialization, indexing, and deterministic page generation.
Scanning only previews eligible files and does not enqueue them.

For a folder:

```bash
ariadne knowledge ingest folder <project-id> src --max-bytes 1048576
ariadne knowledge worker run <project-id> --once --concurrency 2
```

Always preview and inspect sources first. Folder operations have an explicit
size option; direct file ingestion does not expose that option or equivalent
binary scanning, so use it only for inspected text/code files.

The implemented offline path includes content-backed lexical search,
page/version storage, task-history projections, bounded graph
neighborhood/path queries, review actions, and project archive export/import.
Use `--json` on CLI commands when integrating with scripts. See the complete
reference in [`knowledge-wiki.md`](knowledge-wiki.md).

#### Processing and maintaining the queue

```bash
ariadne knowledge worker concurrency <project-id> --set 2
ariadne knowledge worker concurrency <project-id>
ariadne knowledge worker run <project-id> --watch --poll-ms 1000
ariadne knowledge worker concurrency <project-id> --reset
```

Concurrency accepts integers 1-8: an explicit `--concurrency` overrides the
host-local project setting, otherwise the default is 1. The setting is not
portable archive data. Watch mode polls eligible queue jobs until interrupted
with Ctrl+C; it rejects `--json`. It does not automatically ingest file
changes. Re-ingest changed files and run the worker again; immutable source
versions preserve the evidence for each analyzed version.

Status distinguishes raw running jobs from workers with unexpired leases and
reports deterministic/enriched/unknown completion modes. It also reports
bounded coverage, graph, synthesis, and analytics summaries. A completed
queue does not mean every language/relationship has full analyzer coverage.

```bash
ariadne knowledge queue list <project-id>
ariadne knowledge queue show <job-id>
ariadne knowledge queue retry <job-id>
ariadne knowledge queue cancel <job-id>
```

Inspect the failure before retrying and fix its cause. A cancelled job is not
a successful analysis. Low-level `queue claim` is for debugging; normal use
is ingestion followed by worker processing. See
[knowledge-worker.md](knowledge-worker.md) for leases and failure codes.

#### Search, graph, and reviews

```bash
ariadne knowledge search <project-id> "authentication" --mode sources --limit 10
ariadne knowledge search <project-id> "authentication" --mode hybrid --json
ariadne knowledge page show <project-id> <page-id>
ariadne knowledge source show <project-id> <source-id>
ariadne knowledge graph nodes <project-id>
ariadne knowledge graph edges <project-id>
ariadne knowledge graph neighborhood <project-id> <node-id> --max-hops 2
ariadne knowledge graph path <project-id> <from-node-id> <to-node-id>
ariadne knowledge review list <project-id> --status pending
ariadne knowledge review resolve <review-id> accept --actor developer --source cli
```

Modes are `knowledge`, `sources`, `tasks`, `hybrid`, and `read-sources-only`.
The mode named `hybrid` combines knowledge/source/task retrieval; optional
local semantic reranking is a separate core/host setting, not a promise
implied by that mode name. Inspect citations and ambiguity before relying on
a result. Exact spans are available for supported extracted source evidence,
not guaranteed for every page/task hit. Graph evidence is static and scoped;
an inferred or ambiguous edge is not a proven runtime dependency.

Review resolutions require an actor and source for the audit record. Other
supported actions include reject, edit, merge, skip, research, create-task,
and label; the create-task CLI action is spelled `create_task`. Use
`review resolve --help` and supply applicable evidence/comment
options. `review reopen` also requires `--actor` and `--source`.

To connect task memory and durable knowledge:

```bash
ariadne knowledge project-task <task-id> --project <project-id> --trigger checkpoint
ariadne knowledge task-from-insight <insight-id> --project <project-id>
```

Projection is a redacted, deterministic copy with provenance, not a move of
the original task or automatic approval of the resulting knowledge.

Knowledge JSON success/failure envelopes are:

```json
{"ok": true, "data": {}}
```

```json
{"ok": false, "error": {"message": "Explanation of the failure"}}
```

These examples describe the envelope, not every command's data fields.

#### Providers and privacy

Provider capabilities are explicit (`chat`, `analysis`, `generation`,
`embeddings`, `vision`, `transcription`, and `research`). No provider is
contacted by default. Embeddings are optional; search falls back to lexical
ranking. Research and chat require a provider supplied by an integrating
caller. CLI worker provider profiles are implemented, but
`knowledge research` and `knowledge chat send` report a provider-required error
instead of making a network request: adding a worker profile does not wire
those execution paths. MCP queues those requests but does not execute them.

For an already-running, approved local OpenAI-compatible server:

```bash
ariadne knowledge provider add <project-id> local \
  --kind openai-compatible --endpoint http://127.0.0.1:8000/v1 \
  --model local-model --capabilities analysis,generation --api-key-env LOCAL_MODEL_API_KEY
ariadne knowledge provider list <project-id>
ariadne knowledge provider test <project-id> local
ariadne knowledge provider enable <project-id> local
ariadne knowledge worker run <project-id> --once
ariadne knowledge provider disable <project-id> local
ariadne knowledge provider remove <project-id> local
```

Replace the endpoint/model with your local server's actual values; this
example does not start a model server. Configure the environment variable
through your approved secret mechanism, never a literal key in a command,
document, or project file. Omit `--api-key-env` if your local server needs no
key. Provider test/enrichment are explicit network-capable operations.
Supported literal loopback HTTP hosts are `127.0.0.1` and `[::1]`; public
named hosts fail closed without reviewed pinned-transport integration.
Provider errors leave deterministic worker success intact with warnings.

Conversation metadata/history operations work without a provider:

```bash
ariadne knowledge chat create <project-id> --title "Architecture notes"
ariadne knowledge chat list <project-id>
ariadne knowledge chat history <project-id> <conversation-id>
```

Grounded answer synthesis, semantic summaries, freshness watching, graph
completeness reporting, analytics, and document/media adapters exist in the
core, but are not all exposed as complete end-user workflows. See the
[feature availability matrix](FEATURES.md#6-interface-availability).

Knowledge operations remain workspace-scoped. Common secret-shaped values are
redacted before provider/persistence boundaries, sensitive-looking projected
paths are suppressed, archive checksums are validated, and provider
configuration payloads are omitted from exports. Review content before sharing:
pattern-based redaction cannot identify every secret.

#### Graphify and Obsidian

Graphify is still a separate installed tool. Ariadne's `graphify` command and
MCP tool pass through to the real binary:

```bash
uv tool install graphifyy
ariadne graphify update .
ariadne graphify query "how does authentication work"
ariadne knowledge graph import-graphify <project-id> graphify.json
```

Export a project as portable Markdown, optionally with minimal Obsidian vault
configuration:

```bash
ariadne knowledge export <project-id> knowledge-vault --obsidian
ariadne knowledge import <project-id> knowledge-vault
```

Exports include a manifest, project/table JSON, rendered pages with
Obsidian-compatible wiki links, and `graph.json`. Import is transactional and
requires the CLI `<project-id>` to exactly match the manifest project id.
It rejects unsafe paths, missing files, size/checksum mismatches, malformed
archive structure, and duplicate project ids unless `--replace` is supplied.
Back up before replacement. Archive versions 1 and 2 are supported; host-local
settings, provider configuration, and derived indexes/models are not portable.
Import prints warnings about required derived-data rebuilds. Those rebuild
services are core integration APIs, not a dedicated CLI rebuild command.
This is a one-way archive/export:
live Obsidian sync, automatic vault watching, and conflict resolution are not
implemented. See [`knowledge-migration.md`](knowledge-migration.md) for the
archive contract and transfer procedure.

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
`get_context`, `git_sync`, `export_task`, and cloud sync tools `sync_push`,
`sync_pull`, `sync_list_remote`, `sync_profile_list` — see
[`packages/mcp-server/README.md`](../packages/mcp-server/README.md) for the
full reference and exact input shapes. The sync tools shell out to the
`ariadne` CLI (which must be installed and on `PATH`, and already logged in
via `ariadne sync login` — the MCP server never handles credentials itself).
In practice, you'd typically start a
conversation with something like *"check my current Ariadne task before we
start"* — the assistant calls `get_context` and picks up right where a
previous session left off, even if that previous session was in a
completely different tool.

For local knowledge processing, use `knowledge_project_*`, source/page/search/
graph/review tools, `knowledge_worker_status`, and
`knowledge_worker_run_once`. Knowledge writes require `confirm=true`;
run-once drains only the selected project's queue. Reads have result bounds.
The worker tool does not expose the CLI's concurrency/profile management.

Important: MCP `knowledge_export` writes a manifest and `knowledge_import`
validates/reads one. They do not perform the CLI's full archive transfer.
Use the CLI for portable export/import. MCP resources also provide project,
page, queue, and review reads alongside task-context resources.

## 7. Using the VS Code extension + Copilot Chat

For task work without chat, run **Ariadne: Open Panel**, click the Activity
Bar launcher, or click the status bar item. Choose a workspace folder first
in a multi-root window.

| Panel tab | Everyday use |
| --- | --- |
| Overview | Select/edit/create tasks; use feature, bugfix, review, research, or incident templates; export task memory. |
| Activity | Check passive-capture health, branch alignment, and recorded activity. |
| Context | Preview the token-budgeted handoff; copy it or open Markdown. |
| Review | Inspect advisory completion-readiness checks and follow blockers. |
| Todos / Decisions / Errors / Questions | Maintain structured task memory. |
| Files | Filter captures/diffs and open the corresponding files. |
| Search | Search local/all-workspace task memory and navigate evidence. |
| Graphify | Invoke the installed external graph tool through the extension host. |
| Sync | Inspect profiles, push/pull, or browse remote tasks through the installed CLI. |

**Knowledge worker:** create/ingest the project via CLI, then use **Ariadne:
Run Knowledge Worker Once**. The extension selects an active project scoped
to the workspace, prompts for confirmation, drains it, and reports counts
and warnings. If multiple active projects share a workspace, use the CLI
with an explicit project ID when you need precise selection.

Other knowledge palette entries are present but the current standalone
panel dispatcher does not implement the corresponding knowledge actions.
Do not interpret **Rebuild Knowledge Workspace** as a working full rebuild;
use the supported CLI/MCP operations instead.

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
  Folder** matters if you have a multi-root workspace open. Cloud sync is
  also available from the palette without opening a terminal: **Ariadne:
  Sync Push**, **Ariadne: Sync Pull** (prompts whether to also import
  tasks this workspace has never linked), and **Ariadne: Sync List
  Remote** — all shell out to the `ariadne` CLI (must be installed, on
  `PATH`, and already logged in via `ariadne sync login`) and stream
  output to the "Ariadne" output channel. Login/register/logout stay
  CLI-only since they handle credentials.

A **status bar item** always shows the current task's title (or "no task"
if none is set yet for this workspace); click it to open the panel or start
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
you or your team — there's no Ariadne-hosted cloud). Each deployment has
one shared team: the first account becomes the admin, later accounts join as
members, and access stays within that team. This is entirely opt-in: nothing
leaves your machine unless you explicitly run `ariadne sync` commands.

```bash
ariadne sync setup [username]                  # project-configured SSH tunnel + login
ariadne sync setup [username] --register       # first account creation only
ariadne sync push                       # push local task/checkpoint changes
ariadne sync pull                       # pull changes made by teammates / other machines
ariadne sync list-remote                # browse every task on the server, including ones never linked here
ariadne sync unlink <taskId>            # clear a task's link to the sync server, locally only
ariadne sync logout                     # forget the locally-stored token
```

What to know:
- **Project-configured secure setup:** `ariadne init` creates
  `.github/ariadne-sync.json`. On each machine, `ariadne sync setup
  [username]` reads it, verifies/installs a key for the configured SSH host,
  checks the scanned host key against its pinned fingerprint, opens an owned
  loopback-only SSH ControlMaster tunnel, securely prompts for the Ariadne
  password, and stores the resulting profile. It never stores the SSH
  password. `push`, `pull`, and `list-remote` automatically restart a stopped
  tunnel and reject a local port occupied by an unrelated process.
  Use `--register` only when creating the cloud account for the first time;
  that first account becomes the singleton admin and later registrations join
  as members.
- **Scope:** `tasks`, `checkpoints`, `todos`, `decisions`, `errors`, `open
  questions`, and `commands` all sync inside the singleton team.
  `files`/`commits` stay local-only — they're git/workspace-derived, not
  curated text content. Eligible snapshots/diffs have a separate encrypted
  file-capture upload/history path; ordinary touched-file and commit records
  are not a repository synchronization mechanism. Knowledge projects,
  sources, pages, and graphs do not move through task sync.
- **`push`** sends every task that's new or changed since it was last
  synced (or just `--task <id>`), then pushes any not-yet-synced
  checkpoints/todos/decisions/errors/open questions/commands for those
  tasks. The server assigns each a permanent id, stored locally as that
  row's `remote_id`. Each push also sends a `workspaceLabel` (e.g.
  `laptop1:org/atom` — hostname + git remote/folder name), so the server
  (and teammates) can tell which machine/repo something came from, not
  just which user account pushed it — every sub-entity records its own
  `owner`/`workspaceLabel` independent of its parent task's, since a
  teammate can add content to a task they didn't originate.
- **Todos, decisions, errors, open questions, and commands sync
  bidirectionally**, just like tasks: edits or state changes made after the
  first push are detected and re-pushed on the next `sync push`.
- **`pull`** applies remote changes to tasks *already linked* to this
  workspace (i.e., ones pushed from here before) and downloads any new
  checkpoints for them. By default it does not fabricate brand-new local
  tasks for ones pushed from a workspace you've never linked here — you'll
  see a list of "skipped" remote workspace labels in that case. Pass
  `ariadne sync pull --import-new` to instead create a local task for each
  of those (already linked via `remote_id`, using the server's own
  timestamps), including pulling in their existing checkpoints and other
  sub-entities.
  `--import-new` does a full browse of every remote task (not just ones
  changed since your last pull), so it always finds and imports anything
  you've never linked here, even if a plain `pull` already saw and skipped
  it earlier.
- **`list-remote`** is browse-only: it lists *every* task on the server
  (owner + workspace label + status), including ones from workspaces
  you've never linked, without creating or changing anything locally. Use
  this to see what's out there *before* deciding whether to `pull
  --import-new` it. In other words, it only browses the singleton team's
  shared data; it never crosses into another team's space.
- **`unlink <taskId>`** clears that task's `remote_id`/`synced_at` locally
  only — it never contacts the server, so the server-side row (if any) is
  left exactly as it was. Use it to undo an accidental `--import-new`, or
  to detach a task from sync entirely; a later `push` will treat the task
  as brand-new and create a fresh remote row.
- **Access is shared within the team:** active members of the singleton
  team can read/write any synced task — there's no per-task ACL or org
  hierarchy. Treat the server as a shared, trusted team space, not a
  permissions boundary. Inaccessible tasks are hidden with `404` rather
  than exposed cross-team.
- **Conflict handling is visible, with a flag to control it:** if a task
  or todo was edited both locally and on the server since the last sync,
  `sync pull` detects the differing field(s), prints a warning
  (`⚠ Conflict on task/todo <id>: field "<name>" differs...`), and then
  resolves it — `remote-wins` by default (the server's value is kept
  locally), or `local-wins` if you pass `--on-conflict local-wins` (your
  local value is kept and will be re-pushed on the next `sync push`).
  The same whole-row conflict policy applies to every mutable,
  bidirectionally synced entity.
- **No delete propagation (by design):** archiving a task *does* sync
  normally (`status` is just a synced field), but hard-deleting anything
  locally — a task, or a decision/error/open question via the curation
  delete commands — never removes it from the server; there's no delete
  endpoint at all. This was a deliberate choice to keep sync additive-only
  and conflict-free, not a gap to be filled later without its own design
  pass.
- **Multiple profiles:** one machine can stay logged into more than one
  sync server/team via named profiles (e.g. a "work" server and a
  "personal" one). `sync login`/`sync register` take an optional
  `--profile <name>` (default: `"default"`) and make that profile
  *current*; every other `sync` command accepts `--profile <name>` to
  target a specific profile for just that one call without changing which
  profile is current. `ariadne sync profile list` shows what's configured
  (marking the current one with `*`), and `ariadne sync profile use <name>`
  switches the current profile persistently. Configs from before profiles
  existed (a bare `serverUrl`/`token`/`username` at the top level of
  `sync-config.json`) are read transparently as an implicit `"default"`
  profile — no manual migration needed.
- **Admin routes use a browser session, not the sync token:** the
  `/api/v1/admin/*` dashboard routes authenticate with an `HttpOnly`
  session cookie obtained from `POST /api/v1/admin/session`, require a CSRF
  token and the configured `ADMIN_PUBLIC_ORIGIN` on every state change, and
  reject the sync bearer JWT outright. The sync CLI is unaffected.
- **Operations dashboard:** after the configured nodem2 tunnel is active, open
  `http://127.0.0.1:14300/admin`. The operations console and its
  current reauthentication/exact-confirmation rules are documented in
  [§9.1 Operations console](#91-operations-console). Knowledge navigation is
  discussed there separately from implemented operations routes.
- The JWT and profile metadata are stored locally at
  `~/.ariadne/sync-config.json` with owner-only (`0600`) permissions.

For deployments without the project-configured setup flow, the CLI also has
`sync login` and `sync register` with username/password positional arguments.
Those arguments can appear in shell history/process listings; prefer secure
`sync setup` where configured and never paste credentials into shared
commands or documentation.

See [`docs/06-CLOUD-SYNC-DESIGN.md`](06-CLOUD-SYNC-DESIGN.md) for the
product decisions behind this, [`docs/07-CLOUD-SYNC-API-CONTRACT.md`](07-CLOUD-SYNC-API-CONTRACT.md)
for the schema/API contract, and
[`packages/sync-server/README.md`](../packages/sync-server/README.md) for
running your own server.

## 9.1 Operations console

The self-hosted deployment has one administrator account and team members.
Members can access the Tasks view; administration sections require the admin.
After the project tunnel is running, open `http://127.0.0.1:14300/admin`;
do not publish that
loopback URL or replace it with a direct server address. The dashboard uses
its own browser session and CSRF token, not the token used by `ariadne sync`.

| Section | Use it for |
| --- | --- |
| **Overview** | Database, host, service, sync, task, member, backup, and operation summaries. An unavailable operator is shown as unavailable; it is not reported healthy. |
| **Members** | Review membership and activate or deactivate non-admin members. The singleton admin cannot be changed through the network API. |
| **Tasks** | Inspect the timeline and encrypted capture metadata, then view a selected snapshot or diff. Deleting a capture is guarded and records immutable file-history audit data. |
| **Backups** | Create and verify backups, download only a verified artifact, and explain restore eligibility. A backup must be currently verified before it can be restored. |
| **Services** | Inspect `sync-server`, `operator`, and PostgreSQL. Only `sync-server` and PostgreSQL can be restarted; the operator is deliberately outside browser restart control. |
| **Deployments** | Inspect the current revision, rollback target, schema version, and trusted candidate SHAs. Deploy only a listed candidate and roll back only to the recorded target. |
| **Logs** | Read paginated, redacted entries from only `sync-server`, `operator`, `deployment`, or `backup`, filtered by severity and time. |
| **Audit** | Review append-only authentication, membership, file-history, backup, service, deployment, and restore events, including related operation IDs. |

The frontend also includes admin-only **Knowledge**, **Search**, and
**Reviews** pages. Their standalone sync-server knowledge endpoints are not
mounted in the current implementation. A visible navigation entry is not
proof of an operational server knowledge workspace, and local knowledge is
not automatically uploaded by sync. Use CLI/MCP for local knowledge; do not
repeatedly retry a missing dashboard endpoint as if authentication were the
only issue.

### Guarded changes

All privileged mutations, including member changes, backup creation and
verification, service restart, deployment, rollback, restore, and file-capture
deletion, require a password reauthentication no more than five minutes old.
Exact phrases are additionally required for `ACTIVATE`/`DEACTIVATE` member,
`DELETE` capture, `RESTORE` backup, `RESTART` service, `DEPLOY`, and
`ROLLBACK`. Backup creation and verification do not require an exact phrase.
The server enforces these rules, so client-side controls are not a substitute.

Wait for the operation's terminal `succeeded` or `failed` state and inspect
the linked audit record after refresh or reconnect. Before restore, deploy,
or rollback, the tracked workflow creates and verifies a fresh safety backup;
restore additionally requires the selected recorded backup to be verified.
Failed workflows retain their diagnostics and safety backup instead of
reporting success.

Use the console or the tracked scripts named in
[`deploy/nodem2/README.md`](../deploy/nodem2/README.md). Do not request
arbitrary commands, Docker socket access, service names, paths, journal
expressions, or Git revisions: none is accepted by the web tier. Retrieve
credentials only through the secure prompt or root-owned deployment files,
and rotate them with the documented procedure. Never paste or display a
password, secret, token, or private key in a terminal transcript, issue,
chat, generated guidance, or documentation.

## 10. Data & privacy

- Local task/knowledge records live at `<workspace-root>/.ariadne/state.db`
  (per-workspace) and `~/.ariadne/registry.db` (a cross-workspace index).
  Immutable source content and page artifacts also live under
  `.ariadne/knowledge/`. Offline task and baseline knowledge operations do
  not require a network. Explicit sync/setup, approved provider requests,
  and external tool/install operations can contact remote services.
- `.ariadne/` is gitignored by default — task state doesn't get committed or
  pushed unless you explicitly export it.
- `ariadne export` (or `export_task`/the chat participant) creates a task
  Markdown projection. Backups, approved sync, capture uploads, and knowledge
  projection/export are additional explicit data-copy boundaries.
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

These CLI backups copy database files, not the entire knowledge content
directory. Stop writers and ensure SQLite has no uncheckpointed WAL data
before relying on a filesystem database copy; preserve the associated
`.ariadne/knowledge/` files separately or use a validated project archive.
Restore deliberately replaces the selected database, so inspect the snapshot
and retain current content/DB backups first. Local SQLite and source files are
not automatically encrypted by the server's encrypted-capture feature.

## 11. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `No task specified and no current task set` | Run `ariadne task new <title>` first, or pass `--task <id>` explicitly. |
| `@ariadne` doesn't respond in Copilot Chat | Confirm the extension is installed/enabled and a folder is open — Ariadne needs a workspace to find or create `.ariadne/state.db`. Check the "Ariadne" output channel for errors. |
| A task from another workspace isn't found via `--task <id>` | The other workspace must have been opened by *some* Ariadne surface at least once since the registry was introduced, so it gets registered. Open it once (any command) to backfill it. |
| MCP client can't see any tools | Verify the `command`/`args`/`cwd` in your MCP client config point at a built `packages/mcp-server/dist/index.js` and a real project directory. |
| Multi-root VS Code workspace acts on the "wrong" folder | Run **Ariadne: Select Workspace Folder** to pin which folder Ariadne should track. |
| `Not logged in to a sync server` on `ariadne sync push`/`pull` | Use configured `ariadne sync setup [username]`; add `--register` only for account creation. Check the current profile. |
| `ariadne sync push` says a checkpoint wasn't pushed | Checkpoints can't be pushed until their parent task has a `remote_id` — push happens task-first, automatically, within the same `sync push` call; if the task push itself failed (check the error), fix that first. |
| Worker run completes but expected evidence is missing | Inspect source versions, queued/failed jobs, analyzer coverage, and citations. Unsupported/partial analysis is not full language coverage. |
| `provider_required` from research or chat send | CLI provider profiles only enable the worker integration; these execution commands still need an integrating provider surface. |
| Provider endpoint rejected | Use the supported exact loopback origin for a local server. Do not bypass public-host transport checks. |
| Import rejects a project ID or checksum | Use the manifest's exact project ID and an intact compatible export. Do not edit identity/checksum fields to bypass validation. |
| Imported project reports rebuild warnings | Derived index/model data is omitted intentionally. Use the documented core rebuild integration; there is no dedicated CLI rebuild command. |
| Dashboard Knowledge/Search/Reviews fails to load | Standalone knowledge routes are not mounted. Use local CLI/MCP; task sync does not publish knowledge data. |
| VS Code knowledge palette action opens a panel but does not act | Some knowledge actions are placeholders. The confirmed worker run-once command works; use CLI/MCP for the rest. |
| Want to retire old work | Archive tasks or forget a registry entry. Back up before any deliberate database replacement; do not delete `.ariadne/` as routine troubleshooting. |

## 12. Project status

Early / pre-release. The core CLI/MCP/VS Code trio is built for a single
developer working across one or more workspaces on one machine; cloud sync
(§9) is an optional, opt-in add-on (tasks, checkpoints, todos, decisions,
errors, open questions, and commands all sync) for teams that want to
share state across machines/people via a self-hosted server. See the main
[README](../README.md) and
[`docs/04-ROADMAP.md`](04-ROADMAP.md) for what's shipped vs. deferred.

The offline knowledge worker, worker concurrency, provider profile management,
search/citations, native graph, reviews, and CLI archives are implemented.
Core-only integration services and incomplete VS Code/browser knowledge
surfaces are identified in [FEATURES.md](FEATURES.md). Public-dataset accuracy
and arbitrary-codebase completeness must not be inferred from the small
[synthetic baseline](benchmarks/knowledge-baseline-v1.md).
