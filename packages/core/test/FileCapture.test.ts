import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TaskStore } from '../src/TaskStore.js';
import {
  captureTaskFiles,
  isAlwaysExcludedCapturePath,
  DEFAULT_CAPTURE_LIMITS,
} from '../src/FileCapture.js';
import type { CaptureResult } from '../src/FileCapture.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
}

function write(dir: string, relPath: string, contents: string | Buffer): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function commitAll(dir: string, message: string, force = false): string {
  git(force ? ['add', '-f', '-A'] : ['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function sha256Utf8(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

function entryPaths(result: CaptureResult): string[] {
  return (result.capture?.entries ?? []).map((entry) => entry.path);
}

function skipReason(result: CaptureResult, filePath: string): string | undefined {
  return result.skipped.find((skip) => skip.path === filePath)?.reason;
}

describe('FileCapture', () => {
  let repoRoot: string;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-capture-test-')));
    initRepo(repoRoot);
    store = new TaskStore(':memory:');
    taskId = store.createTask({ title: 'Capture task' }).id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function touch(relPath: string): void {
    store.touchFile({ taskId, path: relPath, role: 'edited' });
  }

  describe('eligibility', () => {
    it('captures a tracked, touched, UTF-8 text file', () => {
      write(repoRoot, 'src/app.ts', 'export const a = 1;\n');
      commitAll(repoRoot, 'add app');
      write(repoRoot, 'src/app.ts', 'export const a = 2;\n');
      touch('src/app.ts');

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'explicit',
      });

      expect(entryPaths(result)).toEqual(['src/app.ts']);
      const entry = result.capture!.entries[0];
      expect(entry.content).toBe('export const a = 2;\n');
      expect(entry.byteLength).toBe(Buffer.byteLength('export const a = 2;\n', 'utf8'));
      expect(entry.contentSha256).toBe(sha256Utf8('export const a = 2;\n'));
      expect(entry.unifiedDiff).toContain('-export const a = 1;');
      expect(entry.unifiedDiff).toContain('+export const a = 2;');
      expect(result.capture!.trigger).toBe('explicit');
    });

    it('excludes a tracked file that the task never touched', () => {
      write(repoRoot, 'src/app.ts', 'export const a = 1;\n');
      write(repoRoot, 'src/other.ts', 'export const b = 1;\n');
      commitAll(repoRoot, 'add files');
      touch('src/app.ts');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['src/app.ts']);
      expect(entryPaths(result)).not.toContain('src/other.ts');
    });

    it('excludes untracked and git-ignored files', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      write(repoRoot, '.gitignore', 'ignored.ts\n');
      commitAll(repoRoot, 'add keep');
      write(repoRoot, 'untracked.ts', 'export const u = 1;\n');
      write(repoRoot, 'ignored.ts', 'export const i = 1;\n');
      touch('keep.ts');
      touch('untracked.ts');
      touch('ignored.ts');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['keep.ts']);
      expect(skipReason(result, 'untracked.ts')).toBe('untracked');
      expect(skipReason(result, 'ignored.ts')).toBe('untracked');
    });

    it('excludes tracked symlinks', () => {
      write(repoRoot, 'real.ts', 'export const r = 1;\n');
      fs.symlinkSync(path.join(repoRoot, 'real.ts'), path.join(repoRoot, 'link.ts'));
      commitAll(repoRoot, 'add link');
      touch('link.ts');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).not.toContain('link.ts');
      expect(skipReason(result, 'link.ts')).toBe('symlink');
    });

    it('excludes binary content (NUL bytes) and invalid UTF-8', () => {
      write(repoRoot, 'bin.dat', Buffer.from([0x41, 0x00, 0x42]));
      write(repoRoot, 'bad-utf8.txt', Buffer.from([0xff, 0xfe, 0xfd]));
      commitAll(repoRoot, 'add binary');
      touch('bin.dat');
      touch('bad-utf8.txt');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(result.capture).toBeNull();
      expect(skipReason(result, 'bin.dat')).toBe('binary');
      expect(skipReason(result, 'bad-utf8.txt')).toBe('binary');
    });

    it('excludes paths that escape the workspace root', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      commitAll(repoRoot, 'add keep');
      const outside = path.join(repoRoot, '..', 'outside-secret.txt');
      fs.writeFileSync(outside, 'outside\n');
      touch('keep.ts');
      touch('../outside-secret.txt');
      touch(outside);

      try {
        const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

        expect(entryPaths(result)).toEqual(['keep.ts']);
        expect(
          result.skipped.filter((skip) => skip.reason === 'outside_workspace').length,
        ).toBeGreaterThanOrEqual(1);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });
  });

  describe('always-excluded paths', () => {
    it.each([
      '.env',
      '.env.local',
      'config/.env',
      'config/production.env',
      '.envrc',
      'certs/server.pem',
      'deploy/id_rsa.key',
      'deploy/id_rsa',
      'deploy/id_rsa.pub',
      'deploy/id_ed25519',
      'deploy/id_ecdsa',
      'deploy/id_dsa',
      'deploy/id_ed25519_sk',
      'deploy/id_rsa_backup',
      'certs/bundle.p12',
      'certs/bundle.pfx',
      'certs/store.jks',
      'certs/release.keystore',
      'certs/putty.ppk',
      '.npmrc',
      'home/.netrc',
      'home/_netrc',
      'home/.pgpass',
      'kubeconfig',
      'clusters/prod.kubeconfig',
      '.kube/config',
      '.ssh/known_hosts',
      'src/credentials.ts',
      'src/token-store.ts',
      'app/secret.json',
      '.git/config',
      'node_modules/pkg/index.js',
      'dist/bundle.js',
      'build/out.js',
      '.ariadne/state.db',
    ])('always excludes %s', (candidate) => {
      expect(isAlwaysExcludedCapturePath(candidate)).toBe(true);
    });

    it.each([
      'src/app.ts',
      'README.md',
      'packages/core/src/index.ts',
      'environment.ts',
      'src/identity.ts',
      'src/kubernetes-client.ts',
      'scripts/keystore-docs.md',
    ])('does not exclude %s', (candidate) => {
      expect(isAlwaysExcludedCapturePath(candidate)).toBe(false);
    });

    it('skips tracked sensitive files during capture', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      write(repoRoot, '.env', 'API_KEY=abc\n');
      write(repoRoot, 'certs/server.pem', 'PEM\n');
      write(repoRoot, 'deploy/id_rsa.key', 'KEY\n');
      write(repoRoot, 'src/credentials.ts', 'export const c = 1;\n');
      write(repoRoot, 'dist/bundle.js', 'bundled\n');
      write(repoRoot, 'build/out.js', 'built\n');
      write(repoRoot, 'node_modules/pkg/index.js', 'module\n');
      write(repoRoot, '.ariadne/notes.txt', 'notes\n');
      commitAll(repoRoot, 'add sensitive', true);

      for (const candidate of [
        'keep.ts',
        '.env',
        'certs/server.pem',
        'deploy/id_rsa.key',
        'src/credentials.ts',
        'dist/bundle.js',
        'build/out.js',
        'node_modules/pkg/index.js',
        '.ariadne/notes.txt',
      ]) {
        touch(candidate);
      }

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['keep.ts']);
      expect(skipReason(result, '.env')).toBe('always_excluded');
      expect(skipReason(result, 'node_modules/pkg/index.js')).toBe('always_excluded');
      expect(skipReason(result, '.ariadne/notes.txt')).toBe('always_excluded');
    });

    it('excludes additional paths listed in .ariadneignore', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      write(repoRoot, 'private/notes.md', 'private\n');
      write(repoRoot, 'generated/schema.ts', 'generated\n');
      write(repoRoot, '.ariadneignore', '# comment\nprivate/\n*.generated.ts\ngenerated/schema.ts\n');
      commitAll(repoRoot, 'add ariadneignore');
      touch('keep.ts');
      touch('private/notes.md');
      touch('generated/schema.ts');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['keep.ts']);
      expect(skipReason(result, 'private/notes.md')).toBe('ariadneignore');
      expect(skipReason(result, 'generated/schema.ts')).toBe('ariadneignore');
    });

    it('never re-includes built-in exclusions through .ariadneignore', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      write(repoRoot, '.env', 'API_KEY=abc\n');
      write(repoRoot, 'deploy/id_ed25519', 'PRIVATE KEY\n');
      write(repoRoot, '.ariadneignore', '!.env\n!deploy/id_ed25519\n!node_modules/\n');
      commitAll(repoRoot, 'add negations', true);
      touch('keep.ts');
      touch('.env');
      touch('deploy/id_ed25519');

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['keep.ts']);
      expect(skipReason(result, '.env')).toBe('always_excluded');
      expect(skipReason(result, 'deploy/id_ed25519')).toBe('always_excluded');
    });

    it('skips newly covered credential files during capture', () => {
      write(repoRoot, 'keep.ts', 'export const keep = 1;\n');
      const credentialPaths = [
        'config/production.env',
        '.envrc',
        'deploy/id_rsa',
        'deploy/id_ed25519',
        'certs/bundle.p12',
        'certs/release.keystore',
        '.npmrc',
        'home/.netrc',
        'home/.pgpass',
        'clusters/prod.kubeconfig',
        '.kube/config',
      ];
      for (const credentialPath of credentialPaths) {
        write(repoRoot, credentialPath, 'SECRET\n');
      }
      commitAll(repoRoot, 'add credentials', true);
      touch('keep.ts');
      for (const credentialPath of credentialPaths) {
        touch(credentialPath);
      }

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['keep.ts']);
      for (const credentialPath of credentialPaths) {
        expect(skipReason(result, credentialPath)).toBe('always_excluded');
      }
    });
  });

  describe('limits', () => {
    it('treats the per-file limit as an inclusive boundary', () => {
      const atLimit = 'a'.repeat(64);
      const overLimit = 'b'.repeat(65);
      write(repoRoot, 'at-limit.txt', atLimit);
      write(repoRoot, 'over-limit.txt', overLimit);
      commitAll(repoRoot, 'add limit files');
      touch('at-limit.txt');
      touch('over-limit.txt');

      const result = captureTaskFiles(
        store,
        { taskId, workspace: repoRoot, trigger: 'explicit' },
        { maxFileBytes: 64, maxCaptureBytes: DEFAULT_CAPTURE_LIMITS.maxCaptureBytes },
      );

      expect(entryPaths(result)).toEqual(['at-limit.txt']);
      expect(skipReason(result, 'over-limit.txt')).toBe('file_too_large');
    });

    it('treats the aggregate limit as an inclusive boundary', () => {
      write(repoRoot, 'a.txt', 'a'.repeat(50));
      write(repoRoot, 'b.txt', 'b'.repeat(50));
      write(repoRoot, 'c.txt', 'c'.repeat(1));
      commitAll(repoRoot, 'add aggregate files');
      touch('a.txt');
      touch('b.txt');
      touch('c.txt');

      const result = captureTaskFiles(
        store,
        { taskId, workspace: repoRoot, trigger: 'explicit' },
        { maxFileBytes: 100, maxCaptureBytes: 100 },
      );

      expect(entryPaths(result).sort()).toEqual(['a.txt', 'b.txt']);
      expect(skipReason(result, 'c.txt')).toBe('capture_limit_exceeded');
    });

    it('defaults to 1 MiB per file and 10 MiB per capture', () => {
      expect(DEFAULT_CAPTURE_LIMITS).toEqual({
        maxFileBytes: 1024 * 1024,
        maxCaptureBytes: 10 * 1024 * 1024,
      });
    });
  });

  describe('commit captures', () => {
    it('reads the committed blob, not the current worktree content', () => {
      write(repoRoot, 'src/app.ts', 'committed\n');
      const sha = commitAll(repoRoot, 'commit app');
      store.recordCommit({ sha, taskId, message: 'commit app' });
      write(repoRoot, 'src/app.ts', 'worktree-only\n');
      touch('src/app.ts');

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result)).toEqual(['src/app.ts']);
      expect(result.capture!.entries[0].content).toBe('committed\n');
      expect(result.capture!.gitCommitSha).toBe(sha);
    });

    it('captures commit files even when the task never touched them', () => {
      write(repoRoot, 'src/app.ts', 'committed\n');
      const sha = commitAll(repoRoot, 'commit app');
      store.recordCommit({ sha, taskId, message: 'commit app' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result)).toEqual(['src/app.ts']);
    });

    it('diffs a non-root commit against its first parent', () => {
      write(repoRoot, 'src/app.ts', 'v1\n');
      commitAll(repoRoot, 'first');
      write(repoRoot, 'src/app.ts', 'v2\n');
      const sha = commitAll(repoRoot, 'second');
      store.recordCommit({ sha, taskId, message: 'second' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      const diff = result.capture!.entries[0].unifiedDiff;
      expect(diff).toContain('-v1');
      expect(diff).toContain('+v2');
      expect(diff).not.toContain('/dev/null');
    });

    it('diffs a root commit against /dev/null', () => {
      write(repoRoot, 'src/app.ts', 'v1\n');
      const sha = commitAll(repoRoot, 'root commit');
      store.recordCommit({ sha, taskId, message: 'root commit' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      const diff = result.capture!.entries[0].unifiedDiff;
      expect(diff).toContain('--- /dev/null');
      expect(diff).toContain('+v1');
    });

    it('skips files deleted by the commit', () => {
      write(repoRoot, 'a.txt', 'a\n');
      write(repoRoot, 'b.txt', 'b\n');
      commitAll(repoRoot, 'first');
      fs.rmSync(path.join(repoRoot, 'b.txt'));
      write(repoRoot, 'a.txt', 'a2\n');
      const sha = commitAll(repoRoot, 'delete b');
      store.recordCommit({ sha, taskId, message: 'delete b' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result)).toEqual(['a.txt']);
      expect(skipReason(result, 'b.txt')).toBe('deleted');
    });

    it('is idempotent for the same commit', () => {
      write(repoRoot, 'src/app.ts', 'v1\n');
      const sha = commitAll(repoRoot, 'root commit');
      store.recordCommit({ sha, taskId, message: 'root commit' });
      const request = {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit' as const,
        gitCommitSha: sha,
      };

      const first = captureTaskFiles(store, request);
      const second = captureTaskFiles(store, request);

      expect(second.capture!.id).toBe(first.capture!.id);
      expect(store.getTaskFileCaptures(taskId)).toHaveLength(1);
    });

    it('captures a historical commit whose directory no longer exists', () => {
      write(repoRoot, 'gone/app.ts', 'v1\n');
      write(repoRoot, 'keep.ts', 'keep\n');
      const sha = commitAll(repoRoot, 'add gone');
      store.recordCommit({ sha, taskId, message: 'add gone' });
      fs.rmSync(path.join(repoRoot, 'gone'), { recursive: true, force: true });
      commitAll(repoRoot, 'remove gone');

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result)).toEqual(['gone/app.ts', 'keep.ts']);
      expect(result.capture!.entries[0].content).toBe('v1\n');
    });

    it('skips symlinks recorded in the commit tree even when absent from the worktree', () => {
      write(repoRoot, 'real.ts', 'export const r = 1;\n');
      fs.symlinkSync('real.ts', path.join(repoRoot, 'link.ts'));
      const sha = commitAll(repoRoot, 'add link');
      store.recordCommit({ sha, taskId, message: 'add link' });
      // Removing the worktree symlink forces the decision through the
      // ls-tree 120000 mode instead of a filesystem lstat.
      fs.rmSync(path.join(repoRoot, 'link.ts'));

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result)).toEqual(['real.ts']);
      expect(skipReason(result, 'link.ts')).toBe('symlink');
    });

    it('throws with bounded diagnostics when a committed blob cannot be read', () => {
      write(repoRoot, 'src/app.ts', 'v1\n');
      const sha = commitAll(repoRoot, 'root commit');
      store.recordCommit({ sha, taskId, message: 'root commit' });
      const blob = git(['rev-parse', `${sha}:src/app.ts`], repoRoot);
      fs.rmSync(path.join(repoRoot, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

      let thrown: unknown;
      try {
        captureTaskFiles(store, {
          taskId,
          workspace: repoRoot,
          trigger: 'git_commit',
          gitCommitSha: sha,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain('src/app.ts');
      expect(message.length).toBeLessThanOrEqual(600);
      expect(store.getTaskFileCaptures(taskId)).toEqual([]);
    });
  });

  describe('checkpoint captures', () => {
    it('snapshots the current worktree and diffs against HEAD', () => {
      write(repoRoot, 'src/app.ts', 'committed\n');
      commitAll(repoRoot, 'commit app');
      write(repoRoot, 'src/app.ts', 'worktree\n');
      touch('src/app.ts');
      const checkpoint = store.createCheckpoint({ taskId, level: 'micro', summary: 'cp' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'checkpoint',
        checkpointId: checkpoint.id,
      });

      expect(result.capture!.checkpointId).toBe(checkpoint.id);
      expect(result.capture!.entries[0].content).toBe('worktree\n');
      expect(result.capture!.entries[0].unifiedDiff).toContain('+worktree');
    });
  });

  describe('path normalization', () => {
    it('stores canonical POSIX repository-relative paths', () => {
      write(repoRoot, 'src/nested/app.ts', 'export const a = 1;\n');
      commitAll(repoRoot, 'add nested');
      store.touchFile({ taskId, path: path.join(repoRoot, 'src', 'nested', 'app.ts'), role: 'edited' });
      store.touchFile({ taskId, path: './src/nested/../nested/app.ts', role: 'edited' });

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result)).toEqual(['src/nested/app.ts']);
    });
  });

  describe('worktree containment', () => {
    it('skips tracked worktree paths whose parent resolves outside the root', () => {
      const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-outside-')));
      try {
        write(repoRoot, 'pkg/app.ts', 'inside\n');
        write(repoRoot, 'keep.ts', 'keep\n');
        commitAll(repoRoot, 'add pkg');
        // Swap the tracked directory for a symlink to an external directory:
        // the index still lists pkg/app.ts, but its real parent escapes.
        fs.rmSync(path.join(repoRoot, 'pkg'), { recursive: true, force: true });
        fs.writeFileSync(path.join(outsideDir, 'app.ts'), 'leaked\n');
        fs.symlinkSync(outsideDir, path.join(repoRoot, 'pkg'));
        touch('pkg/app.ts');
        touch('keep.ts');

        const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

        expect(entryPaths(result)).toEqual(['keep.ts']);
        expect(skipReason(result, 'pkg/app.ts')).toBe('outside_workspace');
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('git pathspec safety', () => {
    const metacharacterNames = ['bracket[a].ts', 'star*.ts', 'question?.ts', ':leading.ts'];

    function filesystemSupportsMetacharacterNames(): boolean {
      try {
        for (const name of metacharacterNames) {
          write(repoRoot, name, 'v1\n');
        }
        return true;
      } catch {
        return false;
      }
    }

    it('diffs tracked paths containing Git pathspec metacharacters literally', () => {
      if (!filesystemSupportsMetacharacterNames()) return;
      write(repoRoot, 'bracketa.ts', 'decoy\n');
      commitAll(repoRoot, 'add metacharacter files');
      for (const name of metacharacterNames) {
        write(repoRoot, name, 'v2\n');
        touch(name);
      }

      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });

      expect(entryPaths(result).sort()).toEqual([...metacharacterNames].sort());
      for (const entry of result.capture!.entries) {
        expect(entry.content).toBe('v2\n');
        expect(entry.unifiedDiff).toContain('-v1');
        expect(entry.unifiedDiff).toContain('+v2');
        expect(entry.unifiedDiff).not.toContain('decoy');
      }
    });

    it('diffs committed paths containing Git pathspec metacharacters literally', () => {
      if (!filesystemSupportsMetacharacterNames()) return;
      commitAll(repoRoot, 'add metacharacter files');
      for (const name of metacharacterNames) {
        write(repoRoot, name, 'v2\n');
      }
      const sha = commitAll(repoRoot, 'update metacharacter files');
      store.recordCommit({ sha, taskId, message: 'update metacharacter files' });

      const result = captureTaskFiles(store, {
        taskId,
        workspace: repoRoot,
        trigger: 'git_commit',
        gitCommitSha: sha,
      });

      expect(entryPaths(result).sort()).toEqual([...metacharacterNames].sort());
      for (const entry of result.capture!.entries) {
        expect(entry.unifiedDiff).toContain('-v1');
        expect(entry.unifiedDiff).toContain('+v2');
      }
    });
  });

  describe('failures', () => {
    it('throws when the workspace is not a Git repository', () => {
      const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-not-a-repo-'));
      try {
        expect(() =>
          captureTaskFiles(store, { taskId, workspace: notARepo, trigger: 'explicit' }),
        ).toThrow(/git/i);
      } finally {
        fs.rmSync(notARepo, { recursive: true, force: true });
      }
    });

    it('rejects trigger/reference mismatches', () => {
      expect(() =>
        captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'git_commit' }),
      ).toThrow(/gitCommitSha/);
      expect(() =>
        captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'checkpoint' }),
      ).toThrow(/checkpointId/);
    });

    it('returns a null capture when nothing is eligible', () => {
      const result = captureTaskFiles(store, { taskId, workspace: repoRoot, trigger: 'explicit' });
      expect(result.capture).toBeNull();
      expect(store.getTaskFileCaptures(taskId)).toEqual([]);
    });
  });
});
