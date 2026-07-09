import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Fake `vscode` surface covering the bits workspace.ts needs for multi-root
// resolution: workspaceFolders, activeTextEditor, getWorkspaceFolder,
// showQuickPick, showWarningMessage/showInformationMessage, and a fake
// workspaceState (in-memory Map) for the persisted-selection path.
let workspaceFolders: { name: string; uri: { fsPath: string } }[] | undefined;
let activeDocumentPath: string | undefined;
let quickPickAnswer: { label: string; description: string; folder: unknown } | undefined;
const warnings: string[] = [];
const infos: string[] = [];

vi.mock('vscode', () => {
  return {
    window: {
      get activeTextEditor() {
        return activeDocumentPath ? { document: { uri: { fsPath: activeDocumentPath } } } : undefined;
      },
      showWarningMessage: (msg: string) => {
        warnings.push(msg);
      },
      showInformationMessage: (msg: string) => {
        infos.push(msg);
      },
      showQuickPick: async () => quickPickAnswer,
    },
    workspace: {
      get workspaceFolders() {
        return workspaceFolders;
      },
      getWorkspaceFolder: (uri: { fsPath: string }) =>
        workspaceFolders?.find((f) => uri.fsPath.startsWith(f.uri.fsPath)),
    },
  };
});

function makeContext() {
  const store = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string) => store.get(key),
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as never;
}

describe('multi-root workspace resolution', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    vi.resetModules();
    warnings.length = 0;
    infos.length = 0;
    quickPickAnswer = undefined;
    activeDocumentPath = undefined;
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ws-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-ws-b-'));
    fs.mkdirSync(path.join(dirA, '.git'));
    fs.mkdirSync(path.join(dirB, '.git'));
  });

  afterEach(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('resolves the single folder unchanged when only one is open', async () => {
    workspaceFolders = [{ name: 'A', uri: { fsPath: dirA } }];
    const ws = await import('../src/workspace.js');
    ws.initWorkspaceResolution(makeContext());
    expect(ws.resolveWorkspaceRoot()).toBe(dirA);
    expect(warnings).toHaveLength(0);
  });

  it('resolves via the active editor folder when multiple are open', async () => {
    workspaceFolders = [
      { name: 'A', uri: { fsPath: dirA } },
      { name: 'B', uri: { fsPath: dirB } },
    ];
    activeDocumentPath = path.join(dirB, 'file.ts');
    const ws = await import('../src/workspace.js');
    ws.initWorkspaceResolution(makeContext());
    expect(ws.resolveWorkspaceRoot()).toBe(dirB);
    expect(warnings).toHaveLength(0);
  });

  it('prefers a persisted explicit selection over the active editor', async () => {
    workspaceFolders = [
      { name: 'A', uri: { fsPath: dirA } },
      { name: 'B', uri: { fsPath: dirB } },
    ];
    activeDocumentPath = path.join(dirB, 'file.ts');
    quickPickAnswer = { label: 'A', description: dirA, folder: workspaceFolders[0] };

    const ws = await import('../src/workspace.js');
    const context = makeContext();
    ws.initWorkspaceResolution(context);
    await ws.promptSelectWorkspaceFolder();
    expect(infos.some((m) => /now tracking "A"/.test(m))).toBe(true);
    expect(ws.resolveWorkspaceRoot()).toBe(dirA);
  });

  it('falls back to the first folder with a one-time warning when nothing else resolves it', async () => {
    workspaceFolders = [
      { name: 'A', uri: { fsPath: dirA } },
      { name: 'B', uri: { fsPath: dirB } },
    ];
    const ws = await import('../src/workspace.js');
    ws.initWorkspaceResolution(makeContext());

    expect(ws.resolveWorkspaceRoot()).toBe(dirA);
    expect(ws.resolveWorkspaceRoot()).toBe(dirA);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/multiple workspace folders/i);
  });
});
