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
│                       │ PluginRegistry │ Redactor                  │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │                               │
     ┌──────────▼───────────┐        ┌──────────▼───────────┐
     │ @ariadne/mcp-server  │        │  @ariadne/cli        │
     │ stdio/SSE MCP server   │        │  `ariadne` binary     │
     │ tools: task.*          │        │  start/checkpoint/      │
     │ resources: context     │        │  resume/status/search   │
     └──────────┬─────────────┘        └──────────┬───────────┘
                │                                 │
     ┌──────────▼──────────────────────────────────▼───────────┐
     │              @ariadne/vscode-extension                 │
     │  - spawns/registers MCP server for Copilot Chat           │
     │  - registers `@ariadne` chat participant (wraps CLI/MCP)│
     │  - background listeners → feed core (file/git/terminal)   │
     │  - optional thin tree view (secondary, v1.1+)              │
     └────────────────────────────────────────────────────────────┘
                │
     Any MCP-capable client (Copilot CLI, Claude Code, Cursor,
     custom agents) connects to the same MCP server directly —
     no VS Code required for the CLI + MCP path.
```

## 3. Why MCP Is the Integration Backbone
- MCP is already the emerging standard for "expose tools/resources to any AI client."
  It gives us model-agnosticism for free instead of writing bespoke adapters per
  assistant.
- Copilot Chat, Copilot CLI, and Claude Code can all attach to the same local MCP
  server. One implementation, three+ front doors.
- The chat participant (`@ariadne` in Copilot Chat) is a **wrapper**, not a
  reimplementation: it calls the same MCP tools a CLI or external agent would call.

## 4. Process Model
- **Core** runs as a **local daemon** (long-lived process) per workspace, owning the
  SQLite connection (avoids multi-writer contention). Started lazily on first use by
  either the VS Code extension or the CLI; whichever starts first wins, others attach
  via a local IPC/unix socket (or named pipe on Windows).
- **MCP server** is a thin process wrapping the daemon's IPC client — this is what
  Copilot Chat/CLI actually spawn/connect to per the MCP client contract (typically
  stdio).
- If no daemon is running, the CLI/MCP server auto-starts one and exits it after an
  idle timeout (keeps footprint low when not in use).

## 5. Component Responsibilities

| Component | Responsibility |
|---|---|
| `TaskStore` | CRUD over SQLite: tasks, checkpoints, files, commits, decisions, todos, errors, commands |
| `ContextBuilder` | Ranks + assembles context package under a token budget (see PRD/data-model) |
| `CheckpointEngine` | Rule-based, event-triggered summarization + hierarchical rollup |
| `GitWatcher` | Watches `.git/HEAD`, commits; links commits ↔ checkpoints; detects branch switches |
| `Redactor` | Strips likely secrets (env vars, tokens, key patterns) from captured terminal output *before* persistence |
| `PluginRegistry` | Loads plugins (Jira, Slack, etc.) that contribute context sources or MCP tools |
| `mcp-server` | Exposes `task.*` tools/resources over MCP to any client |
| `cli` | Human-typable commands; also callable by non-MCP agents via shell |
| `vscode-extension` | Registers chat participant, background capture listeners, lazy daemon bootstrap, optional tree view |

## 6. Background Capture (Passive, No Prompts)
The VS Code extension subscribes to:
- `workspace.onDidSaveTextDocument` → file touched
- Git extension API / `.git` FS watch → commits, branch switches
- `window.onDidWriteTerminalData` / shell integration API → command + exit code capture
  (through `Redactor` before storage)
- `languages.onDidChangeDiagnostics` → error/build-failure capture
- Copilot Chat participant turn completion (if available) → optional AI-turn summary
  hook for the checkpoint engine

All of this writes to the core daemon via IPC — never blocks the editor, never
prompts the user.

## 7. Sequence: Resuming a Task in a New Chat

```
Developer            Copilot Chat        @ariadne participant   MCP server   Core
    │  "@ariadne resume"  │                    │                  │           │
    ├──────────────────────►│                    │                  │           │
    │                       ├───────────────────►│                  │           │
    │                       │                    ├── task.getContext(budget) ──►│
    │                       │                    │                  ├──────────►│ ContextBuilder
    │                       │                    │                  │◄──────────┤ ranked package
    │                       │                    │◄─────────────────┤           │
    │                       │◄── context msg ────┤                  │           │
    │◄── injected context ──┤                    │                  │           │
```

The same sequence works with **Copilot CLI** substituting for "Copilot Chat" — CLI
calls the MCP server (or shells to `ariadne context`) directly, no VS Code needed.

## 8. Storage & Deployment Model
- SQLite file: `.ariadne/state.db` (per workspace), **gitignored by default**
  (locked decision — private by default, since it may capture terminal
  output/decisions not meant for the repo).
- Optional Markdown export: `ariadne export` writes `.ariadne/export/<task>.md`
  — opt-in, safe to commit if a team wants shared task history.
- No cloud dependency in MVP. Sync/cloud is a stretch-goal plugin (see roadmap).

## 9. Failure Modes & Resilience
- Daemon crash → next CLI/MCP call auto-restarts it; SQLite WAL mode ensures no
  corruption from abrupt termination.
- Redactor false negatives (secret leak) — mitigated by keeping storage local-only by
  default and never transmitting raw terminal output as part of context without
  passing through redaction first.
- MCP client incompatibility — CLI must remain a fully functional fallback so the
  product works even where MCP isn't yet supported by a given assistant.

## 10. Open Architecture Questions
- Daemon lifecycle: fixed idle-timeout vs. explicit `ariadne stop`? (lean: idle
  timeout + explicit stop both available)
- IPC transport: unix domain socket vs named pipe vs local TCP loopback — needs a
  cross-platform decision before CLI implementation starts.
- Should the MCP server be spawned per-client-request (stateless) or be the same
  long-lived daemon-attached process shared across clients? (leaning: shared, for
  consistent state across Copilot Chat + CLI in the same workspace)
