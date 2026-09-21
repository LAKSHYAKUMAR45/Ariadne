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

const ALWAYS_EXCLUDED_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.ariadne',
  '.ssh',
  '.gnupg',
  '.kube',
  '.aws',
]);

const ALWAYS_EXCLUDED_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.env',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.kubeconfig',
]);

/** Exact file names that are credential stores on essentially every system. */
const ALWAYS_EXCLUDED_NAMES = new Set([
  '.envrc',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.htpasswd',
  'kubeconfig',
]);

/**
 * Conservative match for OpenSSH private-key file names (`id_rsa`,
 * `id_ed25519`, `id_ecdsa_sk`, and suffixed variants such as
 * `id_rsa_backup`). The matching `.pub` names are excluded too: they are
 * cheap to lose and expensive to misclassify.
 */
const PRIVATE_KEY_NAME_PATTERN =
  /^id_(?:rsa|dsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk)(?:[-_][A-Za-z0-9._-]+)?(?:\.pub)?$/i;

const SENSITIVE_NAME_PATTERN = /(credential|token|secret|password|passwd|api[-_]?key)/i;

const GIT_SYMLINK_MODE = '120000';

/** Upper bound on `git` stderr echoed into an error message. */
const GIT_DIAGNOSTIC_MAX_CHARS = 200;

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

/** A `git` invocation that failed, with bounded, content-free diagnostics. */
export class GitCaptureCommandError extends Error {
  constructor(args: readonly string[], cause: unknown) {
    const stderr = (cause as { stderr?: Buffer | string } | undefined)?.stderr;
    const detail = truncate(
      typeof stderr === 'string' ? stderr : stderr instanceof Buffer ? stderr.toString('utf8') : '',
      GIT_DIAGNOSTIC_MAX_CHARS,
    );
    const command = truncate(args.join(' '), GIT_DIAGNOSTIC_MAX_CHARS);
    super(`git ${command} failed${detail.length > 0 ? `: ${detail}` : ''}`);
    this.name = 'GitCaptureCommandError';
  }
}

/**
 * Runs `git` with literal pathspec semantics so tracked names containing
 * `*`, `?`, `[`, or a leading `:` are never reinterpreted as glob or magic
 * pathspecs. Throws `GitCaptureCommandError` on any non-zero exit.
 */
function gitBuffer(workspace: string, args: readonly string[]): Buffer {
  try {
    return execFileSync('git', ['-C', workspace, '--literal-pathspecs', ...args], {
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    throw new GitCaptureCommandError(args, error);
  }
}

function gitText(workspace: string, args: readonly string[]): string {
  return gitBuffer(workspace, args).toString('utf8');
}

/**
 * Only for `git` commands whose non-zero exit is an expected answer (a missing
 * revision), never for reads whose failure would silently lose history.
 */
function gitTextOrNull(workspace: string, args: readonly string[]): string | null {
  try {
    return gitText(workspace, args);
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
    if (ALWAYS_EXCLUDED_NAMES.has(segment.toLowerCase())) return true;
    if (PRIVATE_KEY_NAME_PATTERN.test(segment)) return true;
    if (segment === '.env' || segment.startsWith('.env.')) return true;
    if (SENSITIVE_NAME_PATTERN.test(segment)) return true;
  }

  const extension = path.posix.extname(segments[segments.length - 1]).toLowerCase();
  return ALWAYS_EXCLUDED_EXTENSIONS.has(extension);
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

/**
 * Matches one `.ariadneignore` pattern. Negation (`!pattern`) is deliberately
 * unsupported: built-in exclusions are a security floor and must never be
 * re-included by workspace configuration.
 */
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

/**
 * True when a Git-reported repository-relative path is structurally safe to
 * use as a capture path: relative, non-empty, and free of traversal or
 * NUL segments. This is a purely lexical check — it makes no filesystem call,
 * so it stays correct for historical commits whose directories no longer
 * exist in the current worktree.
 */
function isLexicallySafeRepoPath(relPath: string): boolean {
  if (relPath.length === 0 || relPath.includes('\0')) return false;
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(relPath)) return false;
  if (relPath.includes('\\')) return false;

  return relPath
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Verifies a live worktree path (including symlinked parents) resolves beneath
 * the root. Only valid for worktree captures: commit captures read Git objects
 * and must not depend on the current filesystem layout.
 */
function worktreePathStaysInsideRoot(relPath: string, workspaceRoot: string): boolean {
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
  /** Git blob object id for commit captures, read by object id, never by path. */
  oid?: string;
}

interface CandidateScan {
  candidates: Candidate[];
  skipped: CaptureSkip[];
}

function scanCommitCandidates(workspace: string, sha: string): CandidateScan {
  const names = splitNulList(
    gitText(workspace, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--root', sha]),
  );
  const tree = new Map<string, { mode: string; oid: string }>();
  for (const line of splitNulList(gitText(workspace, ['ls-tree', '-r', '-z', sha]))) {
    const tabIndex = line.indexOf('\t');
    if (tabIndex === -1) continue;
    const [mode, , oid] = line.slice(0, tabIndex).split(' ');
    if (!mode || !oid) continue;
    tree.set(line.slice(tabIndex + 1), { mode, oid });
  }

  const candidates: Candidate[] = [];
  const skipped: CaptureSkip[] = [];
  for (const name of names) {
    const entry = tree.get(name);
    // Absent from the commit tree means the commit deleted the path; it is a
    // fact of the tree listing, never an inferred command failure.
    if (!entry) {
      skipped.push({ path: name, reason: 'deleted' });
      continue;
    }
    candidates.push({ relPath: name, mode: entry.mode, oid: entry.oid });
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

/**
 * Reads a committed blob by object id. Failure means the repository could not
 * answer for content it just listed, so it throws rather than degrading into a
 * "deleted" or empty-diff capture.
 */
function readCommitContent(workspace: string, relPath: string, oid: string): Buffer {
  try {
    return gitBuffer(workspace, ['cat-file', 'blob', oid]);
  } catch (error: unknown) {
    throw new Error(`Cannot read committed blob for "${relPath}": ${errorMessage(error)}`);
  }
}

/** Resolves the diff base of a commit once per capture, not once per file. */
function resolveCommitDiffBase(workspace: string, sha: string): string {
  const parent = gitTextOrNull(workspace, ['rev-parse', '--verify', '--quiet', `${sha}^1`]);
  const trimmed = parent?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : EMPTY_TREE_SHA;
}

/** Resolves `HEAD` once per worktree capture; null for a repository with no commits. */
function resolveWorktreeDiffBase(workspace: string): string | null {
  const head = gitTextOrNull(workspace, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const trimmed = head?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function commitDiff(workspace: string, base: string, sha: string, relPath: string): string {
  try {
    return gitText(workspace, ['diff', '--no-color', '--no-ext-diff', base, sha, '--', relPath]);
  } catch (error: unknown) {
    throw new Error(`Cannot diff committed file "${relPath}": ${errorMessage(error)}`);
  }
}

function worktreeDiff(workspace: string, base: string | null, relPath: string): string {
  const args = base
    ? ['diff', '--no-color', '--no-ext-diff', base, '--', relPath]
    : ['diff', '--no-color', '--no-ext-diff', '--', relPath];
  try {
    return gitText(workspace, args);
  } catch (error: unknown) {
    throw new Error(`Cannot diff worktree file "${relPath}": ${errorMessage(error)}`);
  }
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

// -----------------------------------------------------------------------
// Candidate evaluation
// -----------------------------------------------------------------------

interface CaptureContext {
  workspaceRoot: string;
  isCommitCapture: boolean;
  /** Present exactly when `isCommitCapture` is true. */
  commitSha: string | null;
  /** Commit first-parent (or empty-tree) base, resolved once per capture. */
  commitDiffBase: string | null;
  /** Worktree `HEAD` base, resolved once per capture; null before any commit. */
  worktreeDiffBase: string | null;
  ignorePatterns: string[];
}

/**
 * Applies every path-level policy that does not need file content. Returns the
 * skip reason, or null when the candidate remains eligible.
 *
 * Commit captures are validated lexically only: their content comes from Git
 * objects, so a historical path whose directories no longer exist on disk must
 * still be capturable.
 */
function evaluateCandidatePath(candidate: Candidate, ctx: CaptureContext): CaptureSkipReason | null {
  const relPath = candidate.relPath;

  if (!isLexicallySafeRepoPath(relPath)) return 'outside_workspace';
  if (isAlwaysExcludedCapturePath(relPath)) return 'always_excluded';
  if (ctx.ignorePatterns.some((pattern) => matchesIgnorePattern(pattern, relPath))) {
    return 'ariadneignore';
  }
  if (!ctx.isCommitCapture && !worktreePathStaysInsideRoot(relPath, ctx.workspaceRoot)) {
    return 'outside_workspace';
  }

  const isSymlink = ctx.isCommitCapture
    ? candidate.mode === GIT_SYMLINK_MODE
    : isWorktreeSymlink(ctx.workspaceRoot, relPath);

  return isSymlink ? 'symlink' : null;
}

/**
 * Reads and decodes eligible content. Throws for Git-side read failures (which
 * would otherwise be indistinguishable from a legitimately empty capture) and
 * skips only for locally observable conditions.
 */
function readCandidateText(
  candidate: Candidate,
  ctx: CaptureContext,
): { content: string } | { skip: CaptureSkipReason } {
  const raw = ctx.isCommitCapture
    ? readCommitContent(ctx.workspaceRoot, candidate.relPath, candidate.oid!)
    : readWorktreeContent(ctx.workspaceRoot, candidate.relPath);
  if (raw === null) return { skip: 'unreadable' };

  const content = decodeTextOrNull(raw);
  return content === null ? { skip: 'binary' } : { content };
}

function buildEntry(candidate: Candidate, content: string, ctx: CaptureContext): NewTaskFileCaptureEntry {
  return {
    path: candidate.relPath,
    content,
    unifiedDiff: ctx.isCommitCapture
      ? commitDiff(ctx.workspaceRoot, ctx.commitDiffBase!, ctx.commitSha!, candidate.relPath)
      : worktreeDiff(ctx.workspaceRoot, ctx.worktreeDiffBase, candidate.relPath),
    byteLength: Buffer.byteLength(content, 'utf8'),
    contentSha256: sha256Hex(content),
  };
}

function buildCaptureContext(request: CaptureRequest, workspaceRoot: string): CaptureContext {
  const isCommitCapture = request.trigger === 'git_commit';
  const commitSha = isCommitCapture ? request.gitCommitSha! : null;

  return {
    workspaceRoot,
    isCommitCapture,
    commitSha,
    commitDiffBase: commitSha ? resolveCommitDiffBase(workspaceRoot, commitSha) : null,
    worktreeDiffBase: isCommitCapture ? null : resolveWorktreeDiffBase(workspaceRoot),
    ignorePatterns: readAriadneIgnorePatterns(workspaceRoot),
  };
}

/**
 * Captures the eligible task files for one trigger and stores them as a single
 * immutable capture. Commit captures read the exact committed blob and diff
 * against the commit's first parent (or `/dev/null` for a root commit);
 * checkpoint and explicit captures read the current worktree and diff against
 * `HEAD`.
 *
 * Throws when the workspace is not a git repository, the trigger is missing
 * its required reference, or Git cannot read content it has already listed —
 * callers must surface/record that failure rather than treating the trigger as
 * captured.
 */
export function captureTaskFiles(
  store: TaskStore,
  request: CaptureRequest,
  limits: CaptureLimits = DEFAULT_CAPTURE_LIMITS,
): CaptureResult {
  validateRequest(request);

  const workspaceRoot = resolveWorkspaceRoot(request.workspace);
  const ctx = buildCaptureContext(request, workspaceRoot);
  const scan = ctx.isCommitCapture
    ? scanCommitCandidates(workspaceRoot, ctx.commitSha!)
    : scanWorktreeCandidates(store, request.taskId, workspaceRoot);

  const skipped: CaptureSkip[] = [...scan.skipped];
  const entries: NewTaskFileCaptureEntry[] = [];
  let totalBytes = 0;

  for (const candidate of [...scan.candidates].sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    const relPath = candidate.relPath;

    const pathSkip = evaluateCandidatePath(candidate, ctx);
    if (pathSkip !== null) {
      skipped.push({ path: relPath, reason: pathSkip });
      continue;
    }

    const read = readCandidateText(candidate, ctx);
    if ('skip' in read) {
      skipped.push({ path: relPath, reason: read.skip });
      continue;
    }

    const byteLength = Buffer.byteLength(read.content, 'utf8');
    if (byteLength > limits.maxFileBytes) {
      skipped.push({ path: relPath, reason: 'file_too_large' });
      continue;
    }
    if (totalBytes + byteLength > limits.maxCaptureBytes) {
      skipped.push({ path: relPath, reason: 'capture_limit_exceeded' });
      continue;
    }

    totalBytes += byteLength;
    entries.push(buildEntry(candidate, read.content, ctx));
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
