# VS Code Extension Product Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the next VS Code product features: activity timeline, capture health, context handoff, onboarding, task templates, review mode, Files/Search polish, Graphify UI, and sync profile/status polish.

**Architecture:** Extend the existing typed webview bridge and vscode-free dispatcher; do not add a backend. The extension host owns `TaskStore`, context, file opening, clipboard/virtual documents, sync CLI wrappers, Graphify subprocesses, and capability checks, while React renders state and sends typed requests.

**Tech Stack:** TypeScript, VS Code Extension API, `@ariadne-dev/core`, React 19, Vite, Vitest, React Testing Library, jsdom, esbuild, vsce.

**Spec:** `docs/superpowers/specs/2026-09-23-vscode-extension-product-polish-design.md`

## Global Constraints

- VS Code product features only; no marketplace publishing, external plugins, LLM/embedding provider integrations, or team/cloud collaboration UI.
- Local SQLite remains the source of truth; no daemon, backend, or new network path.
- React webview remains renderer-only; host owns filesystem, SQLite, git, clipboard/editor, CLI subprocess, and output-channel behavior.
- Preserve existing `@ariadne` chat participant and passive-capture listeners.
- Graphify and sync run only through extension-host helpers; the webview never executes shell commands directly.
- Use TDD per task: failing test, implementation, passing tests, commit.
- Keep commits milestone-sized and reviewable.
- Build/package/install the final reviewed `.vsix`; keep extension backups outside `~/.vscode-server/extensions`.
- Do not mix the existing optional SVG Activity Bar icon hardening into feature commits.

---

## File Structure

- `packages/vscode-extension/src/webview/messages.ts`: add shared DTOs and request types for activity, capture health, context actions, templates, review mode, Graphify, and sync profile/status.
- `packages/vscode-extension/src/webview/handleWebviewMessage.ts`: add pure dispatcher handlers and helper builders for the new host contract.
- `packages/vscode-extension/src/webview/panel.ts`: add VS Code-only adapters for clipboard, virtual Markdown documents, file opening, sync profile commands, and Graphify subprocess logging.
- `packages/vscode-extension/src/syncCommands.ts`: add `syncProfileList(options)` wrapper and a small parser for profile-list output.
- `packages/vscode-extension/src/commands.ts`: keep existing chat Graphify behavior unchanged; do not depend on private chat parsing helpers from the webview path.
- `packages/vscode-extension/test/webviewMessage.test.ts`: host dispatcher tests for all new request types and invalid input.
- `packages/vscode-extension/test/panel.test.ts`: panel adapter tests for clipboard/open-document/file-open side effects if existing mocks support them.
- `packages/vscode-extension/test/syncCommands.test.ts`: sync profile wrapper/parser tests.
- `packages/vscode-extension/webview-ui/src/App.tsx`: add tabs and navigation wiring for Activity, Context, Review, and Graphify; add template selection to task creation.
- `packages/vscode-extension/webview-ui/src/panels/ActivityPanel.tsx`: render activity timeline and filters.
- `packages/vscode-extension/webview-ui/src/panels/ContextPanel.tsx`: render budgeted context handoff preview and copy/open actions.
- `packages/vscode-extension/webview-ui/src/panels/ReviewPanel.tsx`: render pre-completion checklist and direct actions.
- `packages/vscode-extension/webview-ui/src/panels/GraphifyPanel.tsx`: render Graphify update/query/path/explain forms and output.
- `packages/vscode-extension/webview-ui/src/panels/FilesPanel.tsx`: add filters and open-file action.
- `packages/vscode-extension/webview-ui/src/panels/SearchPanel.tsx`: improve file/commit navigation affordances.
- `packages/vscode-extension/webview-ui/src/panels/SyncPanel.tsx`: add profile/status UI and raw-output details.
- `packages/vscode-extension/webview-ui/src/panels/*.test.tsx`: component tests for new panels and updated flows.
- `packages/vscode-extension/README.md` and `packages/vscode-extension/CHANGELOG.md`: document the new UI features.

---

### Task 1: Host Contract for Activity, Capture Health, and Context Handoff

**Files:**
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/test/webviewMessage.test.ts`

**Interfaces:**
- Consumes:
  - `TaskStore.listCheckpoints(taskId)`
  - `TaskStore.listTodos(taskId)`
  - `TaskStore.listDecisions(taskId)`
  - `TaskStore.listErrors(taskId)`
  - `TaskStore.listOpenQuestions(taskId)`
  - `TaskStore.getTaskFileCaptures(taskId)`
  - `TaskStore.listCommits(taskId, limit?)`
  - `TaskStore.listCommands(taskId, limit?)`
  - `buildContext(store, taskId, { tokenBudget?, workspaceRoot? })`
- Produces:
  - `ActivityItem = { id: string; kind: ActivityKind; title: string; detail?: string; createdAt: string; entityId?: string; targetTab?: WebviewTabId; status?: 'info' | 'success' | 'warning' | 'error' }`
  - `ActivityKind = 'checkpoint' | 'todo' | 'decision' | 'error' | 'question' | 'file-capture' | 'commit' | 'command'`
  - `CaptureHealth = { workspaceRoot?: string; currentTaskId?: string; currentTaskTitle?: string; passiveCaptureEnabled: boolean; shellIntegrationAvailable: boolean; gitExtensionAvailable: boolean; branchMatches: boolean | 'unknown'; currentBranch?: string; taskBranch?: string | null; lastFileCapture?: ActivityItem; lastCommand?: ActivityItem; lastCommit?: ActivityItem; unresolvedErrors: number; warnings: string[] }`
  - `ContextSectionSummary = { id: string; label: string; count: number; truncatedCount?: number }`
  - `ContextPreview = { context: ContextPackage; markdown: string; tokenBudget: number; sections: ContextSectionSummary[] }`
  - request types: `activity.list`, `capture.health`, `context.preview`
  - dispatcher deps additions: `passiveCapture?: { enabled: boolean; shellIntegrationAvailable: boolean; gitExtensionAvailable: boolean; currentBranch?: string }`

- [ ] **Step 1: Write failing activity/context tests**

Add to `packages/vscode-extension/test/webviewMessage.test.ts`:

```ts
it('builds a reverse chronological activity timeline for the current task', () => {
  const { store, task } = makeStore();
  store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm test', exitCode: 0 });
  store.recordCommit({ taskId: task.id, sha: 'abcdef1234567890', message: 'feat: timeline' });

  const response = handleWebviewMessage(
    { store, currentTaskId: task.id, workspaceRoot: '/repo' },
    { id: 'activity', type: 'activity.list' },
  );

  expect(response.ok).toBe(true);
  expect(response.data).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ kind: 'command', title: 'pnpm test', status: 'success' }),
      expect.objectContaining({ kind: 'commit', title: 'abcdef1', detail: 'feat: timeline', targetTab: 'files' }),
      expect.objectContaining({ kind: 'checkpoint', targetTab: 'overview' }),
      expect.objectContaining({ kind: 'todo', targetTab: 'todos' }),
      expect.objectContaining({ kind: 'decision', targetTab: 'decisions' }),
      expect.objectContaining({ kind: 'error', targetTab: 'errors', status: 'error' }),
      expect.objectContaining({ kind: 'question', targetTab: 'questions' }),
    ]),
  });
  store.close();
});

it('returns capture health using explicit host capabilities and task state', () => {
  const { store, task } = makeStore();
  store.updateTaskBranch(task.id, 'feat/current');
  store.recordCommand({ taskId: task.id, cmdRedacted: 'pnpm build', exitCode: 1 });

  const response = handleWebviewMessage(
    {
      store,
      currentTaskId: task.id,
      workspaceRoot: '/repo',
      passiveCapture: {
        enabled: true,
        shellIntegrationAvailable: true,
        gitExtensionAvailable: false,
        currentBranch: 'main',
      },
    },
    { id: 'health', type: 'capture.health' },
  );

  expect(response.ok).toBe(true);
  expect(response.data).toMatchObject({
    health: {
      workspaceRoot: '/repo',
      currentTaskId: task.id,
      passiveCaptureEnabled: true,
      shellIntegrationAvailable: true,
      gitExtensionAvailable: false,
      branchMatches: false,
      taskBranch: 'feat/current',
      currentBranch: 'main',
      unresolvedErrors: 1,
      warnings: expect.arrayContaining([expect.stringContaining('branch')]),
    },
  });
  store.close();
});

it('returns empty activity and unknown health when no task is selected', () => {
  const store = new TaskStore(':memory:');

  expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'activity-empty', type: 'activity.list' })).toMatchObject({
    id: 'activity-empty',
    ok: true,
    data: { items: [], truncated: false },
  });
  expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'health-empty', type: 'capture.health' })).toMatchObject({
    id: 'health-empty',
    ok: true,
    data: { health: expect.objectContaining({ branchMatches: 'unknown', warnings: expect.arrayContaining([expect.stringContaining('No current task')]) }) },
  });
  expect(handleWebviewMessage({ store, workspaceRoot: '/repo' }, { id: 'context-empty', type: 'context.preview' })).toEqual({
    id: 'context-empty',
    ok: false,
    error: 'No current Ariadne task is selected.',
  });
  store.close();
});

it('returns a markdown context preview with a caller-selected token budget', () => {
  const { store, task } = makeStore();

  const response = handleWebviewMessage(
    { store, currentTaskId: task.id, workspaceRoot: '/repo' },
    { id: 'context', type: 'context.preview', payload: { tokenBudget: 1200 } },
  );

  expect(response.ok).toBe(true);
  expect(response.data).toMatchObject({
    preview: {
      tokenBudget: 1200,
      markdown: expect.stringContaining('Webview task'),
      context: expect.objectContaining({ taskId: task.id, workspaceRoot: '/repo' }),
    },
  });
  store.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`

Expected: FAIL with unknown request types or missing DTO fields.

- [ ] **Step 3: Add typed DTOs and request union members**

In `messages.ts`, add:

```ts
export type WebviewTabId =
  | 'overview'
  | 'todos'
  | 'decisions'
  | 'errors'
  | 'questions'
  | 'files'
  | 'search'
  | 'sync'
  | 'activity'
  | 'context'
  | 'review'
  | 'graphify';

export type ActivityKind = 'checkpoint' | 'todo' | 'decision' | 'error' | 'question' | 'file-capture' | 'commit' | 'command';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  createdAt: string;
  entityId?: string;
  targetTab?: WebviewTabId;
  status?: 'info' | 'success' | 'warning' | 'error';
}
```

Also add `CaptureHealth`, `ContextPreview`, and request variants:

```ts
| (WebviewRequestBase<'activity.list' | 'capture.health'> & { payload?: undefined })
| (WebviewRequestBase<'context.preview'> & { payload?: { tokenBudget?: number } })
```

- [ ] **Step 4: Implement pure builders and handlers**

In `handleWebviewMessage.ts`, add focused helpers:

```ts
function buildActivityItems(store: TaskStore, taskId: string, limit = 200): { items: ActivityItem[]; truncated: boolean } {
  const items: ActivityItem[] = [
    ...store.listCheckpoints(taskId).map((checkpoint) => ({
      id: `checkpoint:${checkpoint.id}`,
      kind: 'checkpoint' as const,
      title: checkpoint.summary,
      createdAt: checkpoint.createdAt,
      entityId: checkpoint.id,
      targetTab: 'overview' as const,
      status: 'info' as const,
    })),
    ...store.listTodos(taskId).map((todo) => ({
      id: `todo:${todo.id}`,
      kind: 'todo' as const,
      title: todo.text,
      createdAt: todo.createdAt,
      entityId: todo.id,
      targetTab: 'todos' as const,
      status: todo.status === 'done' ? ('success' as const) : todo.status === 'blocked' ? ('warning' as const) : ('info' as const),
    })),
    ...store.listDecisions(taskId).map((decision) => ({
      id: `decision:${decision.id}`,
      kind: 'decision' as const,
      title: decision.text,
      detail: decision.rationale ?? undefined,
      createdAt: decision.createdAt,
      entityId: decision.id,
      targetTab: 'decisions' as const,
      status: 'info' as const,
    })),
    ...store.listErrors(taskId).map((error) => ({
      id: `error:${error.id}`,
      kind: 'error' as const,
      title: error.message,
      detail: error.resolved ? error.resolution ?? 'Resolved' : undefined,
      createdAt: error.createdAt,
      entityId: error.id,
      targetTab: 'errors' as const,
      status: error.resolved ? ('success' as const) : ('error' as const),
    })),
    ...store.listOpenQuestions(taskId).map((question) => ({
      id: `question:${question.id}`,
      kind: 'question' as const,
      title: question.text,
      detail: question.resolved ? question.answer ?? 'Resolved' : undefined,
      createdAt: question.createdAt,
      entityId: question.id,
      targetTab: 'questions' as const,
      status: question.resolved ? ('success' as const) : ('warning' as const),
    })),
    ...store.getTaskFileCaptures(taskId).map((capture) => ({
      id: `file-capture:${capture.id}`,
      kind: 'file-capture' as const,
      title: `${capture.entries.length} captured file${capture.entries.length === 1 ? '' : 's'}`,
      detail: capture.gitCommitSha ?? capture.trigger,
      createdAt: capture.createdAt,
      entityId: capture.id,
      targetTab: 'files' as const,
      status: capture.failedAt ? ('error' as const) : ('info' as const),
    })),
    ...store.listCommits(taskId, 100).map((commit) => ({
      id: `commit:${commit.sha}`,
      kind: 'commit' as const,
      title: commit.sha.slice(0, 7),
      detail: commit.message ?? undefined,
      createdAt: commit.createdAt,
      entityId: commit.sha,
      targetTab: 'files' as const,
      status: 'info' as const,
    })),
    ...store.listCommands(taskId, 100).map((command) => ({
      id: `command:${command.id}`,
      kind: 'command' as const,
      title: command.cmd,
      detail: command.exitCode === null ? undefined : `exit ${command.exitCode}`,
      createdAt: command.createdAt,
      entityId: command.id,
      status: command.exitCode === 0 ? ('success' as const) : command.exitCode === null ? ('info' as const) : ('error' as const),
    })),
  ];
  const sorted = items.sort((a, b) => {
    const byTime = b.createdAt.localeCompare(a.createdAt);
    return byTime === 0 ? a.id.localeCompare(b.id) : byTime;
  });
  return { items: sorted.slice(0, limit), truncated: sorted.length > limit };
}
```

For `ContextPreview.markdown`, implement one named formatter exported from the dispatcher module:

```ts
export function formatContextPreview(context: ContextPackage): { markdown: string; sections: ContextSectionSummary[] }
```

Use only fields from the `ContextPackage` returned by `buildContext`; do not re-query the store inside the formatter. Sections must cover summary, todos, questions, errors, decisions, files, commits, and commands, and must surface `context.truncated` counts. Do not use `dangerouslySetInnerHTML` anywhere; this is plain text/Markdown.

`CaptureHealth.unresolvedErrors` is the count of unresolved `TaskStore.listErrors(taskId)` rows, regardless of whether they came from diagnostics, manual error recording, or failed commands. Failed command rows are represented by `lastCommand.status = 'error'`, not by incrementing a separate diagnostic counter.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/test/webviewMessage.test.ts
git commit -m "feat: add vscode activity and context contract"
```

---

### Task 2: Activity Timeline, Capture Health, and Context Handoff UI

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/ActivityPanel.tsx`
- Create: `packages/vscode-extension/webview-ui/src/panels/ContextPanel.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/OverviewPanel.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.test.tsx`

**Interfaces:**
- Consumes:
  - `bridge.request<{ items: ActivityItem[] }>('activity.list')`
  - `bridge.request<{ health: CaptureHealth }>('capture.health')`
  - `bridge.request<{ preview: ContextPreview }>('context.preview', { tokenBudget })`
- Produces:
  - `ActivityPanel({ bridge, taskId, onNavigate, onBusy, onError })`
  - `ContextPanel({ bridge, taskId, onBusy, onError })`
  - New `activity` and `context` tabs in `App.tsx`.

- [ ] **Step 1: Write failing component tests**

Add to `UtilityPanels.test.tsx`:

```tsx
it('loads activity and filters timeline rows by kind', async () => {
  const harness = createBridge({
    request: vi.fn(async (type: string) => {
      if (type === 'activity.list') {
        return {
          items: [
            { id: 'command:1', kind: 'command', title: 'pnpm test', createdAt: '2026-09-23T10:10:00.000Z', status: 'success' },
            { id: 'error:1', kind: 'error', title: 'Build failed', createdAt: '2026-09-23T10:09:00.000Z', targetTab: 'errors', entityId: 'error-1', status: 'error' },
          ],
        };
      }
      if (type === 'capture.health') {
        return {
          health: {
            workspaceRoot: '/repo',
            currentTaskId: task.id,
            currentTaskTitle: task.title,
            passiveCaptureEnabled: true,
            shellIntegrationAvailable: true,
            gitExtensionAvailable: true,
            branchMatches: true,
            unresolvedErrors: 0,
            warnings: [],
          },
        };
      }
      return {};
    }) as BridgeHarness['request'],
  });

  render(<ActivityPanel bridge={harness} taskId={task.id} onNavigate={() => undefined} onBusy={() => undefined} onError={() => undefined} />);

  expect(await screen.findByText('pnpm test')).toBeInTheDocument();
  expect(screen.getByText('Passive capture enabled')).toBeInTheDocument();
  expect(screen.getByText('/repo')).toBeInTheDocument();
  expect(screen.getByText('No unresolved errors')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Errors' }));
  expect(screen.queryByText('pnpm test')).not.toBeInTheDocument();
  expect(screen.getByText('Build failed')).toBeInTheDocument();
});

it('previews context with a budget and offers copy/open actions', async () => {
  const harness = createBridge({
    request: vi.fn(async (type: string, payload?: unknown) => {
      if (type === 'context.preview') {
        return {
          preview: {
            tokenBudget: (payload as { tokenBudget: number }).tokenBudget,
            markdown: '# Context\nUtility panels',
            sections: [{ id: 'summary', label: 'Summary', count: 1 }],
            context: {
              taskId: task.id,
              goal: task.goal,
              branch: task.branch,
              workspaceRoot: '/repo',
              latestSummary: 'Session summary',
              openQuestions: [],
              openTodos: [],
              blockedTodos: [],
              unresolvedErrors: [],
              recentFiles: [],
              recentCommits: [],
              recentCommands: [],
              decisions: [],
              truncated: {},
            },
          },
        };
      }
      return {};
    }) as BridgeHarness['request'],
  });

  render(<ContextPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />);

  await userEvent.clear(screen.getByLabelText('Token budget'));
  await userEvent.type(screen.getByLabelText('Token budget'), '1200');
  await userEvent.click(screen.getByRole('button', { name: 'Preview context' }));

  expect(await screen.findByText('# Context')).toBeInTheDocument();
  expect(screen.getByText('Summary: 1 included')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Copy context' }));
  await waitFor(() => expect(harness.request).toHaveBeenCalledWith('context.copy', { markdown: '# Context\nUtility panels' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx`

Expected: FAIL because panels and `context.copy` request are missing.

- [ ] **Step 3: Add ActivityPanel**

Implement `ActivityPanel.tsx` with:
- `useEffect` keyed by `taskId` to request `activity.list` and `capture.health`. Use a request-generation counter or `cancelled` flag so an old response cannot overwrite activity/health after a task switch.
- Filter buttons: All, Checkpoints, Todos, Decisions, Errors, Questions, Files, Commits, Commands.
- Health summary cards with explicit labels: passive capture enabled/disabled, shell integration available/unavailable, git available/unavailable, branch matches/mismatch/unknown.
- Render every `CaptureHealth` field: workspace root, current task target, last file capture, last command, last commit, unresolved error count, and all warnings. For absent last-known values, render `No file captures yet`, `No commands captured yet`, or `No commits captured yet`.
- Timeline rows as buttons only when `targetTab` exists; call `onNavigate({ tabId: item.targetTab, entityId: item.entityId })`.

- [ ] **Step 4: Add ContextPanel**

Implement `ContextPanel.tsx` with:
- Controlled numeric budget input defaulting to `4000`.
- `Preview context` button calling `context.preview`.
- `Copy context` button calling `context.copy` with the latest preview markdown.
- `Open as Markdown` button calling `context.open` with latest preview markdown.
- Plain `<pre>` preview. Do not render Markdown as HTML.
- Section summary list from `preview.sections`, including truncation notes such as `Commands: 10 included, 4 truncated`.
- A request-generation guard so a slow preview from an old task or old budget cannot replace the latest preview.

- [ ] **Step 5: Wire tabs in App**

In `App.tsx`:
- Extend `TabId` with `activity` and `context`.
- Add tabs after Overview: Activity, Context.
- Add navigation handler that switches tabs and sets `highlightId`.
- Clear panel-local highlights when changing tasks.

- [ ] **Step 6: Add host support for copy/open requests**

In Task 1 host files, add request types:
- `context.copy` payload `{ markdown: string }`
- `context.open` payload `{ markdown: string }`

Dispatcher should return `{ copied: true }` / `{ opened: true }` using injected deps:

```ts
copyText?: (text: string) => Promise<void> | void;
openMarkdown?: (title: string, markdown: string) => Promise<void> | void;
```

`panel.ts` later supplies VS Code clipboard/document behavior. Unit tests may inject sync fakes.
If `copyText` or `openMarkdown` throws/rejects, return the standard `{ ok: false, error }` response with the narrowed error message.

- [ ] **Step 7: Run tests**

Run:
```bash
cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx
cd ../ && pnpm vitest run test/webviewMessage.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/webview-ui/src/App.tsx packages/vscode-extension/webview-ui/src/panels/ActivityPanel.tsx packages/vscode-extension/webview-ui/src/panels/ContextPanel.tsx packages/vscode-extension/webview-ui/src/panels/OverviewPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx packages/vscode-extension/webview-ui/src/App.test.tsx
git commit -m "feat: add vscode activity and context panels"
```

---

### Task 3: VS Code Adapters for Clipboard, Markdown Preview, and Open File

**Files:**
- Modify: `packages/vscode-extension/src/webview/panel.ts`
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/test/panel.test.ts`
- Modify: `packages/vscode-extension/test/webviewMessage.test.ts`

**Interfaces:**
- Consumes:
  - `context.copy` and `context.open` from Task 2.
  - New `file.open` request payload `{ path: string }`.
- Produces panel deps:
  - `copyText(text: string): Promise<void>`
  - `openMarkdown(title: string, markdown: string): Promise<void>`
  - `openWorkspaceFile(relativePath: string): Promise<void>`
  - `resolveSelectedWorkspaceRoot(): string | undefined`

- [ ] **Step 1: Write failing panel adapter tests**

In `panel.test.ts`, add assertions that the message adapter supplies side-effect deps. Use the existing VS Code mock style and post a webview message:

```ts
it('copies context markdown through the VS Code clipboard adapter', async () => {
  const { panel, postedMessages, vscode } = await openPanelForTest();

  await panel.webview.receiveMessage({
    id: 'copy-1',
    type: 'context.copy',
    payload: { markdown: '# Handoff' },
  });

  expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('# Handoff');
  expect(postedMessages).toContainEqual(expect.objectContaining({ id: 'copy-1', ok: true }));
});

it('opens a captured workspace file by relative path', async () => {
  const { panel, vscode } = await openPanelForTest({ workspaceRoot: '/repo' });

  await panel.webview.receiveMessage({
    id: 'open-file-1',
    type: 'file.open',
    payload: { path: 'src/App.tsx' },
  });

  it('rejects invalid or missing captured file paths before opening', async () => {
    const { panel, postedMessages, vscode } = await openPanelForTest({ workspaceRoot: '/repo' });

    await panel.webview.receiveMessage({
      id: 'open-file-invalid',
      type: 'file.open',
      payload: { path: '../secret.txt' },
    });

    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(postedMessages).toContainEqual({
      id: 'open-file-invalid',
      ok: false,
      error: 'file.open requires a workspace-relative path.',
    });
  });

  expect(vscode.window.showTextDocument).toHaveBeenCalledWith(expect.objectContaining({ fsPath: '/repo/src/App.tsx' }), { preview: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vscode-extension && pnpm vitest run test/panel.test.ts`

Expected: FAIL because panel deps and `file.open` do not exist.

- [ ] **Step 3: Implement dispatcher validation**

Add `file.open` request:

```ts
| (WebviewRequestBase<'file.open'> & { payload: { path: string } })
```

Handler validates non-empty relative path and rejects absolute paths, Windows drive paths, `..` traversal, and normalized paths that escape the workspace with:
`file.open requires a workspace-relative path.`

Return `{ opened: true }` after calling `deps.openWorkspaceFile?.(path)`.

- [ ] **Step 4: Implement VS Code adapters in panel.ts**

Use:

```ts
copyText: (text) => vscode.env.clipboard.writeText(text),
openMarkdown: async (title, markdown) => {
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: markdown });
  await vscode.window.showTextDocument(doc, { preview: true });
},
openWorkspaceFile: async (relativePath) => {
  const root = selectedWorkspaceRoot ?? deps.resolveWorkspaceRoot();
  if (!root) throw new Error('No workspace root is selected.');
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('file.open requires a workspace-relative path.');
  await vscode.workspace.fs.stat(vscode.Uri.file(resolved));
  const uri = vscode.Uri.file(resolved);
  await vscode.window.showTextDocument(uri, { preview: true });
},
```

Ensure traversal validation happens before opening the file. A missing file should return a standard error response from the bridge; do not silently succeed.

- [ ] **Step 5: Run tests**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/panel.test.ts test/webviewMessage.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension/src/webview/panel.ts packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/test/panel.test.ts packages/vscode-extension/test/webviewMessage.test.ts
git commit -m "feat: add vscode webview host adapters"
```

---

### Task 4: Onboarding and Task Templates

**Files:**
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/test/webviewMessage.test.ts`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.test.tsx`

**Interfaces:**
- Produces:
  - `TaskTemplateId = 'feature' | 'bugfix' | 'review' | 'research' | 'incident'`
  - `TaskTemplate = { id: TaskTemplateId; label: string; description: string; todos: string[]; questions: string[]; decisions?: Array<{ text: string; rationale?: string }> }`
  - request type `task.createFromTemplate` payload `{ title: string; goal?: string | null; templateId: TaskTemplateId }`
  - success data `{ task: Task; seeded: { todos: number; questions: number; decisions: number } }` plus fresh `WebviewState`

- [ ] **Step 1: Write failing template dispatcher test**

Add:

```ts
it('creates a task from a built-in template and seeds its entities', () => {
  const store = new TaskStore(':memory:');

  const response = handleWebviewMessage(
    { store, workspaceRoot: '/repo', setCurrentTaskId: vi.fn() },
    { id: 'template', type: 'task.createFromTemplate', payload: { title: 'Fix login bug', goal: 'Resolve auth regression', templateId: 'bugfix' } },
  );

  expect(response.ok).toBe(true);
  const created = (response as { ok: true; data: { task: Task } }).data.task;
  expect(created.title).toBe('Fix login bug');
  expect(store.listTodos(created.id).map((todo) => todo.text)).toEqual(
    expect.arrayContaining(['Reproduce the bug', 'Add regression coverage', 'Verify the fix']),
  );
  expect(store.listOpenQuestions(created.id).map((question) => question.text)).toEqual(
    expect.arrayContaining(['What exact user-visible behavior is broken?']),
  );
  expect(store.getCurrentTaskId()).toBe(created.id);
  store.close();
});

it('surfaces template seeding failure with the created task state', () => {
  const store = new TaskStore(':memory:');
  const createTodo = vi.spyOn(store, 'createTodo').mockImplementationOnce(() => {
    throw new Error('seed write failed');
  });

  const response = handleWebviewMessage(
    { store, workspaceRoot: '/repo', setCurrentTaskId: vi.fn() },
    { id: 'template-fail', type: 'task.createFromTemplate', payload: { title: 'Broken seed', templateId: 'feature' } },
  );

  expect(response).toMatchObject({
    id: 'template-fail',
    ok: false,
    error: expect.stringContaining('Task was created but template seeding failed'),
    state: expect.objectContaining({ currentTask: expect.objectContaining({ title: 'Broken seed' }) }),
  });
  createTodo.mockRestore();
  store.close();
});
```

- [ ] **Step 2: Write failing onboarding/template UI test**

In `App.test.tsx`, render with an empty state:

```tsx
it('shows onboarding when no task exists and creates a templated task', async () => {
  const request = vi.fn(async (type: string, payload?: unknown) => payload ?? {});
  render(<App bridge={{ request, subscribe: vi.fn(() => () => undefined) }} initialState={{ ...baseState, currentTaskId: undefined, currentTask: undefined, tasks: [] }} />);

  expect(screen.getByText('Start your first Ariadne task')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import or sync tasks' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open context help' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await userEvent.type(screen.getByLabelText('New task title'), 'Fix login bug');
  await userEvent.selectOptions(screen.getByLabelText('Task template'), 'bugfix');
  await userEvent.click(screen.getByRole('button', { name: 'Create task from template' }));

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('task.createFromTemplate', {
      title: 'Fix login bug',
      goal: null,
      templateId: 'bugfix',
    }),
  );
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
cd webview-ui && pnpm vitest run src/App.test.tsx
```

- [ ] **Step 4: Implement template constants and host handler**

Define `TaskTemplates` in `messages.ts` or a small `src/webview/taskTemplates.ts` imported by dispatcher and type-exported to the webview. Use exact built-ins:

```ts
feature: {
  todos: ['Clarify acceptance criteria', 'Implement the smallest complete change', 'Add or update tests', 'Update related docs'],
  questions: ['What user-visible behavior defines success?'],
}
bugfix: {
  todos: ['Reproduce the bug', 'Add regression coverage', 'Verify the fix'],
  questions: ['What exact user-visible behavior is broken?'],
}
review: {
  todos: ['Inspect the relevant diff', 'Run targeted validation', 'Document findings or approval'],
  questions: ['What risk should this review focus on?'],
}
research: {
  todos: ['Map existing implementation', 'Compare viable approaches', 'Record recommendation'],
  questions: ['What decision should this research unblock?'],
}
incident: {
  todos: ['Capture symptoms and impact', 'Identify root cause', 'Record mitigation and follow-up'],
  questions: ['Who or what is currently impacted?'],
}
```

The handler creates the task, seeds todos/questions/decisions, sets it current, and returns state. If seeding fails after task creation, return `{ ok: false, error: 'Task was created but template seeding failed: ...' }` and still include state if current code supports it; do not silently report success.
Do not attempt a database transaction unless `TaskStore` already exposes one. The explicit contract for this batch is recoverable partial creation: task creation remains visible/current, the error states exactly that seeding failed, and the returned state lets the UI show the partially created task.

- [ ] **Step 5: Implement onboarding and template selection**

In `App.tsx`:
- Show an onboarding card when `state.tasks.length === 0 || !state.currentTask`.
- Add buttons `Import or sync tasks` and `Open context help`; the first switches to the Sync tab, the second switches to the Context tab. They do not create tasks.
- Add a `Task template` select to the create-task form with `none`, `feature`, `bugfix`, `review`, `research`, `incident`.
- If template is `none`, call existing `task.create`.
- Otherwise call `task.createFromTemplate`.

- [ ] **Step 6: Run tests**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
cd webview-ui && pnpm vitest run src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/test/webviewMessage.test.ts packages/vscode-extension/webview-ui/src/App.tsx packages/vscode-extension/webview-ui/src/App.test.tsx
git commit -m "feat: add vscode onboarding and task templates"
```

---

### Task 5: Review Mode and Completion Checklist

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/ReviewPanel.tsx`
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/test/webviewMessage.test.ts`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

**Interfaces:**
- Produces:
  - `ReviewCheck = { id: string; label: string; status: 'pass' | 'warning' | 'fail' | 'unknown'; detail: string; action?: { label: string; tabId?: WebviewTabId; entityId?: string } }`
  - `ReviewSummary = { taskId: string; checks: ReviewCheck[]; canMarkDone: boolean }`
  - request type `review.get`

- [ ] **Step 1: Write failing review dispatcher test**

```ts
it('reports review checks before task completion', () => {
  const { store, task } = makeStore();
  store.createTodo({ taskId: task.id, text: 'Blocked item', status: 'blocked' });

  const response = handleWebviewMessage(
    { store, currentTaskId: task.id, workspaceRoot: '/repo' },
    { id: 'review', type: 'review.get' },
  );

  expect(response.ok).toBe(true);
  expect(response.data).toMatchObject({
    review: {
      taskId: task.id,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'pending-todos', status: 'fail' }),
        expect.objectContaining({ id: 'unresolved-errors', status: 'fail' }),
        expect.objectContaining({ id: 'open-questions', status: 'warning' }),
        expect.objectContaining({ id: 'recent-checkpoint', status: 'pass' }),
        expect.objectContaining({ id: 'sync-status', status: 'unknown' }),
        expect.objectContaining({ id: 'export-status', status: 'unknown' }),
      ]),
      canMarkDone: false,
    },
  });
  store.close();
});
```

- [ ] **Step 2: Write failing ReviewPanel test**

```tsx
it('shows review checks and can mark the task done from review mode', async () => {
  const harness = createBridge({
    request: vi.fn(async (type: string, payload?: unknown) => {
      if (type === 'review.get') {
        return {
          review: {
            taskId: task.id,
            canMarkDone: true,
            checks: [
              { id: 'pending-todos', label: 'Pending todos', status: 'pass', detail: 'No pending todos.' },
              { id: 'sync-status', label: 'Sync status', status: 'unknown', detail: 'No sync action has run in this panel session.' },
            ],
          },
        };
      }
      return payload ?? {};
    }) as BridgeHarness['request'],
  });

  render(<ReviewPanel bridge={harness} taskId={task.id} onBusy={() => undefined} onError={() => undefined} />);

  expect(await screen.findByText('Pending todos')).toBeInTheDocument();
  expect(screen.getByText('No sync action has run in this panel session.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mark task done' }));
  await waitFor(() => expect(harness.request).toHaveBeenCalledWith('task.setStatus', { id: task.id, status: 'done' }));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx
```

- [ ] **Step 4: Implement review builder**

Rules:
- `pending-todos`: fail when blocked todos exist, warning when pending todos exist, pass when none.
- `unresolved-errors`: fail when unresolved errors exist, pass when none.
- `open-questions`: warning when open questions exist, pass when none.
- `recent-checkpoint`: pass when at least one checkpoint exists, warning otherwise.
- `branch-match`: pass when `deps.passiveCapture.currentBranch` equals `task.branch`, fail when both are set and differ, unknown when either value is absent.
- `sync-status`: unknown unless `deps.sessionStatus?.lastSyncPush` or `lastSyncPull` exists.
- `export-status`: unknown unless `deps.sessionStatus?.lastExport` exists.
- `canMarkDone` is false when any check has status `fail`.

- [ ] **Step 5: Implement ReviewPanel and App tab**

Add `review` to `TabId`, tabs, and switch. `ReviewPanel` loads `review.get` on mount and whenever `taskId` changes; use the same request-generation guard as Activity/Context panels so stale review data cannot overwrite the selected task. Render check status badges, offer action buttons for tab navigation where present, and show `Mark task done` when `review.canMarkDone` is true. If `canMarkDone` is false, render `Resolve blocking checks first`.

- [ ] **Step 6: Run tests**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/test/webviewMessage.test.ts packages/vscode-extension/webview-ui/src/App.tsx packages/vscode-extension/webview-ui/src/panels/ReviewPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx
git commit -m "feat: add vscode task review mode"
```

---

### Task 6: Files and Search Navigation Polish

**Files:**
- Modify: `packages/vscode-extension/webview-ui/src/panels/FilesPanel.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/SearchPanel.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

**Interfaces:**
- Consumes:
  - `bridge.request('file.open', { path })`
  - `onNavigate(hit)` from `SearchPanel`
- Produces:
  - File filters by path/trigger/status.
  - Open-file action for capture entries.
  - Search click-through for file and commit hits to Files tab.

- [ ] **Step 1: Write failing Files/Search tests**

```tsx
it('filters captured files and opens an existing captured file', async () => {
  const harness = createBridge();
  render(<FilesPanel bridge={harness} captures={captures} highlightPath="src/App.tsx" />);

  await userEvent.type(screen.getByRole('textbox', { name: 'Filter captured files' }), 'App');
  expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Open src/App.tsx' }));

  await waitFor(() => expect(harness.request).toHaveBeenCalledWith('file.open', { path: 'src/App.tsx' }));
});

it('labels file and commit search hits as navigable to Files', async () => {
  const onNavigate = vi.fn();
  const harness = createBridge();
  render(<SearchPanel bridge={harness} initialResults={searchResults} onNavigate={onNavigate} />);

  await userEvent.click(screen.getByRole('button', { name: /Open file src\/App.tsx/i }));

  expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ category: 'file', id: 'src/App.tsx' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx`

- [ ] **Step 3: Implement FilesPanel filters and open action**

Add:
- Text input labeled `Filter captured files`.
- Trigger select with `all`, `explicit`, `checkpoint`, `commit`; status select with `all`, `captured`, `failed`, `synced`, derived client-side from each capture's `trigger`, `failedAt`, and `syncedAt` fields.
- Highlight by `highlightPath` or `highlightCaptureId`.
- Highlight commit hits by finding the first capture whose `gitCommitSha` equals `highlightCommitSha`; if no capture exists, render `No file capture found for commit <sha>`.
- Each entry row gets `Open <path>` button calling `file.open`.
- Empty states: `No captures match this filter.` and `No file captures for this task yet.`

- [ ] **Step 4: Implement SearchPanel labels and App navigation**

For file hits, render button label `Open file <path>`. For commit hits, render `Open commit <sha>`. In `App.tsx`, when navigating to `file` or `commit`, set active tab to `files` and pass the hit id as `highlightPath` or `highlightCommitSha` into `FilesPanel`.

- [ ] **Step 5: Run tests**

Run: `cd packages/vscode-extension/webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-extension/webview-ui/src/App.tsx packages/vscode-extension/webview-ui/src/panels/FilesPanel.tsx packages/vscode-extension/webview-ui/src/panels/SearchPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx
git commit -m "feat: polish vscode files and search navigation"
```

---

### Task 7: Graphify Webview Tab

**Files:**
- Create: `packages/vscode-extension/webview-ui/src/panels/GraphifyPanel.tsx`
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/src/webview/panel.ts`
- Modify: `packages/vscode-extension/test/webviewMessage.test.ts`
- Modify: `packages/vscode-extension/webview-ui/src/App.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

**Interfaces:**
- Consumes core helpers in the host adapter:
  - `isGraphifyInstalled()`
  - `runGraphifySync(args, { cwd })`
  - `summarizeGraphifyRun(args, result)`
  - `GRAPHIFY_INSTALL_HINT`
- Produces:
  - `GraphifyRequestPayload = { mode: 'update' | 'query' | 'path' | 'explain'; query?: string; from?: string; to?: string; target?: string }`
  - `GraphifyRunResult = { available: boolean; args: string[]; output: string; exitCode: number; checkpointSummary?: string; truncated: boolean }`
  - request type `graphify.run`

- [ ] **Step 1: Write failing dispatcher test with injected Graphify runner**

```ts
it('runs graphify through an injected host action and records a checkpoint', () => {
  const { store, task } = makeStore();
  const runGraphify = vi.fn(() => ({
    available: true,
    args: ['query', 'how does auth work'],
    output: 'Auth uses middleware.',
    exitCode: 0,
    checkpointSummary: 'Graphify query completed: how does auth work',
    truncated: false,
  }));

  const response = handleWebviewMessage(
    { store, currentTaskId: task.id, workspaceRoot: '/repo', graphify: { run: runGraphify } },
    { id: 'graphify', type: 'graphify.run', payload: { mode: 'query', query: 'how does auth work' } },
  );

  expect(response.ok).toBe(true);
  expect(runGraphify).toHaveBeenCalledWith({ mode: 'query', query: 'how does auth work' }, '/repo');
  expect(response.data).toMatchObject({ result: { available: true, output: 'Auth uses middleware.', exitCode: 0, truncated: false } });
  expect(store.listCheckpoints(task.id).some((checkpoint) => checkpoint.summary.includes('Graphify query completed'))).toBe(true);
  store.close();
});

it('does not checkpoint failed graphify runs', () => {
  const { store, task } = makeStore();
  const before = store.listCheckpoints(task.id).length;
  const response = handleWebviewMessage(
    {
      store,
      currentTaskId: task.id,
      workspaceRoot: '/repo',
      graphify: { run: vi.fn(() => ({ available: true, args: ['query', 'bad'], output: 'boom', exitCode: 1, checkpointSummary: 'Graphify failed', truncated: false })) },
    },
    { id: 'graphify-fail', type: 'graphify.run', payload: { mode: 'query', query: 'bad' } },
  );

  expect(response.ok).toBe(true);
  expect(store.listCheckpoints(task.id)).toHaveLength(before);
  store.close();
});
```

- [ ] **Step 2: Write failing GraphifyPanel test**

```tsx
it('runs a graphify query and displays bounded output', async () => {
  const harness = createBridge({
    request: vi.fn(async (type: string) => {
      if (type === 'graphify.run') {
        return { result: { available: true, args: ['query', 'how does auth work'], output: 'Auth uses middleware.', exitCode: 0, truncated: false } };
      }
      return {};
    }) as BridgeHarness['request'],
  });

  render(<GraphifyPanel bridge={harness} onBusy={() => undefined} onError={() => undefined} />);

  await userEvent.click(screen.getByRole('tab', { name: 'Query' }));
  await userEvent.type(screen.getByLabelText('Graphify query'), 'how does auth work');
  await userEvent.click(screen.getByRole('button', { name: 'Run query' }));

  expect(await screen.findByText('Auth uses middleware.')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx
```

- [ ] **Step 4: Implement host Graphify contract**

Add dispatcher dependency:

```ts
graphify?: {
  run: (payload: GraphifyRequestPayload, workspaceRoot?: string) => GraphifyRunResult;
}
```

Dispatcher validates payload shape only; the panel adapter owns argv construction so the dispatcher can be unit-tested with an injected runner. The adapter maps:
- `update`: `['update', '.']` with `cwd` set to the selected workspace root.
- `query`: requires `query`.
- `path`: requires `from` and `to`.
- `explain`: requires `target`.

If `result.exitCode === 0`, `result.checkpointSummary` is present, and current task exists, create a micro checkpoint with that summary. Never checkpoint failed or unavailable runs.

- [ ] **Step 5: Implement panel Graphify adapter**

In `panel.ts`, provide `graphify.run` using core helpers:
- If unavailable, return `{ available: false, args: [], output: GRAPHIFY_INSTALL_HINT, exitCode: 127, truncated: false }`.
- Build args from payload.
- Run `runGraphifySync(args, { cwd: workspaceRoot })`.
- Log full output to output channel.
- Return trimmed output; cap panel output to a reasonable string length such as 20,000 characters with a truncation suffix.

- [ ] **Step 6: Implement GraphifyPanel and App tab**

Add `graphify` tab. Panel has sub-tabs/buttons for Update, Query, Path, Explain. Render install hint when `available === false`. Render raw output in `<pre>`.

- [ ] **Step 7: Run tests**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/webviewMessage.test.ts test/panel.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx src/App.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/src/webview/panel.ts packages/vscode-extension/test/webviewMessage.test.ts packages/vscode-extension/webview-ui/src/App.tsx packages/vscode-extension/webview-ui/src/panels/GraphifyPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx
git commit -m "feat: add graphify vscode webview tab"
```

---

### Task 8: Sync Profile and Status UI

**Files:**
- Modify: `packages/vscode-extension/src/syncCommands.ts`
- Modify: `packages/vscode-extension/test/syncCommands.test.ts`
- Modify: `packages/vscode-extension/src/webview/messages.ts`
- Modify: `packages/vscode-extension/src/webview/handleWebviewMessage.ts`
- Modify: `packages/vscode-extension/src/webview/panel.ts`
- Modify: `packages/vscode-extension/webview-ui/src/panels/SyncPanel.tsx`
- Modify: `packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx`

**Interfaces:**
- Produces:
  - `syncProfileList(options: SyncCliOptions): string` wrapping `ariadne sync profile list`.
  - `parseSyncProfiles(output: string): SyncProfile[]`
  - `SyncProfile = { name: string; current: boolean; serverUrl?: string }`
  - request type `sync.profileList`
  - panel-session status: last push/pull/list/profile result and failures, stored in React state. Do not wire this into `review.get` in this batch; `review.get` keeps sync/export checks as `unknown` unless a later task adds explicit persisted evidence.

- [ ] **Step 1: Write failing sync profile parser tests**

In `syncCommands.test.ts`:

```ts
it('runs sync profile list through the CLI wrapper', () => {
  const run = vi.fn(() => '* default https://sync.example\n  staging https://staging.example\n');
  expect(syncProfileList({ cwd: '/repo', runCommand: run })).toContain('default');
  expect(run).toHaveBeenCalledWith(['sync', 'profile', 'list'], '/repo');
});

it('parses current and non-current sync profiles from line-oriented output', () => {
  expect(parseSyncProfiles('* default https://sync.example\n  staging https://staging.example\n')).toEqual([
    { name: 'default', current: true, serverUrl: 'https://sync.example' },
    { name: 'staging', current: false, serverUrl: 'https://staging.example' },
  ]);
});
```

If `runAriadneSyncCli` is not injectable today, first refactor it to an exported dependency-friendly helper while keeping current public wrappers unchanged.

- [ ] **Step 2: Write failing SyncPanel test**

```tsx
it('loads sync profiles and labels auth failures with setup guidance', async () => {
  const harness = createBridge({
    request: vi.fn(async (type: string) => {
      if (type === 'sync.profileList') {
        return { profiles: [{ name: 'default', current: true, serverUrl: 'https://sync.example' }], output: '* default https://sync.example' };
      }
      if (type === 'sync.push') {
        throw new Error('ariadne sync push failed: not logged in');
      }
      return {};
    }) as BridgeHarness['request'],
  });

  render(<SyncPanel bridge={harness} />);

  expect(await screen.findByText('default')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Push local changes' }));
  expect(await screen.findByText(/Run ariadne sync login/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/syncCommands.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx
```

- [ ] **Step 4: Implement sync profile wrapper/parser**

Keep existing `syncPush`, `syncPull`, `syncListRemote` signatures compatible. Add:

```ts
export function syncProfileList(options: SyncCliOptions): string {
  const args = ['sync', 'profile', 'list'];
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneSyncCli(args, options.cwd);
}
```

`parseSyncProfiles` only parses simple profile rows:

```ts
const PROFILE_ROW = /^(\*)?\s*([A-Za-z0-9._-]+)(?:\s+(https?:\/\/\S+))?\s*$/;
```

Ignore blank lines, headers, status prose, and malformed rows. If multiple rows are marked current, keep all rows but let the UI render `Multiple current profiles reported` as a warning.

- [ ] **Step 5: Add dispatcher and panel adapter**

Add `sync.profileList` request. Dispatcher calls injected `sync.profileList` and parses profiles. `panel.ts` injects the wrapper using selected workspace root. Errors should return `{ ok: false, error }` through the existing bridge path.

- [ ] **Step 6: Polish SyncPanel**

On mount, request `sync.profileList`. Existing bridge behavior rejects failed requests as thrown errors in the React client; tests should model that production `bridge.request` behavior. Render:
- Current profile card.
- Other profiles list.
- Auth/setup hint when error text includes `not logged in`, `login`, `profile`, or `config`.
- Raw output disclosure area for push/pull/list/profile commands. Existing push/pull/list responses already return `{ output }`; store that exact output in panel state after every action.
- Distinguish failed/completed action statuses; preserve the prior failure-label fix.

- [ ] **Step 7: Run tests**

Run:
```bash
cd packages/vscode-extension && pnpm vitest run test/syncCommands.test.ts test/webviewMessage.test.ts test/panel.test.ts
cd webview-ui && pnpm vitest run src/panels/UtilityPanels.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/vscode-extension/src/syncCommands.ts packages/vscode-extension/test/syncCommands.test.ts packages/vscode-extension/src/webview/messages.ts packages/vscode-extension/src/webview/handleWebviewMessage.ts packages/vscode-extension/src/webview/panel.ts packages/vscode-extension/webview-ui/src/panels/SyncPanel.tsx packages/vscode-extension/webview-ui/src/panels/UtilityPanels.test.tsx
git commit -m "feat: add vscode sync profile status"
```

---

### Task 9: Documentation, Changelog, Reviews, Package, and Install

**Files:**
- Modify: `packages/vscode-extension/README.md`
- Modify: `packages/vscode-extension/CHANGELOG.md`
- Optional separate fix: `packages/vscode-extension/package.json`, `packages/vscode-extension/test/extension.test.ts`, `packages/vscode-extension/resources/activitybar.svg`

**Interfaces:**
- Consumes all previous task outputs.
- Produces final reviewed and installed VSIX.

- [ ] **Step 1: Update README and changelog**

Document:
- Activity Timeline tab.
- Capture Health.
- Context Handoff.
- First-run onboarding.
- Task templates.
- Review mode.
- Files/Search polish.
- Graphify tab.
- Sync profile/status UI.

- [ ] **Step 2: Decide SVG Activity Bar icon hardening**

If keeping the already-tested uncommitted SVG hardening, commit it separately:

```bash
git add packages/vscode-extension/package.json packages/vscode-extension/test/extension.test.ts packages/vscode-extension/resources/activitybar.svg
git commit -m "fix: use svg activity bar icon"
```

If not keeping it, revert only those pre-existing uncommitted changes after confirming they were not touched by feature work.

- [ ] **Step 3: Run targeted and full validation**

Run:

```bash
cd packages/vscode-extension
pnpm vitest run test/webviewMessage.test.ts test/panel.test.ts test/syncCommands.test.ts test/extension.test.ts
cd webview-ui
pnpm vitest run
pnpm exec tsc --noEmit
cd ..
pnpm test
pnpm run build
pnpm run package
```

Expected:
- Host tests pass.
- Webview tests pass.
- Webview strict type-check passes.
- Build/package produces `packages/vscode-extension/ariadne-vscode-0.1.0.vsix`.

- [ ] **Step 4: Run whole-change reviews**

Run two read-only review agents from the repository root:

```text
TypeScript Reviewer: review the diff from 2185997..HEAD for TypeScript/Node/VS Code extension correctness, type-safety, async error handling, and security regressions. Report only high-confidence findings with file/line and concrete fix guidance.

React Reviewer: review the diff from 2185997..HEAD for React hook correctness, stale state, accessibility, webview UX regressions, and unsafe rendering. Report only high-confidence findings with file/line and concrete fix guidance.
```

Acceptance criteria:
- Every high-confidence correctness/security/type-safety finding is fixed or explicitly documented as not applicable with evidence.
- Re-run the smallest affected test command after each fix.
- Re-run the full validation command block from Step 3 before packaging is considered final.

- [ ] **Step 5: Verify VSIX contents**

Run:

```bash
cd packages/vscode-extension
VSIX="$(node -p "const p=require('./package.json'); `${p.name}-${p.version}.vsix`")"
node -e "const fs=require('fs'); const f=process.argv[1]; if(!fs.existsSync(f)) process.exit(1); console.log(f)" "$VSIX"
unzip -l "$VSIX" | grep -E 'extension/dist/extension.js|extension/dist/webview|extension/package.json'
```

Expected: extension bundle and webview assets are present.

- [ ] **Step 6: Install final VSIX into VS Code Server**

Try the CLI first:

```bash
cd packages/vscode-extension
VSIX="$(node -p "const p=require('./package.json'); `${p.name}-${p.version}.vsix`")"
env -u VSCODE_IPC_HOOK_CLI code --install-extension "$VSIX" --force
```

If the remote CLI is unavailable or IPC is stale, use the previously verified manual install pattern:

```bash
cd packages/vscode-extension
VSIX="$(node -p "const p=require('./package.json'); `${p.name}-${p.version}.vsix`")"
tmpdir="$(mktemp -d)"
unzip -q "$VSIX" -d "$tmpdir"
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if(p.publisher!=='ariadne-dev' || p.name!=='ariadne-vscode') process.exit(1);" "$tmpdir/extension/package.json"
test -f "$tmpdir/extension/dist/extension.js"
test -d "$tmpdir/extension/dist/webview"
backup="$HOME/.vscode-server/extension-backups/ariadne-dev.ariadne-vscode-0.1.0.backup-$(date +%Y%m%d%H%M%S)"
mkdir -p "$HOME/.vscode-server/extension-backups"
if [ -d "$HOME/.vscode-server/extensions/ariadne-dev.ariadne-vscode-0.1.0" ]; then
  mv "$HOME/.vscode-server/extensions/ariadne-dev.ariadne-vscode-0.1.0" "$backup"
fi
if ! mv "$tmpdir/extension" "$HOME/.vscode-server/extensions/ariadne-dev.ariadne-vscode-0.1.0"; then
  if [ -d "$backup" ]; then mv "$backup" "$HOME/.vscode-server/extensions/ariadne-dev.ariadne-vscode-0.1.0"; fi
  rm -rf "$tmpdir"
  exit 1
fi
rm -rf "$tmpdir"
```

- [ ] **Step 7: Verify installed manifest**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync(`${process.env.HOME}/.vscode-server/extensions/ariadne-dev.ariadne-vscode-0.1.0/package.json`, 'utf8'));
console.log(pkg.contributes.commands.map((c) => c.command).filter((c) => c.startsWith('ariadne.')).join('\n'));
console.log(JSON.stringify(pkg.contributes.viewsContainers ?? {}, null, 2));
NODE
```

Expected: `ariadne.openPanel`, `ariadne.graphify`, sync commands, and Activity Bar contributions are present.
`ariadne.graphify` is an existing command contribution; Tasks 7-8 add webview tabs/requests but do not add new manifest commands.

- [ ] **Step 8: Commit docs**

```bash
git add packages/vscode-extension/README.md packages/vscode-extension/CHANGELOG.md
git commit -m "docs: update vscode product polish docs"
```

If review fixes changed code, commit those fixes before the docs commit with a `fix:` message that describes the bug.

---

## Self-Review Checklist

- Spec coverage:
  - Activity Timeline: Tasks 1-2.
  - Capture Health: Tasks 1-2.
  - Context Handoff: Tasks 1-3.
  - Onboarding: Task 4.
  - Task Templates: Task 4.
  - Review Mode: Task 5.
  - Files/Search polish: Task 6.
  - Graphify tab: Task 7.
  - Sync profile/status UI: Task 8.
  - Docs/review/package/install: Task 9.
- Type consistency:
  - `WebviewTabId`, `ActivityItem`, `CaptureHealth`, `ContextPreview`, `ReviewSummary`, and `GraphifyRunResult` are introduced before use.
  - Host side-effect functions are injected through dispatcher deps and supplied by `panel.ts`.
  - React panels depend only on `AriadneBridge` and typed host DTOs.
- Validation:
  - Every task has a failing-test step, implementation step, passing-test step, and commit step.
  - Final validation includes host tests, webview tests, webview type-check, build, package, review, and install.
