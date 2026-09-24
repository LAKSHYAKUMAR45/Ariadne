# VS Code Extension Webview Rework — Design

## Problem

The `ariadne-vscode` extension (`packages/vscode-extension`) currently exposes
Ariadne only through the `@ariadne` chat participant, a handful of
Command Palette entries, a status bar item, and a read-only sidebar tree
view. All meaningful interaction — completing a todo, recording a decision,
inspecting captured files, running sync — is either markdown text streamed
into Copilot Chat or a modal input box, with no visual surface comparable to
the cloud Operations Console dashboard. The user considers the extension
"useless as of now" relative to what the underlying `@ariadne-dev/core` data
model actually supports (tasks, checkpoints, todos, decisions, errors, open
questions, file captures, cross-entity search, cloud sync).

This is an architectural rework: it introduces a new UI subsystem (a
webview-based panel) and a new sub-package, and it fully replaces the
existing sidebar tree view rather than patching it.

## Goals

- Give the extension a rich, editable, visual UI inside VS Code, backed by
  the same local `.ariadne/state.db` SQLite store used by the CLI/MCP/chat
  surfaces — no new backend, no network calls beyond the existing CLI-backed
  sync commands.
- Cover: task browsing/switching, an overview/status view, editable
  todos/decisions/errors/open questions, a file/diff inspector for git
  capture history, cross-entity search, and a visual sync UI.
- Add two always-visible toolbar actions: **Sync to Cloud** and **Export to
  Markdown**.
- Fully replace the existing read-only sidebar tree view.
- Leave the `@ariadne` chat participant and passive capture behavior
  unchanged.
- Build and package the extension (`.vsix`) but do **not** install it —
  the user will review it first.

## Non-goals

- No changes to `@ariadne-dev/core`'s data model or public API beyond what's
  already exposed (this is a UI-only rework; `getTaskFileCaptures`,
  `listTasks`, `listTodos`, etc. already exist and are sufficient).
- No reuse of the dashboard's React/API-client code — that app is built
  around a multi-admin REST API (login, CSRF, 5-minute reauthentication,
  Postgres-backed backups/services/deployments) that has no meaning for a
  single local SQLite file per workspace. See "Approaches considered" below.
- No Playwright/E2E harness for the webview — out of proportion to the
  value for a single-panel VS Code extension; covered by host-side unit
  tests, component tests, and a manual smoke checklist instead.
- No changes to the sync-server, operator, or cloud dashboard.

## Approaches considered

1. **Fresh lightweight React webview inside `vscode-extension` (chosen).**
   A small, purpose-built React app talking to the extension host via
   `postMessage`, which calls `@ariadne-dev/core` directly. Minimal new
   surface area, no unrelated machinery.
2. **Extract a shared `packages/webview-ui` component library** used by both
   the dashboard and the extension. Better long-term reuse, but requires
   first re-architecting the dashboard's data-fetching layer to be
   pluggable (HTTP vs. direct store) — a large, separate investment with no
   present need.
3. **Embed the existing dashboard bundle via a local mini HTTP server**
   reading the workspace's SQLite file. Reuses the dashboard UI verbatim,
   but drags in unrelated auth/CSRF/reauthentication/backup/service/
   deployment code built for a multi-admin, Postgres-backed, multi-tenant
   system — architecturally the wrong shape for a single local file.

Approach 1 was selected: smallest surface area, no architectural mismatch,
and every data operation the webview needs already exists in
`@ariadne-dev/core`.

## Architecture

```
packages/vscode-extension/
  webview-ui/                 # new: Vite + React app, own package.json/tsconfig
    src/
      App.tsx
      panels/                 # Overview, Todos, Decisions, Errors, Questions,
                              # Files, Search, Sync
      components/
      bridge.ts               # typed postMessage request/response client
    vite.config.ts
  src/
    webview/
      panel.ts                # creates/reveals the vscode.WebviewPanel
      messages.ts             # shared request/response types (also imported
                              # by webview-ui via a path alias — no runtime
                              # dependency, types only)
      handleWebviewMessage.ts # pure(ish) dispatcher: TaskStore/git/sync in,
                              # typed response out — vscode-free, unit-testable
    extension.ts               # wires panel.ts in, removes treeView.ts wiring
```

- **One `WebviewPanel` per workspace.** Opened via a new `ariadne.openPanel`
  command (also bound to the existing status bar item's click target,
  replacing its current `/status` shortcut) and a new activity-bar entry
  point. Revealing an already-open panel focuses it instead of creating a
  duplicate.
- **Communication**: typed request/response messages over `postMessage`.
  The webview never touches the filesystem, SQLite, or git directly — the
  extension host owns all `TaskStore`/`syncCommands`/git calls, matching the
  existing extension-host-owns-state pattern used by `commands.ts` and
  `treeView.ts`. This also means no new security surface: the webview is a
  pure renderer.
- **State shape**: a single `WebviewState` snapshot (current task id, task
  list, and the active task's categories) is computed by the host and
  pushed via a `stateUpdate` message after every mutation — the same
  refresh trigger points that already call `refreshStatusBar()` /
  `refreshTreeView()` today will also call a new `refreshWebview()`. File
  capture content (diffs) is fetched lazily per commit click via a
  dedicated request type, not included in the bulk snapshot, to keep the
  initial payload small.
- **Errors**: every request that throws resolves as
  `{ id, ok: false, error }` instead of throwing across the bridge; the
  webview renders an inline dismissible banner. The host still logs to the
  existing "Ariadne" output channel for diagnostics, matching current
  command error handling.

## UI structure

Single-page app, left rail navigation (not full page routing):

1. **Task switcher** (top of rail) — list of tasks, current workspace by
   default with an "all workspaces" toggle (reusing existing
   `listTasks`/`--all-workspaces` support), filter box, click to switch the
   current task.
2. **Toolbar** (always visible, top of panel) — **Sync to Cloud** (runs the
   existing `syncPush` logic for the current workspace; inline
   spinner/result, no need to open the Sync tab for the common case) and
   **Export to Markdown** (runs the existing `/export` logic for the
   current task, writes `.ariadne/export/<task-id>.md`, opens the result in
   the editor on success).
3. **Overview tab** — goal, status, tracked branch, latest checkpoint,
   reverse-chronological checkpoint timeline, and at-a-glance counts (open
   questions / unresolved errors / pending todos). A richer visual version
   of `/status`.
4. **Todos / Decisions / Errors / Questions tabs** — each an editable list
   (add / edit / complete-resolve / reopen / delete) calling existing
   `TaskStore` methods through the bridge; no new core logic, only UI and
   the dispatcher plumbing.
5. **Files tab** — the file inspector. Commit list from
   `getTaskFileCaptures(taskId)`; clicking a commit lazily loads its entries
   (path, unified diff, byte length) rendered with a lightweight diff view
   (syntax highlighting optional/nice-to-have, not required for v1).
6. **Search tab** — single input over the existing cross-entity `search`
   logic, results grouped by type, click-through focuses the matching
   tab/item.
7. **Sync tab** — visual replacement for the current output-channel-based
   flow: push / pull (with the existing "import new" choice) / list-remote
   as buttons with inline status, spinner, and result list.

The existing read-only sidebar tree view (`treeView.ts`,
`AriadneTreeDataProvider`) is fully removed; the activity-bar entry now
opens the webview panel instead.

## Data flow & error handling

- Webview → host: `{ id, type, payload }` requests.
- Host → webview: `{ id, ok: true, data }` or `{ id, ok: false, error }`
  responses, plus unsolicited `{ type: 'stateUpdate', state }` pushes after
  any mutation (host-initiated, e.g. from a chat-participant command run
  concurrently, or from the webview's own mutation).
- `handleWebviewMessage` is a single dispatcher function, `vscode`-free,
  mirroring the existing `handleChatCommand` split in `commands.ts` — this
  keeps it directly unit-testable with an in-memory `TaskStore`.

## Testing plan

- **Host-side dispatcher** (`handleWebviewMessage.ts` and the state-snapshot
  builder): Vitest, no `vscode` mocking needed, following the existing
  `commands.ts` / `treeView.ts` testing pattern.
- **Webview React components** (`webview-ui`): Vitest + React Testing
  Library, new local test setup; covers list CRUD flows, the diff view,
  search, and the two toolbar buttons.
- **Manual smoke checklist** (documented in the plan, executed once before
  packaging): open panel, switch tasks, exercise each tab's CRUD, view a
  commit's diff, search, sync push, export.
- Existing `test/` coverage for `commands.ts`, `workspace.ts`,
  `passiveCapture.ts`, `syncCommands.ts` is untouched (those modules are not
  being changed beyond the new refresh hook, which gets its own test).

## Build & packaging

- `esbuild.js` gains a step to build the `webview-ui` Vite app and copy its
  output into `dist/webview/`.
- `pnpm run build` and `pnpm run package` (`vsce package --no-dependencies`)
  must both succeed and the resulting `.vsix` must contain the webview
  assets. The `.vsix` is built and left on disk for review — **it is not
  installed**, per explicit instruction.

## Rollout

Implemented directly on the existing `feat/nodem2-cloud` branch (no
separate feature branch requested), test-first, with the usual review gate
(TypeScript/React reviewers) before considering the rework complete. No
production/cloud component is touched by this work — it is entirely local
to the `vscode-extension` package.
