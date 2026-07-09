# Ariadne — System Architecture (Draft v0.1)

## 1. Guiding Constraint
Every surface (VS Code extension, CLI, Copilot Chat participant, any future MCP
client) must share **one** core implementation. No logic is duplicated per client —
each surface is a thin adapter over `@ariadne/core`.

## 2. High-Level Diagram

```
┌───────────────────────────────────────────────────────────────────┐
│                        @ariadne/core (library)                   │
│  TaskStore (SQLite) │ ContextBuilder │ CheckpointEngine │ GitWatcher│
│                       │ Redactor │ Exporter                        │
│                       │ (PluginRegistry — deferred, post-MVP)      │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │                               │
     ┌──────────▼───────────┐        ┌──────────▼───────────┐
     │ @ariadne/mcp-server  │        │  @ariadne/cli        │
     │ stdio MCP server        │        │  `ariadne` binary     │
     │ tools: task.*, get_context, │        │  task/checkpoint/todo/  │
     │ git_sync, export_task       │        │  status/resume/git-sync/│
     │ resources: ariadne://task/  │        │  export                 │
     │ {current,<id>}/context       │        │                          │
     └──────────┬─────────────┘        └──────────┬───────────┘
                │                                 │
     ┌──────────▼──────────────────────────────────▼───────────┐
     │              @ariadne/vscode-extension                 │
     │  - registers `@ariadne` chat participant (commands.ts)    │
     │  - background listeners → write directly to @ariadne/core │
     │    (file saves, terminal commands, git commits, diagnostics)│
     │  - optional thin tree view (secondary, v1.1+)              │
     └────────────────────────────────────────────────────────────┘
                │
     Any MCP-capable client (Copilot CLI, Claude Code, Cursor,
     custom agents) connects to `@ariadne/mcp-server` directly —
     no VS Code required for the CLI + MCP path.
```

Each of the three surfaces above opens its own connection directly to
`.ariadne/state.db` via `@ariadne/core`'s `TaskStore` (no daemon, no IPC — see
§4). They agree on shared state purely because they all read/write the same
SQLite file using the same shared library.

## 3. Why MCP Is the Integration Backbone
- MCP is already the emerging standard for "expose tools/resources to any AI client."
  It gives us model-agnosticism for free instead of writing bespoke adapters per
  assistant.
- Copilot Chat, Copilot CLI, and Claude Code can all attach to the same local MCP
  server. One implementation, three+ front doors.
- `@ariadne/mcp-server` exposes both **tools** (explicit, invoked by name —
  `task_new`, `get_context`, `search`, etc.) and **resources** (URI-addressable,
  discoverable/subscribable reads — `ariadne://task/current/context` and the
  templated `ariadne://task/{taskId}/context`). Both routes return the same
  `ContextPackage` from `@ariadne/core`'s `ContextBuilder`; resources exist
  because some MCP hosts auto-attach subscribed resources to a conversation
  without requiring the model to explicitly call a tool, which is a strictly
  better UX for "give me the current task's context" than a tool call.
- The chat participant (`@ariadne` in Copilot Chat) currently reimplements its
  `/status`/`/resume` output directly against `@ariadne/core` (see
  `packages/vscode-extension/src/commands.ts`) rather than calling into
  `@ariadne/mcp-server`, since running an MCP client from inside the extension
  isn't wired up yet. Tracked as a known gap (see `ext-chat-participant-shared-context`
  in the roadmap) — the intent is still for it to become a thin wrapper over the
  exact same `buildContext`/tool logic the CLI and MCP server already share, just
  without an extra MCP hop for something running in-process.

## 4. Process Model (as shipped — no daemon)
**Locked MVP decision, superseding the daemon/IPC design originally sketched
here:** there is no long-lived daemon and no IPC transport. Every process — the
CLI (one process per invocation), the MCP server (one process per client
session), and the VS Code extension (one process per editor window) — opens
its own `better-sqlite3` connection straight to `.ariadne/state.db` via
`@ariadne/core`'s `TaskStore`/`openWorkspaceStore()`.

This works safely today because:
- SQLite is opened in **WAL mode** (`packages/core/src/db.ts`), which allows
  multiple readers plus one writer concurrently without corrupting the file.
- All writes are single statements per `TaskStore` method (no long-held
  transactions spanning a user interaction), keeping writer contention windows
  short.
- `packages/core/test/concurrency.test.ts` exercises two connections
  interleaving writes against the same file and reopening after a close, as a
  regression test for this assumption.

**Why no daemon for v1:** the target user is a single developer working in one
workspace at a time. A background daemon (with its own lifecycle, IPC
transport choice, crash recovery, and idle-timeout policy — all previously
open questions here) is real operational complexity that direct-SQLite-access
avoids entirely for that use case. It's revisited only if a real bottleneck
shows up (e.g., very high-frequency passive-capture writes racing a large
`ariadne export`, or eventual multi-workspace/team scenarios) — see
`04-ROADMAP.md`'s deferred/stretch section.

**Current-task state** (which task is "current" for a workspace, so commands
without an explicit `--task` know what to act on) also lives in `state.db`
(the `schema_meta` table), not a side file — see `packages/core/src/workspace.ts`.
This was previously a separate flat file; moving it into the same DB removed
one more place surfaces could drift out of sync with each other.

## 5. Component Responsibilities

| Component | Responsibility |
|---|---|
| `TaskStore` | CRUD over SQLite: tasks, checkpoints, files, commits, decisions, todos, errors, commands, open questions, current-task pointer |
| `ContextBuilder` | Ranks + assembles context package under a token budget (see PRD/data-model) |
| `CheckpointEngine` | Rule-based, event-triggered summarization + hierarchical rollup |
| `GitWatcher` | Shells out to `git` to read HEAD/branch/recent commits; used by CLI/MCP server for git capture without an editor. (The VS Code extension uses the built-in `vscode.git` API instead, for better event-driven UX — see §6.) |
| `Redactor` | Strips likely secrets (known token shapes, password/token/secret/api-key assignments) from captured terminal commands *before* persistence |
| `Exporter` | Renders a task's full history to Markdown for `ariadne export` / the MCP `export_task` tool |
| `PluginRegistry` | **Not implemented.** Originally sketched for post-MVP plugins (Jira, Slack, LLM-based summarization backend, etc.) — no code exists yet; listed here only as a future extension point, not a current component. |
| `mcp-server` | Exposes task/checkpoint/todo/decision/error/context/git/export tools over MCP to any client |
| `cli` | Human-typable commands; also callable by non-MCP agents via shell |
| `vscode-extension` | Registers chat participant, background capture listeners, optional tree view |

## 6. Background Capture (Passive, No Prompts)
The VS Code extension subscribes to:
- `workspace.onDidSaveTextDocument` → file touched
- `vscode.git` extension API → commits (branch-switch capture via `GitWatcher`
  is not yet wired into this passive path — tracked separately)
- Terminal shell integration API (`window.onDidEndTerminalShellExecution`) →
  command + exit code capture (through `Redactor` before storage)
- `languages.onDidChangeDiagnostics` → error/build-failure capture, debounced
  per file, with diagnostics that disappear auto-resolving their recorded error
- Copilot Chat participant turn completion (if available) → optional AI-turn
  summary hook for the checkpoint engine — **not implemented yet**

All of this writes directly to the same `TaskStore`/SQLite file the extension
process has open (via a per-workspace-root cache, `storeCache.ts`) — never
through IPC, since there's no daemon to relay to (see §4). It never blocks the
editor and never prompts the user.

## 7. Sequence: Resuming a Task in a New Chat

```
Developer            Copilot Chat        @ariadne participant       @ariadne/core
    │  "@ariadne resume"  │                    │                         │
    ├──────────────────────►│                    │                         │
    │                       ├───────────────────►│                         │
    │                       │                    ├── buildContext(taskId) ►│ ContextBuilder
    │                       │                    │◄────────────────────────┤ ranked package
    │                       │◄── context msg ────┤                         │
    │◄── injected context ──┤                    │                         │
```

Today the chat participant calls `@ariadne/core` in-process (no MCP hop — see
§3's note). The equivalent flow for **Copilot CLI** or any other MCP-capable
client instead calls `@ariadne/mcp-server`'s `get_context` tool, which
delegates to the same `buildContext` under the hood:

```
Developer        Copilot CLI / other MCP client        @ariadne/mcp-server   @ariadne/core
    │ "resume task X" │                                      │                    │
    ├──────────────────►│                                      │                    │
    │                   ├── tools/call get_context ───────────►│                    │
    │                   │                                      ├── buildContext ───►│
    │                   │                                      │◄────────────────────┤
    │                   │◄── ranked context package ───────────┤                    │
    │◄── injected context ──┤                                  │                    │
```

The plain CLI's `ariadne status`/`ariadne resume` commands take the same
`buildContext` path directly, without any client/server hop at all.

## 8. Storage & Deployment Model
- SQLite file: `.ariadne/state.db` (per workspace). **Intended to be
  gitignored by default** (locked decision — private by default, since it may
  capture terminal output/decisions not meant for the repo); as of this
  writing this is not yet auto-enforced by any surface (tracked as
  `core-gitignore-enforcement`) — currently relies on the user gitignoring it
  themselves.
- Optional Markdown export: `ariadne export` writes `.ariadne/export/<task>.md`
  — opt-in, safe to commit if a team wants shared task history.
- No cloud dependency in MVP. Sync/cloud is a stretch-goal plugin (see roadmap).

## 9. Failure Modes & Resilience
- Process crash mid-write → SQLite WAL mode ensures the file itself isn't
  corrupted; at most the in-flight write is lost (no daemon to restart, since
  there isn't one — see §4).
- Redactor false negatives (secret leak) — mitigated by keeping storage
  local-only by default and never transmitting raw terminal output as part of
  context without passing through redaction first.
- MCP client incompatibility — CLI must remain a fully functional fallback so
  the product works even where MCP isn't yet supported by a given assistant.
  (As of this writing the CLI is missing decision/error/search/task-lifecycle
  commands that MCP already exposes — tracked as `cli-parity-commands`.)

## 10. Open Architecture Questions
- Multi-workspace/multi-repo support: today each workspace root gets its own
  independent `.ariadne/state.db`; there's no cross-repo task linking. Revisit
  if/when a real multi-repo use case shows up.
- If passive-capture write volume or `ariadne export`-style long reads ever
  contend meaningfully under WAL mode, reconsider a daemon — but this is
  explicitly **not** a v1 concern given the single-developer, single-workspace
  target user.
- Automatic vs. explicit task detection: the PRD floats auto-detection, but
  shipped behavior is explicit-only (passive capture only ever appends to a
  task the user already started via `task new`/`task use`; it never creates
  or switches one on its own). Revisit alongside first-run UX polish.

