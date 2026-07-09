import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findWorkspaceRoot, stateDbPath, readCurrentTaskId, setCurrentTaskId } from '../src/workspace.js';

describe('workspace resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-core-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds the nearest ancestor with a .git directory', () => {
    const repoRoot = path.join(tmpDir, 'repo');
    const nested = path.join(repoRoot, 'src', 'deep');
    fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });

    expect(findWorkspaceRoot(nested)).toBe(repoRoot);
  });

  it('falls back to the start directory when no .git or .ariadne is found', () => {
    const isolated = path.join(tmpDir, 'no-git-here');
    fs.mkdirSync(isolated, { recursive: true });

    expect(findWorkspaceRoot(isolated)).toBe(isolated);
  });

  it('computes the state db path under .ariadne/state.db', () => {
    expect(stateDbPath(tmpDir)).toBe(path.join(tmpDir, '.ariadne', 'state.db'));
  });

  it('persists and reads back the current task id', () => {
    expect(readCurrentTaskId(tmpDir)).toBeUndefined();
    setCurrentTaskId('01ABCXYZ', tmpDir);
    expect(readCurrentTaskId(tmpDir)).toBe('01ABCXYZ');
  });

  it('migrates a legacy current-task flat file into the DB and removes it', () => {
    // Simulate a workspace left behind by a pre-SQLite-current-task version.
    fs.mkdirSync(path.join(tmpDir, '.ariadne'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.ariadne', 'current-task'), '01LEGACYTASK', 'utf8');

    expect(readCurrentTaskId(tmpDir)).toBe('01LEGACYTASK');
    expect(fs.existsSync(path.join(tmpDir, '.ariadne', 'current-task'))).toBe(false);
    // Subsequent reads come from the DB now, without needing the file.
    expect(readCurrentTaskId(tmpDir)).toBe('01LEGACYTASK');
  });

  it('prefers the DB value over a stale legacy file if both somehow exist', () => {
    setCurrentTaskId('01DBTASK', tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.ariadne', 'current-task'), '01STALETASK', 'utf8');

    expect(readCurrentTaskId(tmpDir)).toBe('01DBTASK');
    expect(fs.existsSync(path.join(tmpDir, '.ariadne', 'current-task'))).toBe(false);
  });
});
