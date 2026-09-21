import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskStore } from './TaskStore.js';
import type { FileCaptureTrigger, NewTaskFileCaptureEntry, TaskFileCaptureWithEntries } from './types.js';

/**
 * Safe, Git-aware task file capture — the engine behind immutable task
 * history (docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md).
 *
 * Capture is deliberately synchronous because `syncTaskGit` and every CLI/MCP
 * caller of it are synchronous, and it only ever shells out to `git` through
 * fixed `execFileSync` argument arrays (never a shell string), matching the
 * existing `GitWatcher` pattern.
 *
 * Only tracked, task-touched, plain, small, UTF-8 text files are captured.
 * Secrets, build output, vendored code, Ariadne's own state, symlinks, and
 * anything outside the canonical workspace root are always excluded.
 */

/** The well-known Git empty tree, used as the diff base for a root commit. */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** `git` writes a lot for large captures; keep well above the aggregate limit. */
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const ARIADNE_IGNORE_FILE = '.ariadneignore';

const ALWAYS_EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'build', '.ariadne']);

const ALWAYS_EXCLUDED_EXTENSIONS = new Set(['.pem', '.key']);

const SENSITIVE_NAME_PATTERN = /(credential|token|secret|password|passwd|api[-_]?key)/i;

const GIT_SYMLINK_MODE = '120000';

export interface CaptureLimits {
  /** Inclusive maximum UTF-8 byte length of a single captured file. */
  maxFileBytes: number;
  /** Inclusive maximum total UTF-8 byte length of one capture. */
  maxCaptureBytes: number;
}

export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = {
  maxFileBytes: 1024 * 1024,
  maxCaptureBytes: 10 * 1024 * 1024,
};

export type CaptureSkipReason =
  | 'untracked'
  | 'symlink'
  | 'binary'
  | 'outside_workspace'
  | 'always_excluded'
  | 'ariadneignore'
  | 'file_too_large'
  | 'capture_limit_exceeded'
  | 'deleted'
  | 'unreadable';

export interface CaptureSkip {
  path: string;
  reason: CaptureSkipReason;
}

export interface CaptureRequest {
  taskId: string;
  workspace: string;
  trigger: FileCaptureTrigger;
  gitCommitSha?: string;
  checkpointId?: string;
}

export interface CaptureResult {
  /** Null when no eligible file remained — no capture row is created. */
  capture: TaskFileCaptureWithEntries | null;
  skipped: CaptureSkip[];
}

// -----------------------------------------------------------------------
// git helpers (fixed argument arrays only — never a shell string)
// -----------------------------------------------------------------------

function gitBuffer(workspace: string, args: readonly string[]): Buffer {
  return execFileSync('git', ['-C', workspace, ...args], {
    maxBuffer: GIT_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function gitText(workspace: string, args: readonly string[]): string {
  return gitBuffer(workspace, args).toString('utf8');
}

function gitTextOrNull(workspace: string, args: readonly string[]): string | null {
  try {
    return gitText(workspace, args);
  } catch {
    return null;
  }
}

function gitBufferOrNull(workspace: string, args: readonly string[]): Buffer | null {
  try {
    return gitBuffer(workspace, args);
  } catch {
    return null;
  }
}

function splitNulList(output: string): string[] {
  return output.split('\0').filter((value) => value.length > 0);
}

// -----------------------------------------------------------------------
// Path eligibility
// -----------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i++;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * True when a repository-relative POSIX path must never be captured,
 * regardless of Git state or user configuration: secrets, keys, credential-
 * named files, build output, vendored dependencies, and Ariadne's own state.
 */
export function isAlwaysExcludedCapturePath(relPath: string): boolean {
  const segments = relPath.split('/').filter(Boolean);
  if (segments.length === 0) return true;

  for (const segment of segments) {
    if (ALWAYS_EXCLUDED_SEGMENTS.has(segment)) return true;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (SENSITIVE_NAME_PATTERN.test(segment)) return true;
  }

  return ALWAYS_EXCLUDED_EXTENSIONS.has(path.posix.extname(segments[segments.length - 1]));
}

function readAriadneIgnorePatterns(workspaceRoot: string): string[] {
  try {
    return fs
      .readFileSync(path.join(workspaceRoot, ARIADNE_IGNORE_FILE), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function matchesIgnorePattern(pattern: string, relPath: string): boolean {
  const normalized = pattern.replace(/^\/+/, '');
  const directoryOnly = normalized.endsWith('/');
  const body = directoryOnly ? normalized.slice(0, -1) : normalized;
  if (body.length === 0) return false;

  if (directoryOnly) {
    return relPath === body || relPath.startsWith(`${body}/`);
  }

  const matcher = globToRegExp(body);
  if (body.includes('/')) {
    return matcher.test(relPath) || relPath.startsWith(`${body}/`);
  }

  return relPath.split('/').some((segment) => matcher.test(segment));
}

/**
 * Normalizes an arbitrary recorded file path (absolute, Windows-style, or
 * dot-relative) into a canonical POSIX repository-relative path, or null when
 * it does not live beneath the canonical workspace root.
 */
function toRepoRelativePath(rawPath: string, workspaceRoot: string): string | null {
  const unixStyle = rawPath.replace(/\\/g, '/');
  const candidate = path.isAbsolute(unixStyle)
    ? path.relative(workspaceRoot, path.resolve(unixStyle)).replace(/\\/g, '/')
    : unixStyle;

  const normalized = path.posix.normalize(candidate).replace(/^\.\//, '').replace(/\/+$/, '');
  if (normalized.length === 0 || normalized === '.' || path.posix.isAbsolute(normalized)) return null;
  if (normalized === '..' || normalized.startsWith('../')) return null;

  return normalized;
}

/** Verifies the resolved path (including symlinked parents) stays beneath the root. */
function staysInsideWorkspace(relPath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, relPath);
  const prefix = `${workspaceRoot}${path.sep}`;
  if (!resolved.startsWith(prefix)) return false;

  try {
    const realParent = fs.realpathSync(path.dirname(resolved));
    return realParent === workspaceRoot || realParent.startsWith(prefix);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Content decoding
// -----------------------------------------------------------------------

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Returns strictly-decoded UTF-8 text, or null for binary/NUL/invalid content. */
function decodeTextOrNull(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    return null;
  }
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

// -----------------------------------------------------------------------
// Candidate collection
// -----------------------------------------------------------------------

interface Candidate {
  /** Canonical POSIX repository-relative path. */
  relPath: string;
  /** Git file mode for commit captures, when known. */
  mode?: string;
}

interface CandidateScan {
  candidates: Candidate[];
  skipped: CaptureSkip[];
}

function scanCommitCandidates(workspace: string, sha: string): CandidateScan {
  const names = splitNulList(
    gitText(workspace, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]),
  );
  const modes = new Map<string, string>();
  for (const line of splitNulList(gitText(workspace, ['ls-tree', '-r', '-z', sha]))) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    modes.set(line.slice(tabIndex + 1), line.slice(0, line.indexOf(' ')));
  }

  const candidates: Candidate[] = [];
  const skipped: CaptureSkip[] = [];
  for (const name of names) {
    const mode = modes.get(name);
    if (!mode) {
      skipped.push({ path: name, reason: 'deleted' });
      continue;
    }
    candidates.push({ relPath: name, mode });
  }

  return { candidates, skipped };
}

function scanWorktreeCandidates(store: TaskStore, taskId: string, workspaceRoot: string): CandidateScan {
  const tracked = new Set(splitNulList(gitText(workspaceRoot, ['ls-files', '-z'])));
  const candidates: Candidate[] = [];
  const skipped: CaptureSkip[] = [];
  const seen = new Set<string>();

  for (const file of store.listFiles(taskId)) {
    const relPath = toRepoRelativePath(file.path, workspaceRoot);
    if (relPath === null) {
      skipped.push({ path: file.path, reason: 'outside_workspace' });
      continue;
    }
    if (seen.has(relPath)) continue;
    seen.add(relPath);

    if (!tracked.has(relPath)) {
      skipped.push({ path: relPath, reason: 'untracked' });
      continue;
    }
    candidates.push({ relPath });
  }

  return { candidates, skipped };
}

// -----------------------------------------------------------------------
// Content + diff readers
// -----------------------------------------------------------------------

function readCommitContent(workspace: string, sha: string, relPath: string): Buffer | null {
  return gitBufferOrNull(workspace, ['show', `${sha}:${relPath}`]);
}

function commitDiff(workspace: string, sha: string, relPath: string): string {
  const parent = gitTextOrNull(workspace, ['rev-parse', '--verify', '--quiet', `${sha}^1`]);
  const base = parent ? parent.trim() : EMPTY_TREE_SHA;
  return gitTextOrNull(workspace, ['diff', '--no-color', '--no-ext-diff', base, sha, '--', relPath]) ?? '';
}

function worktreeDiff(workspace: string, relPath: string): string {
  const head = gitTextOrNull(workspace, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const args = head
    ? ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', relPath]
    : ['diff', '--no-color', '--no-ext-diff', '--', relPath];
  return gitTextOrNull(workspace, args) ?? '';
}

function readWorktreeContent(workspaceRoot: string, relPath: string): Buffer | null {
  try {
    return fs.readFileSync(path.resolve(workspaceRoot, relPath));
  } catch {
    return null;
  }
}

function isWorktreeSymlink(workspaceRoot: string, relPath: string): boolean {
  try {
    return fs.lstatSync(path.resolve(workspaceRoot, relPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// Capture
// -----------------------------------------------------------------------

function validateRequest(request: CaptureRequest): void {
  if (request.trigger === 'git_commit' && !request.gitCommitSha) {
    throw new Error('git_commit captures require a gitCommitSha.');
  }
  if (request.trigger === 'checkpoint' && !request.checkpointId) {
    throw new Error('checkpoint captures require a checkpointId.');
  }
}

function resolveWorkspaceRoot(workspace: string): string {
  const toplevel = gitTextOrNull(workspace, ['rev-parse', '--show-toplevel']);
  if (!toplevel || toplevel.trim().length === 0) {
    throw new Error(`Cannot capture task files: "${workspace}" is not a git repository.`);
  }
  return fs.realpathSync(toplevel.trim());
}

/**
 * Captures the eligible task files for one trigger and stores them as a single
 * immutable capture. Commit captures read the exact committed blob and diff
 * against the commit's first parent (or `/dev/null` for a root commit);
 * checkpoint and explicit captures read the current worktree and diff against
 * `HEAD`.
 *
 * Throws when the workspace is not a git repository or the trigger is missing
 * its required reference — callers must surface/record that failure rather
 * than treating the trigger as captured.
 */
export function captureTaskFiles(
  store: TaskStore,
  request: CaptureRequest,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CaptureResult {
  validateRequest(request);

  const workspaceRoot = resolveWorkspaceRoot(request.workspace);
  const isCommitCapture = request.trigger === 'git_commit';
  const scan = isCommitCapture
    ? scanCommitCandidates(workspaceRoot, request.gitCommitSha!)
    : scanWorktreeCandidates(store, request.taskId, workspaceRoot);

  const ignorePatterns = readAriadneIgnorePatterns(workspaceRoot);
  const skipped: CaptureSkip[] = [...scan.skipped];
  const entries: NewTaskFileCaptureEntry[] = [];
  let totalBytes = 0;

  for (const candidate of [...scan.candidates].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const relPath = candidate.relPath;

    if (isAlwaysExcludedCapturePath(relPath)) {
      skipped.push({ path: relPath, reason: 'always_excluded' });
      continue;
    }
    if (ignorePatterns.some((pattern) => matchesIgnorePattern(pattern, relPath))) {
      skipped.push({ path: relPath, reason: 'ariadneignore' });
      continue;
    }
    if (!staysInsideWorkspace(relPath, workspaceRoot)) {
      skipped.push({ path: relPath, reason: 'outside_workspace' });
      continue;
    }
    const isSymlink = isCommitCapture
      ? candidate.mode === GIT_SYMLINK_MODE
      : isWorktreeSymlink(workspaceRoot, relPath);
    if (isSymlink) {
      skipped.push({ path: relPath, reason: 'symlink' });
      continue;
    }

    const raw = isCommitCapture
      ? readCommitContent(workspaceRoot, request.gitCommitSha!, relPath)
      : readWorktreeContent(workspaceRoot, relPath);
    if (raw === null) {
      skipped.push({ path: relPath, reason: isCommitCapture ? 'deleted' : 'unreadable' });
      continue;
    }

    const content = decodeTextOrNull(raw);
    if (content === null) {
      skipped.push({ path: relPath, reason: 'binary' });
      continue;
    }

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > limits.maxFileBytes) {
      skipped.push({ path: relPath, reason: 'file_too_large' });
      continue;
    }
    if (totalBytes + byteLength > limits.maxCaptureBytes) {
      skipped.push({ path: relPath, reason: 'capture_limit_exceeded' });
      continue;
    }

    totalBytes += byteLength;
    entries.push({
      path: relPath,
      content,
      unifiedDiff: isCommitCapture
        ? commitDiff(workspaceRoot, request.gitCommitSha!, relPath)
        : worktreeDiff(workspaceRoot, relPath),
      byteLength,
      contentSha256: sha256Hex(content),
    });
  }

  if (entries.length === 0) {
    return { capture: null, skipped };
  }

  const capture = store.createTaskFileCapture({
    taskId: request.taskId,
    trigger: request.trigger,
    gitCommitSha: request.gitCommitSha ?? null,
    checkpointId: request.checkpointId ?? null,
    entries,
  });

  return { capture, skipped };
}
