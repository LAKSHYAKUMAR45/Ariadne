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
      'certs/server.pem',
      'deploy/id_rsa.key',
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

    it.each(['src/app.ts', 'README.md', 'packages/core/src/index.ts', 'environment.ts'])(
      'does not exclude %s',
      (candidate) => {
        expect(isAlwaysExcludedCapturePath(candidate)).toBe(false);
      },
    );

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
