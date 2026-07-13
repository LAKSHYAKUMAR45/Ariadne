import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/TaskStore.js';
import { getHeadSha, getCurrentBranch, listRecentCommits, syncTaskGit } from '../src/GitWatcher.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

function commit(dir: string, filename: string, message: string): string {
  fs.writeFileSync(path.join(dir, filename), `${filename}\n`);
  git(['add', filename], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

describe('GitWatcher', () => {
  let repoRoot: string;
  let store: TaskStore;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-gitwatcher-test-'));
    initRepo(repoRoot);
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns null for a non-git directory', () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-not-a-repo-'));
    try {
      expect(getHeadSha(notARepo)).toBeNull();
      expect(getCurrentBranch(notARepo)).toBeNull();
      expect(listRecentCommits(notARepo)).toEqual([]);
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('reads the current HEAD sha and branch', () => {
    const sha = commit(repoRoot, 'a.txt', 'First commit');
    expect(getHeadSha(repoRoot)).toBe(sha);
    expect(getCurrentBranch(repoRoot)).toBe('main');
  });

  it('lists recent commits newest-first', () => {
    const sha1 = commit(repoRoot, 'a.txt', 'First commit');
    const sha2 = commit(repoRoot, 'b.txt', 'Second commit');
    const log = listRecentCommits(repoRoot);
    expect(log).toEqual([
      { sha: sha2, message: 'Second commit' },
      { sha: sha1, message: 'First commit' },
    ]);
  });

  it('syncTaskGit records new commits oldest-first and dedupes already-recorded ones', () => {
    const task = store.createTask({ title: 'A' });
    const sha1 = commit(repoRoot, 'a.txt', 'First commit');
    const sha2 = commit(repoRoot, 'b.txt', 'Second commit');

    const result = syncTaskGit(store, task.id, repoRoot);
    expect(result.recordedCommits.map((c) => c.sha)).toEqual([sha1, sha2]);

    const stored = store.listCommits(task.id);
    expect(stored.map((c) => c.sha).sort()).toEqual([sha1, sha2].sort());

    // Calling again with no new commits should record nothing further.
    const second = syncTaskGit(store, task.id, repoRoot);
    expect(second.recordedCommits).toEqual([]);
    expect(store.listCommits(task.id)).toHaveLength(2);
  });

  it('syncTaskGit updates the task branch when it changes', () => {
    commit(repoRoot, 'a.txt', 'First commit');
    const task = store.createTask({ title: 'A', branch: 'main' });

    git(['checkout', '-q', '-b', 'feature/x'], repoRoot);
    const result = syncTaskGit(store, task.id, repoRoot);
    expect(result.branchChanged).toBe(true);
    expect(result.newBranch).toBe('feature/x');
    expect(store.getTask(task.id)!.branch).toBe('feature/x');

    // No further change -> branchChanged false on subsequent calls.
    const second = syncTaskGit(store, task.id, repoRoot);
    expect(second.branchChanged).toBe(false);
  });

  it('throws for an unknown task', () => {
    expect(() => syncTaskGit(store, 'nope', repoRoot)).toThrow(/No task found/);
  });

  it('does not crash when a commit is already recorded against a different task (shared git history)', () => {
    const taskA = store.createTask({ title: 'A' });
    const taskB = store.createTask({ title: 'B' });
    const sha1 = commit(repoRoot, 'a.txt', 'First commit');

    // taskA syncs first and owns this commit.
    const first = syncTaskGit(store, taskA.id, repoRoot);
    expect(first.recordedCommits.map((c) => c.sha)).toEqual([sha1]);
    expect(store.listCommits(taskA.id).map((c) => c.sha)).toEqual([sha1]);

    // taskB shares the same repo history and syncs too -- must not throw,
    // and the commit stays attributed to taskA only (not duplicated).
    expect(() => syncTaskGit(store, taskB.id, repoRoot)).not.toThrow();
    const second = syncTaskGit(store, taskB.id, repoRoot);
    expect(second.recordedCommits).toEqual([]);
    expect(store.listCommits(taskB.id)).toEqual([]);
    expect(store.listCommits(taskA.id).map((c) => c.sha)).toEqual([sha1]);
  });
});
