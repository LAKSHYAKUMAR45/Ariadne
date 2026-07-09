# @ariadne/mcp-server

An MCP ([Model Context Protocol](https://modelcontextprotocol.io/)) server that
exposes Ariadne's task state as tools to **any** MCP-capable AI client —
Claude Code, Gemini CLI, Codex, Copilot Chat/CLI, or a custom agent — without
needing VS Code. It's one of three thin surfaces over the shared
`@ariadne/core` `TaskStore`; the CLI and VS Code extension read/write the
exact same `.ariadne/state.db`, so state is identical no matter which surface
you use.

## Running it

Any MCP client that can spawn a local process over stdio can use this
server. Point your client's MCP config at:

```bash
node packages/mcp-server/dist/index.js
```

or, once published, at the `ariadne-mcp-server` binary. The server resolves
the workspace root the same way the CLI does (nearest ancestor directory
containing `.git` or `.ariadne`, starting from the client's working
directory), and reads/writes `<workspace-root>/.ariadne/state.db`.

## Tools

| Tool | What it does |
|---|---|
| `task_new` | Creates a new task and marks it current. |
| `task_list` | Lists tasks, optionally filtered by status. Pass `allWorkspaces: true` to list tasks from every workspace Ariadne has ever seen, each tagged with its `workspaceRoot`. |
| `task_use` | Switches the current task (always scoped to this workspace — "current task" is a per-workspace concept). |
| `task_pause` / `task_done` / `task_archive` / `task_reopen` | Change the current (or given) task's lifecycle status. |
| `task_edit` | Edits the current (or given) task's title and/or goal (curation). Leaves either unchanged if not supplied. |
| `checkpoint_add` | Records a checkpoint summary. |
| `todo_add` / `todo_list` / `todo_done` / `todo_reopen` / `todo_block` / `todo_edit` / `todo_delete` | Manage todos, including curation (edit/delete) and reopening/blocking. All id-based ones accept an optional `taskId` if the todo belongs to a different workspace than the current one (needed because the cross-workspace registry indexes tasks, not sub-entity ids). |
| `decision_add` / `decision_list` / `decision_edit` / `decision_delete` | Record, list, edit, or delete a decision (with optional rationale). |
| `error_add` / `error_resolve` / `error_reopen` / `error_edit` / `error_delete` | Record, resolve, reopen, edit, or delete an error. Id-based ones accept an optional `taskId` the same way `todo_done` does. |
| `question_add` / `question_list` / `question_resolve` / `question_reopen` / `question_edit` / `question_delete` | Record, list, resolve, reopen, edit, or delete an open question blocking the task. Id-based ones accept an optional `taskId` the same way `todo_done` does. |
| `search` | Cross-entity search over task titles/goals, checkpoints, decisions, todos, errors, open questions, files, and commits — returns tasks ranked by match count, each with its matching entities. Pass `allWorkspaces: true` to search every known workspace, with each result tagged by its `workspaceRoot`. |
| `get_context` | Returns the current (or given) task's full context — goal, latest checkpoint, open questions, unresolved errors, blocked todos, pending todos, recent files, commits, commands, and decisions — as structured JSON, ranked and trimmed to fit an optional `tokenBudget` (default 2000). Equivalent to the CLI's `status`/`resume`. |
| `git_sync` | Syncs the current git branch and any new commits into the current (or given) task by shelling out to `git` directly — works without any editor's git integration open. Equivalent to the CLI's `git-sync`. |
| `export_task` | Renders the current (or given) task's full history as a Markdown document (text in the response) — for sharing or pasting into a PR description. Equivalent to the CLI's `export` (which additionally writes the file to `.ariadne/export/<task-id>.md`). |

All tools that need a task default to the workspace's "current task" (the
same one `ariadne task use` sets) when no explicit `taskId` is given.

### Cross-workspace task resolution

Every tool that accepts a `taskId` (`task_pause`/`done`/`archive`/`reopen`,
`checkpoint_add`, `todo_add`/`list`, `decision_add`, `error_add`,
`question_add`/`list`, `get_context`, `git_sync`, `export_task`) will
transparently operate on that task even if it doesn't belong to this
server's workspace: it falls back to the global cross-workspace registry
(`~/.ariadne/registry.db`, maintained automatically as any surface uses
Ariadne) to find and open the real owning workspace's `state.db`. Nothing
is copied between workspaces — each workspace's own database stays the
source of truth for its own tasks; the registry is just an index that
saves the caller from having to know or guess which workspace a task id
lives in.

## Resources

In addition to tools, the server exposes the same `get_context` output as
read-only, URI-addressable **resources** — useful for MCP hosts that
auto-attach subscribed/discoverable resources to a conversation without
requiring the model to make an explicit tool call:

| Resource URI | What it returns |
|---|---|
| `ariadne://task/current/context` | The current task's context package (same shape as `get_context` with no `taskId`). |
| `ariadne://task/{taskId}/context` | A specific task's context package. Supports resource listing so clients can discover one entry per existing task. |

## Development

```bash
pnpm --filter @ariadne/core build   # @ariadne/core must be built first
pnpm --filter @ariadne/mcp-server build
pnpm --filter @ariadne/mcp-server test
```

`src/tools.ts` holds pure, transport-agnostic implementations of every tool
(directly unit-testable without spinning up the MCP SDK); `src/server.ts`
wires those into `McpServer` with Zod input schemas and registers the
resources described above; `src/index.ts` is the stdio entry point.

## Known limitations (early/pre-release)

- Not yet published to npm.
