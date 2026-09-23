# VS Code Extension Webview Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Ariadne VS Code extension's read-only tree view with a rich React webview panel for task switching, overview, editable task entities, file captures, search, sync, and export.

**Architecture:** The VS Code extension host owns all filesystem, SQLite, git, sync, and export work; a Vite/React webview renders state and sends typed `postMessage` requests. A vscode-free dispatcher builds `WebviewState` snapshots and mutates `TaskStore`, while `panel.ts` adapts those pure results to VS Code APIs and refreshes the panel after changes.

**Tech Stack:** TypeScript, VS Code Extension API, `@ariadne-dev/core`, Vite, React 19, Vitest, React Testing Library, jsdom, esbuild, vsce.

**Spec:** `docs/superpowers/specs/2026-09-23-vscode-extension-webview-rework-design.md`

## Global Constraints

- UI-only rework; do not change `@ariadne-dev/core` data model or public API.
- No dashboard API-client/auth reuse; the webview talks only to the extension host bridge.
- No new backend and no network calls beyond existing CLI-backed sync commands.
- Leave `@ariadne` chat participant and passive capture behavior unchanged except adding the shared webview refresh hook after state changes.
- Fully remove the existing read-only sidebar tree view wiring.
- Build and package the extension `.vsix` but do not install it.
- Test first for each task: failing unit/component test, implementation, passing test, commit.

---

## File Structure

- `packages/vscode-extension/src/webview/messages.ts`: shared request, response, event, snapshot, and entity view types.
- `packages/vscode-extension/src/webview/handleWebviewMessage.ts`: vscode-free dispatcher and `buildWebviewState()` snapshot builder.
- `packages/vscode-extension/src/webview/panel.ts`: VS Code `WebviewPanel` lifecycle, CSP-safe HTML, message adapter, export file opening, and refresh entry point.
- `packages/vscode-extension/src/extension.ts`: command/view contribution wiring, status-bar target change, tree view removal, refresh hook integration.
- `packages/vscode-extension/package.json`: command/view contributions, React/Vite test/build dependencies, removal of tree-view command/menu.
- `packages/vscode-extension/esbuild.js`: build Vite webview UI into `dist/webview/` before packaging.
- `packages/vscode-extension/test/webviewMessage.test.ts`: dispatcher and state-builder unit tests with in-memory `TaskStore`.
- `packages/vscode-extension/test/extension.test.ts`: extension activation wiring updates.
- `packages/vscode-extension/webview-ui/*`: nested Vite/React app, bridge client, components, panels, tests, and local TypeScript/Vitest config.

---

### Task 1: Host Message Contract and Dispatcher

**Files:**
- Create: `packages/vscode-extension/src/webview/messages.ts`
- Create: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Create: `packages/vscode-extension/test/webviewMessage.test.ts`

**Interfaces:**
- Consumes: `TaskStore`, `searchWorkspace`, `listTasksAcrossWorkspaces`, `searchAcrossWorkspaces`, `exportTaskMarkdown` from `@ariadne-dev/core`; `syncPush`, `syncPull`, `syncListRemote` from `src/syncCommands.ts`.
- Produces:
  - `buildWebviewState(deps: WebviewDispatcherDeps): WebviewState`
  - `handleWebviewMessage(deps: WebviewDispatcherDeps, message: WebviewRequest): WebviewResponse`
  - `WebviewDispatcherDeps = { store: TaskStore; currentTaskId?: string; workspaceRoot?: string; setCurrentTaskId?: (id: string) => void; sync?: SyncActions; writeExport?: (taskId: string, markdown: string) => string }`
  - `WebviewRequest = { id: string; type: WebviewRequestType; payload?: unknown }`
  - `WebviewResponse = { id: string; ok: true; data: unknown; state?: WebviewState } | { id: string; ok: false; error: string }`

- [ ] **Step 1: Write the failing dispatcher tests**

Add `packages/vscode-extension/test/webviewMessage.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { TaskStore } from '@ariadne-dev/core';
import { buildWebviewState, handleWebviewMessage } from '../src/webview/handleWebviewMessage.js';

function makeStore() {
  const store = new TaskStore(':memory:');
  const task = store.createTask({ title: 'Webview task', goal: 'Ship the panel' });
  store.createTodo({ taskId: task.id, text: 'Write host tests' });
  store.recordDecision({ taskId: task.id, text: 'Use React webview', rationale: 'Local UI only' });
  store.recordError({ taskId: task.id, message: 'Build failed' });
  store.recordOpenQuestion({ taskId: task.id, text: 'Review VSIX?' });
  store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Started rework' });
  return { store, task };
}

describe('buildWebviewState', () => {
  it('builds a current-task snapshot with counts and editable categories', () => {
    const { store, task } = makeStore();
    const state = buildWebviewState({ store, currentTaskId: task.id, workspaceRoot: '/repo' });

    expect(state.currentTask?.id).toBe(task.id);
    expect(state.tasks.map((t) => t.id)).toContain(task.id);
    expect(state.todos).toHaveLength(1);
    expect(state.decisions).toHaveLength(1);
    expect(state.errors).toHaveLength(1);
    expect(state.questions).toHaveLength(1);
    expect(state.checkpoints[0].summary).toBe('Started rework');
    expect(state.counts).toEqual({ pendingTodos: 1, unresolvedErrors: 1, openQuestions: 1 });
    store.close();
  });
});

describe('handleWebviewMessage', () => {
  it('creates, edits, completes, reopens, and deletes todos', () => {
    const { store, task } = makeStore();
    const add = handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '1', type: 'todo.create', payload: { text: 'Add bridge' } },
    );
    expect(add.ok).toBe(true);
    const created = store.listTodos(task.id).find((todo) => todo.text === 'Add bridge');
    expect(created).toBeDefined();

    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '2', type: 'todo.updateText', payload: { id: created!.id, text: 'Add typed bridge' } },
    );
    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '3', type: 'todo.setStatus', payload: { id: created!.id, status: 'done' } },
    );
    expect(store.listTodos(task.id).find((todo) => todo.id === created!.id)?.status).toBe('done');

    handleWebviewMessage(
      { store, currentTaskId: task.id, workspaceRoot: '/repo' },
      { id: '4', type: 'todo.delete', payload: { id: created!.id } },
    );
    expect(store.listTodos(task.id).some((todo) => todo.id === created!.id)).toBe(false);
    store.close();
  });

  it('returns an error response instead of throwing when a task is required', () => {
    const store = new TaskStore(':memory:');
    const response = handleWebviewMessage(
      { store, currentTaskId: undefined, workspaceRoot: '/repo' },
      { id: 'missing', type: 'todo.create', payload: { text: 'No task' } },
    );
    expect(response).toEqual({ id: 'missing', ok: false, error: 'No current Ariadne task is selected.' });
    store.close();
  });

  it('runs sync and export through injected host actions', () => {
    const { store, task } = makeStore();
    const syncPush = vi.fn(() => 'pushed');
    const writeExport = vi.fn(() => '/repo/.ariadne/export/task.md');

    expect(
      handleWebviewMessage(
        { store, currentTaskId: task.id, workspaceRoot: '/repo', sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'sync', type: 'sync.push' },
      ),
    ).toMatchObject({ id: 'sync', ok: true, data: { output: 'pushed' } });

    expect(
      handleWebviewMessage(
        { store, currentTaskId: task.id, workspaceRoot: '/repo', sync: { push: syncPush, pull: vi.fn(), listRemote: vi.fn() }, writeExport },
        { id: 'export', type: 'export.markdown' },
      ),
    ).toMatchObject({ id: 'export', ok: true, data: { path: '/repo/.ariadne/export/task.md' } });
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`

Expected: FAIL because `src/webview/handleWebviewMessage.ts` does not exist.

- [ ] **Step 3: Implement messages and dispatcher**

Create `messages.ts` with explicit request strings for: `state.get`, `task.switch`, `tasks.list`, `todo.create`, `todo.updateText`, `todo.setStatus`, `todo.delete`, `decision.create`, `decision.update`, `decision.delete`, `error.create`, `error.update`, `error.resolve`, `error.reopen`, `error.delete`, `question.create`, `question.update`, `question.resolve`, `question.reopen`, `question.delete`, `files.list`, `files.getCapture`, `search.run`, `sync.push`, `sync.pull`, `sync.listRemote`, and `export.markdown`.

Implement `handleWebviewMessage.ts` so every mutation validates payload fields, calls the corresponding existing `TaskStore` method, and returns the updated `WebviewState` in `response.state`. Use `exportTaskMarkdown(store, taskId)` plus injected `writeExport` for export, and use injected sync actions for sync. File captures return `store.getTaskFileCaptures(taskId)`; `files.getCapture` returns one capture by id from that array. Search uses `searchWorkspace(store, query, options)` for current workspace and `searchAcrossWorkspaces(query, options)` when `allWorkspaces` is true.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/test/webviewMessage.test.ts
git commit -m "feat: add vscode webview message dispatcher"
```

---

### Task 2: VS Code Webview Panel Integration

**Files:**
- Create: `packages/vscode-extension/src/webview/panel.ts`
- Modify: `packages/vscode-extension/src/extension.ts`
- Modify: `packages/vscode-extension/package.json`
- Modify: `packages/vscode-extension/test/extension.test.ts`

**Interfaces:**
- Consumes: `handleWebviewMessage()`, `buildWebviewState()`, `openStoreForCurrentWorkspace()`, `getCurrentTaskId()`, `setCurrentTask()`, `resolveWorkspaceRoot()`, `syncPush()`, `syncPull()`, `syncListRemote()`.
- Produces:
  - `openAriadnePanel(context: vscode.ExtensionContext, deps: AriadnePanelDeps): void`
  - `refreshAriadnePanel(): void`
  - `AriadnePanelDeps = { openStoreForCurrentWorkspace: () => TaskStore | undefined; getCurrentTaskId: () => string | undefined; setCurrentTask: (id: string) => void; resolveWorkspaceRoot: () => string | undefined; output: vscode.OutputChannel; logError: (context: string, err: unknown) => string; refreshHost: () => void; openExportedMarkdown: (filePath: string) => Promise<void> }`

- [ ] **Step 1: Write the failing activation test**

Update `packages/vscode-extension/test/extension.test.ts` so the vscode mock records registered commands and view providers. Add:

```ts
it('registers the Ariadne panel command and no longer registers the tree provider', async () => {
  const { activate } = await import('../src/extension.js');
  const context = makeExtensionContext();

  activate(context);

  expect(registeredCommands.map((entry) => entry.command)).toContain('ariadne.openPanel');
  expect(registeredCommands.map((entry) => entry.command)).not.toContain('ariadne.refreshTreeView');
  expect(registeredTreeProviders.map((entry) => entry.viewId)).not.toContain('ariadneTasks');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vscode-extension && pnpm vitest run test/extension.test.ts`

Expected: FAIL because `ariadne.openPanel` is not registered and the tree provider is still registered.

- [ ] **Step 3: Implement panel wiring**

Create `panel.ts` with one module-level `panel: vscode.WebviewPanel | undefined`. `openAriadnePanel()` reveals an existing panel or creates `vscode.window.createWebviewPanel('ariadnePanel', 'Ariadne', vscode.ViewColumn.One, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')] })`. Generate HTML referencing `dist/webview/assets/*.js` and `*.css` through `webview.asWebviewUri`, with CSP allowing only `webview.cspSource`.

In `panel.webview.onDidReceiveMessage`, call `handleWebviewMessage()` with sync actions and an export writer that writes `.ariadne/export/<task-id>.md`. When the response has `state`, post `{ type: 'stateUpdate', state }`; always post the response by id. For `task.switch`, call `setCurrentTask()` through dispatcher deps. For `export.markdown`, call `openExportedMarkdown(path)` after successful response.

Modify `extension.ts`:
- Remove `AriadneTreeDataProvider`, `treeDataProvider`, and `refreshTreeView()`.
- Add `refreshAll()` calling `refreshStatusBar()` and `refreshAriadnePanel()`.
- Set status bar command to `ariadne.openPanel` when a task exists.
- Register `ariadne.openPanel`.
- Replace old tree refresh call sites with `refreshAll()`.

Modify `package.json` contributions:
- Add command `{ "command": "ariadne.openPanel", "title": "Ariadne: Open Panel" }`.
- Remove `ariadne.refreshTreeView`, `views.ariadne[0].id = ariadneTasks`, and `menus.view/title`.
- Replace the activity-bar view with a webview view entry `{ "type": "webview", "id": "ariadnePanel", "name": "Ariadne" }` only if VS Code accepts the contributed webview view; otherwise keep the command as the activity entry point through `ariadne.openPanel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vscode-extension && pnpm vitest run test/extension.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-extension/src/webview/panel.ts packages/vscode-extension/src/extension.ts packages/vscode-extension/package.json packages/vscode-extension/test/extension.test.ts
git rm packages/vscode-extension/src/treeView.ts packages/vscode-extension/test/treeView.test.ts
git commit -m "feat: wire ariadne vscode webview panel"
```

---

### Task 3: Webview UI Package, Bridge, and Shell

**Files:**
- Create: `packages/vscode-extension/webview-ui/package.json`
- Create: `packages/vscode-extension/webview-ui/tsconfig.json`
- Create: `packages/vscode-extension/webview-ui/vite.config.ts`
- Create: `packages/vscode-extension/webview-ui/index.html`
- Create: `packages/vscode-extension/webview-ui/src/main.tsx`
- Create: `packages/vscode-extension/webview-ui/src/App.tsx`
- Create: `packages/vscode-extension/webview-ui/src/bridge.ts`
- Create: `packages/vscode-extension/webview-ui/src/test/setup.ts`
- Create: `packages/vscode-extension/webview-ui/src/App.test.tsx`

**Interfaces:**
- Consumes: `WebviewRequest`, `WebviewResponse`, `WebviewState`, `HostToWebviewMessage` from `../../src/webview/messages`.
- Produces:
  - `createVsCodeBridge(vscodeApi: VsCodeApi): AriadneBridge`
  - `AriadneBridge.request<T>(type: WebviewRequestType, payload?: unknown): Promise<T>`
  - `AriadneBridge.subscribe(listener: (state: WebviewState) => void): () => void`
  - React shell with left task rail, all-workspaces toggle, tab buttons, toolbar, and inline error banner.

- [ ] **Step 1: Write failing React shell tests**

Create `App.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import type { AriadneBridge } from './bridge';
import type { WebviewState } from '../../src/webview/messages';

const state: WebviewState = {
  workspaceRoot: '/repo',
  currentTaskId: 'task-1',
  currentTask: { id: 'task-1', title: 'Panel task', goal: 'Make UI useful', status: 'active', parentTaskId: null, branch: 'feat/ui', createdAt: '', updatedAt: '' },
  tasks: [{ id: 'task-1', title: 'Panel task', status: 'active', parentTaskId: null, branch: 'feat/ui', createdAt: '', updatedAt: '' }],
  checkpoints: [],
  todos: [],
  decisions: [],
  errors: [],
  questions: [],
  fileCaptures: [],
  counts: { pendingTodos: 0, unresolvedErrors: 0, openQuestions: 0 },
};

function bridge(overrides: Partial<AriadneBridge> = {}): AriadneBridge {
  return {
    request: vi.fn(async () => state),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe('App', () => {
  it('renders the task rail, toolbar, and tabs from the initial state', () => {
    render(<App bridge={bridge()} initialState={state} />);
    expect(screen.getByRole('heading', { name: 'Ariadne' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync to Cloud' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export to Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Panel task')).toBeInTheDocument();
  });

  it('switches tabs without routing', async () => {
    render(<App bridge={bridge()} initialState={state} />);
    await userEvent.click(screen.getByRole('button', { name: 'Todos' }));
    expect(screen.getByRole('button', { name: 'Todos' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Todos' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/App.test.tsx`

Expected: FAIL because the webview-ui package does not exist.

- [ ] **Step 3: Implement package, bridge, and shell**

Use React 19 and local Vite config with `base: './'`, `test.environment: 'jsdom'`, `setupFiles: './src/test/setup.ts'`, and an alias `@host` pointing at `../src/webview`. The shell maintains `state`, `activeTab`, `busyLabel`, `banner`, `taskFilter`, and `allWorkspaces`. Toolbar buttons call `bridge.request('sync.push')` and `bridge.request('export.markdown')`, show inline status, and refresh state from response events.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/App.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-extension/webview-ui
git commit -m "feat: scaffold ariadne vscode webview ui"
```

---

### Task 4: Editable Entity Panels

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/EntityPanels.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/EntityPanels.test.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`

**Interfaces:**
- Consumes: `AriadneBridge`, `WebviewState`.
- Produces:
  - `TodosPanel`, `DecisionsPanel`, `ErrorsPanel`, `QuestionsPanel`
  - Each panel accepts `{ state: WebviewState; bridge: AriadneBridge; onBusy(label: string | undefined): void; onError(message: string): void }`

- [ ] **Step 1: Write failing component tests**

Create tests that render one item for each category, type into the add/edit fields, and assert `bridge.request()` calls exact message types: `todo.create`, `todo.updateText`, `todo.setStatus`, `decision.create`, `decision.update`, `error.resolve`, `error.reopen`, `question.resolve`, `question.reopen`, and delete message types.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/EntityPanels.test.tsx`

Expected: FAIL because `EntityPanels.tsx` does not exist.

- [ ] **Step 3: Implement editable panels**

Use simple forms and accessible buttons:
- Todos: add text, edit text, status select for `pending|done|blocked`, delete.
- Decisions: add text+rationale, edit text+rationale, delete.
- Errors: add message, edit message, resolve, reopen, delete.
- Questions: add text, edit text, resolve, reopen, delete.
After each request, rely on host `stateUpdate`; do not mutate local arrays directly.

- [ ] **Step 4: Run tests**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/EntityPanels.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-extension/webview-ui/src/panels/EntityPanels.tsx packages/vscode-extension/webview-ui/src/panels/EntityPanels.test.tsx packages/vscode-extension/webview-ui/src/App.tsx
git commit -m "feat: add editable ariadne webview panels"
```

---

### Task 5: Overview, Files, Search, and Sync Panels

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/OverviewPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/FilesPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/SearchPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/SyncPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`

**Interfaces:**
- Consumes: `AriadneBridge`, `WebviewState`, `TaskFileCaptureWithEntries`-compatible payloads, `SearchResult[]`, sync output strings.
- Produces:
  - Overview counts/checkpoint timeline.
  - Files commit list and lazy diff entries.
  - Search form with current/all workspace toggle and grouped results.
  - Sync buttons for push, pull, pull import-new, and list remote.

- [ ] **Step 1: Write failing utility panel tests**

Create tests asserting:
- Overview renders goal, branch, counts, and latest checkpoint.
- Files click calls `bridge.request('files.getCapture', { id })` and displays `unifiedDiff`.
- Search submit calls `bridge.request('search.run', { query, allWorkspaces })` and renders grouped result categories.
- Sync buttons call `sync.push`, `sync.pull` with `{ importNew: false }`, `sync.pull` with `{ importNew: true }`, and `sync.listRemote`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx`

Expected: FAIL because the panels do not exist.

- [ ] **Step 3: Implement utility panels**

Keep diff rendering lightweight with `<pre>` blocks and line classes for `+`, `-`, and context lines. Search groups by `category` and displays `text`, `taskId`, and `createdAt` when present. Sync panel stores the latest command output in local component state and renders it in `<pre aria-label="Sync output">`.

- [ ] **Step 4: Run tests**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-extension/webview-ui/src/panels/OverviewPanel.tsx packages/vscode-extension/webview-ui/src/panels/FilesPanel.tsx packages/vscode-extension/webview-ui/src/panels/SearchPanel.tsx packages/vscode-extension/webview-ui/src/panels/SyncPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx packages/vscode-extension/webview-ui/src/App.tsx
git commit -m "feat: add ariadne overview files search sync panels"
```

---

### Task 6: Build Pipeline and Packaging Assets

**Files:**
- Modify: `packages/vscode-extension/package.json`
- Modify: `packages/vscode-extension/esbuild.js`
- Modify: `packages/vscode-extension/.vscodeignore`

**Interfaces:**
- Consumes: `webview-ui` `pnpm build` output in `packages/vscode-extension/webview-ui/dist`.
- Produces: packaged extension assets under `packages/vscode-extension/dist/webview/`.

- [ ] **Step 1: Write failing package/build checks**

Run:

```bash
cd packages/vscode-extension
pnpm run build
test -d dist/webview
```

Expected: FAIL because `dist/webview` is not created yet.

- [ ] **Step 2: Implement webview build step**

In `esbuild.js`, add `buildWebviewUi()` before `copyBetterSqlite3Runtime()` in normal builds. It runs `pnpm install --ignore-scripts` in `webview-ui` only if `node_modules` is missing, then `pnpm run build`, removes `dist/webview`, and copies `webview-ui/dist` into `dist/webview`. In watch mode, run one initial webview build and leave Vite watch out of scope for this task.

Update root extension `package.json` scripts only if needed so `pnpm run build` still maps to `node esbuild.js` and `pnpm run package` still maps to `vsce package --no-dependencies`.

Update `.vscodeignore` to exclude `webview-ui/src`, tests, and configs while including `dist/webview/**`.

- [ ] **Step 3: Run build checks**

Run:

```bash
cd packages/vscode-extension
pnpm run build
test -f dist/webview/index.html
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/vscode-extension/esbuild.js packages/vscode-extension/package.json packages/vscode-extension/.vscodeignore
git commit -m "build: bundle vscode webview assets"
```

---

### Task 7: Full Validation, Review Gate, and VSIX

**Files:**
- Modify only files needed to fix validation failures discovered in this task.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a built `.vsix` left on disk for user review; no installation.

- [ ] **Step 1: Run focused test suites**

Run:

```bash
cd packages/vscode-extension
pnpm test
cd webview-ui
pnpm test
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript/React review gate**

Dispatch the TypeScript Reviewer and React Reviewer on the final diff. Fix any high-confidence correctness, type-safety, async, React hook, or accessibility issues they report.

- [ ] **Step 3: Run final build and package**

Run:

```bash
cd packages/vscode-extension
pnpm run build
pnpm run package
ls -1 *.vsix dist-vsix/*.vsix 2>/dev/null || true
```

Expected: PASS and a `.vsix` exists. Do not install it.

- [ ] **Step 4: Confirm `.vsix` contains webview assets**

Run:

```bash
cd packages/vscode-extension
python - <<'PY'
import glob, zipfile
vsix = sorted(glob.glob('*.vsix') + glob.glob('dist-vsix/*.vsix'))[-1]
with zipfile.ZipFile(vsix) as z:
    names = z.namelist()
assert any(name.endswith('extension/dist/webview/index.html') for name in names), vsix
assert any('/extension/dist/webview/assets/' in name for name in names), vsix
print(vsix)
PY
```

Expected: prints the packaged VSIX path.

- [ ] **Step 5: Mark task done and commit final fixes**

```bash
git add packages/vscode-extension docs/superpowers/plans/2026-09-23-vscode-extension-webview-rework.md
git commit -m "test: validate vscode webview package"
```

If there are no final fixes after packaging, do not create an empty commit.
