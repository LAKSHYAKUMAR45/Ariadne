import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/TaskStore.js';
import { getHeadSha, getCurrentBranch, listRecentCommits, syncTaskGit, isGitCommitCommand } from '../src/GitWatcher.js';

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

  it('syncTaskGit also records the files each new commit touched, with role derived from git status', () => {
    const task = store.createTask({ title: 'A' });
    commit(repoRoot, 'a.txt', 'First commit'); // creates a.txt
    fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'changed\n');
    git(['add', 'a.txt'], repoRoot);
    git(['rm', '-q', '--cached', '--ignore-unmatch', 'nonexistent'], repoRoot); // no-op, keeps helper generic
    git(['commit', '-q', '-m', 'Second commit'], repoRoot); // modifies a.txt

    syncTaskGit(store, task.id, repoRoot);

    const files = store.listFiles(task.id);
    const byPath = new Map(files.map((f) => [f.path, f.role]));
    expect(byPath.get('a.txt')).toBe('edited'); // last commit modified it, so "edited" wins over the earlier "created"
  });

  it('syncTaskGit captures the committed file contents for each new commit', () => {
    const task = store.createTask({ title: 'A' });
    const sha1 = commit(repoRoot, 'a.txt', 'First commit');
    fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'second version\n');
    git(['add', 'a.txt'], repoRoot);
    git(['commit', '-q', '-m', 'Second commit'], repoRoot);
    const sha2 = git(['rev-parse', 'HEAD'], repoRoot);
    // Worktree drifts after the commit -- the capture must use the commit blob.
    fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'uncommitted\n');

    const result = syncTaskGit(store, task.id, repoRoot);

    expect(result.captureFailures).toEqual([]);
    expect(result.captures.map((c) => c.gitCommitSha)).toEqual([sha1, sha2]);

    const captures = store.getTaskFileCaptures(task.id);
    expect(captures).toHaveLength(2);
    const second = captures.find((c) => c.gitCommitSha === sha2)!;
    expect(second.trigger).toBe('git_commit');
    expect(second.entries.map((e) => e.path)).toEqual(['a.txt']);
    expect(second.entries[0].content).toBe('second version\n');
  });

  it('syncTaskGit does not duplicate captures when re-synced', () => {
    const task = store.createTask({ title: 'A' });
    commit(repoRoot, 'a.txt', 'First commit');

    syncTaskGit(store, task.id, repoRoot);
    const second = syncTaskGit(store, task.id, repoRoot);

    expect(second.captures).toEqual([]);
    expect(store.getTaskFileCaptures(task.id)).toHaveLength(1);
  });

  it('syncTaskGit surfaces and records capture failures without marking the commit captured', () => {
    const task = store.createTask({ title: 'A' });
    const sha = commit(repoRoot, 'a.txt', 'First commit');
    const failing = Object.create(store) as TaskStore;
    (failing as unknown as { createTaskFileCapture: () => never }).createTaskFileCapture = () => {
      throw new Error('disk exploded');
    };

    const result = syncTaskGit(failing, task.id, repoRoot);

    expect(result.recordedCommits.map((c) => c.sha)).toEqual([sha]);
    expect(result.captures).toEqual([]);
    expect(result.captureFailures).toEqual([
      { sha, message: expect.stringContaining('disk exploded') },
    ]);
    expect(store.getTaskFileCaptures(task.id)).toEqual([]);
    const errors = store.listErrors(task.id);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(sha);
    expect(errors[0].message).toContain('disk exploded');
  });

  it('syncTaskGit records a capture failure when a committed blob is unreadable', () => {
    const task = store.createTask({ title: 'A' });
    const sha = commit(repoRoot, 'a.txt', 'First commit');
    const blob = git(['rev-parse', `${sha}:a.txt`], repoRoot);
    fs.rmSync(path.join(repoRoot, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

    const result = syncTaskGit(store, task.id, repoRoot);

    expect(result.captures).toEqual([]);
    expect(result.captureFailures).toHaveLength(1);
    expect(result.captureFailures[0].sha).toBe(sha);
    expect(store.getTaskFileCaptures(task.id)).toEqual([]);
    expect(store.listErrors(task.id)).toHaveLength(1);
  });

  it('isGitCommitCommand recognizes git commit invocations but not lookalikes', () => {
    expect(isGitCommitCommand('git commit -m "fix bug"')).toBe(true);
    expect(isGitCommitCommand('cd repo && git commit -m "fix"')).toBe(true);
    expect(isGitCommitCommand('git -C repo commit -m "fix"')).toBe(true);
    expect(isGitCommitCommand('git commit-graph write')).toBe(false);
    expect(isGitCommitCommand('git log --grep=commit')).toBe(false);
    expect(isGitCommitCommand('npm test')).toBe(false);
  });
});
