# Ariadne — Product Requirements Document (Draft v0.1)

## 1. Problem Statement
AI coding assistants (Copilot Chat, Copilot CLI, Claude Code, Gemini CLI, Codex, Continue,
Cline, ...) lose context as conversations grow. Developers re-explain goals, decisions,
and state every time they start a new chat or hit a context-window wall. Today the only
"memory" is the chat transcript itself — which is verbose, unstructured, and disposable.

**Reframing per your constraint:** this is not a chat archive tool. It is a
**background context daemon** that anyone's AI assistant can query. It never becomes a
UI you have to visit — it is invoked *from within* the assistant you're already using
(Copilot Chat participant, Copilot CLI command/MCP tool) and answers with structured,
compressed task context.

## 2. Product Vision
> Chats are disposable. Tasks are permanent.

Ariadne tracks **tasks**, not conversations. A task is a durable unit of work (a
feature, bug fix, migration) with its own goal, state, decisions, files, commands, and
open questions — independent of which AI tool or which chat session is being used.

## 3. Non-Goals (important given your constraint)
- **Not a chat UI.** No new panel you must keep open, no dashboard you must check.
  A minimal read-only tree view MAY exist for humans, but it is never required.
- **Not an AI assistant.** Ariadne never talks to a model on its own initiative or
  answers coding questions. It only stores/retrieves/compresses context.
- **Not tied to one vendor.** Copilot is the first-class integration target (CLI +
  Chat), but the storage/context-builder core must be assistant-agnostic (MCP server
  is the generalized interface).
- **Not synchronous/blocking.** All capture (file edits, git activity, terminal output)
  happens via passive background listeners — never a "please pause and let me record
  this" prompt.

## 4. Primary Personas
1. **CLI-first developer** — lives in `copilot` CLI, wants `/task` style commands or
   automatic context injection with zero extra windows.
2. **VS Code + Copilot Chat developer** — invokes Ariadne via a chat participant
   (`@ariadne`) or slash command inside the existing Chat panel; never opens a
   separate UI.
3. **OSS maintainer / power user** — wants to inspect/export the task graph, plug in
   Jira/Linear later, or self-host.

## 5. Core User Stories (MVP)
1. As a developer, when I start work, Ariadne auto-detects or lets me declare a task
   in-line (`@ariadne start "Add OAuth login"`), without leaving chat/CLI.
2. As a developer, while I work, Ariadne silently captures file edits, git diffs/
   commits, terminal commands+exit codes, diagnostics, and periodic AI-turn summaries —
   with no manual action required.
3. As a developer, when my chat gets long or I open a new chat/session, I can say
   `@ariadne resume` (or the assistant proactively calls the MCP tool) and get a
   compact context package injected as the system/context message — instead of
   re-explaining everything.
4. As a developer, I can switch between tasks (`@ariadne switch "Fix flaky test"`)
   and Ariadne keeps them isolated.
5. As a maintainer, I can inspect the underlying task graph/checkpoints as
   human-readable files (for trust/debuggability) even though the primary interface is
   programmatic.

## 6. Success Metrics
- Time-to-productive-context in a new chat (target: <5s to inject vs. minutes of manual
  re-explaining).
- % reduction in tokens sent to model per session start (context builder compression
  ratio).
- Zero required UI interactions for capture (passive-capture coverage %).
- Cross-tool reuse: same task resumed successfully from both Copilot CLI and Copilot
  Chat in a session.

## 7. Constraints Recap (from stakeholder)
- Must be invocable **from within** Copilot CLI and Copilot Chat — not a separate app.
- Must **not** require leaving those surfaces for the core loop (start/update/resume).
- Background-first: capture and summarization run without prompting the user.
- UX (tree views, timelines, dashboards) is explicitly **secondary** — nice-to-have,
  never required for the core value loop.

## 8. Open Product Questions (flag now, decide before MVP lock)
- Q1: Is "task" detection automatic (heuristic: new branch, new file cluster) or
  always explicit (user names it)? Hybrid seems right — needs a decision.
- Q2: Where does Ariadne run for Copilot CLI — as an MCP server the CLI spawns, or a
  standalone daemon the CLI shells out to? (Architecture doc will propose MCP server.)
- Q3: Multi-repo tasks — same task spanning two workspaces? Defer to post-MVP.
- Q4: How much control does the user need over what's captured (privacy: terminal
  output may contain secrets)? Needs redaction strategy before capturing shell output.
