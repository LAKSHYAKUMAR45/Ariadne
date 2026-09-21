import { execFileSync } from 'node:child_process';
import type { TaskStore } from './TaskStore.js';
import type { FileRole } from './types.js';

/**
 * Editor-agnostic git capture — the `GitWatcher` from
 * docs/02-ARCHITECTURE.md. Shells out to the `git` CLI directly (rather
 * than an editor's git integration API), so any surface — CLI, MCP server,
 * or VS Code extension — can capture branch switches and new commits
 * without needing VS Code running. This is what makes git capture
 * available to CLI-only / no-editor workflows; the VS Code extension's
 * `passiveCapture.ts` additionally uses the built-in `vscode.git` extension
 * for real-time, event-driven capture while the editor is open.
 */

const UNIT_SEP = '\x1f'; // ASCII unit separator — safe delimiter for commit sha/message pairs.

function git(args: string[], repoRoot: string): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // not a git repo, git not installed, no commits yet, etc. — capture is best-effort.
  }
}

/** Returns the current HEAD commit sha, or null if unavailable (not a git repo, no commits yet). */
export function getHeadSha(repoRoot: string): string | null {
  const sha = git(['rev-parse', 'HEAD'], repoRoot);
  return sha || null;
}

/** Returns the current branch name, or null if unavailable/detached HEAD. */
export function getCurrentBranch(repoRoot: string): string | null {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  return branch && branch !== 'HEAD' ? branch : null;
}

export interface GitLogEntry {
  sha: string;
  message: string;
}

/** Lists the most recent commits (newest first) reachable from HEAD. */
export function listRecentCommits(repoRoot: string, limit = 50): GitLogEntry[] {
  const out = git(['log', '-n', String(limit), `--format=%H${UNIT_SEP}%s`], repoRoot);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const sepIndex = line.indexOf(UNIT_SEP);
      return sepIndex === -1
        ? { sha: line, message: '' }
        : { sha: line.slice(0, sepIndex), message: line.slice(sepIndex + 1) };
    });
}

export interface GitCommitFileEntry {
  path: string;
  /** Raw git diff-tree status letter (A/M/D/R/C/...), before mapping to a `FileRole`. */
  status: string;
}

/** Lists the files changed by a single commit, via `git diff-tree`. Best-effort: returns `[]` if the sha/repo is unavailable. */
export function listCommitFiles(repoRoot: string, sha: string): GitCommitFileEntry[] {
  // `--root` makes diff-tree show the full file list for a repo's very first
  // commit too (which has no parent to diff against).
  const out = git(['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', sha], repoRoot);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    })
    .filter((entry) => entry.path);
}

/** Maps a `git diff-tree --name-status` letter to Ariadne's `FileRole`. Renames/copies (R/C) and modifications (M) all count as "edited" — the pre-rename path isn't tracked separately. */
export function fileRoleFromGitStatus(status: string): FileRole {
  if (status.startsWith('A')) return 'created';
  if (status.startsWith('D')) return 'deleted';
  return 'edited';
}

/**
 * Detects a `git commit` invocation (as opposed to `git commit-graph`,
 * `git log --grep=commit`, etc.) in an already-redacted command string, so
 * callers can auto-trigger `syncTaskGit` right after one succeeds — see
 * `commandLog`'s and `runTaskExec`'s use of this.
 *
 * Tokenizes each `&&`/`;`/`|`-separated segment and walks forward from a
 * `git` token, skipping option tokens (and, for a single-dash short option
 * like `-C <dir>`, its following value token) until it finds the first
 * non-option token — that token must be exactly `commit` for a match. This
 * is more reliable than a single regex for options that take a value
 * (`git -C repo commit ...`) without also matching unrelated subcommands
 * or flags that merely contain the word "commit".
 */
export function isGitCommitCommand(cmdRedacted: string): boolean {
  for (const segment of cmdRedacted.split(/&&|;|\|/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const gitIndex = tokens.indexOf('git');
    if (gitIndex === -1) continue;
    for (let i = gitIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith('-')) {
        // A single-dash short option without an "=" (e.g. `-C`) takes its
        // value as the next token; a long option (`--foo`) or one with an
        // inline value (`-c foo=bar` is passed as one token here anyway,
        // `--foo=bar`) does not need special handling beyond being skipped.
        if (!token.startsWith('--') && !token.includes('=')) i++;
        continue;
      }
      if (token === 'commit') return true;
      break; // first non-option token isn't "commit" -> not a commit invocation in this segment
    }
  }
  return false;
}

export interface SyncGitResult {
  branchChanged: boolean;
  newBranch: string | null;
  recordedCommits: GitLogEntry[];
}

/**
 * Syncs the current git state (branch + new commits) for `taskId` from the
 * repo at `repoRoot` into the store: updates the task's tracked branch if
 * it changed, and records any commits reachable from HEAD not already in
 * the store (deduped by sha, so this is safe to call repeatedly/idempotently).
 */
export function syncTaskGit(
  store: TaskStore,
  taskId: string,
  repoRoot: string,
  options: { commitLimit?: number } = {},
): SyncGitResult {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`No task found with id "${taskId}".`);
  }

  const branch = getCurrentBranch(repoRoot);
  const branchChanged = Boolean(branch) && branch !== task.branch;
  if (branchChanged) {
    store.updateTaskBranch(taskId, branch);
  }

  const alreadyRecorded = new Set(store.listCommits(taskId).map((c) => c.sha));
  const recent = listRecentCommits(repoRoot, options.commitLimit ?? 50);
  // A commit's sha is globally unique across all tasks (it belongs to
  // whichever task recorded it first), so skip ones already attributed
  // elsewhere too, not just ones already recorded against this task.
  const toRecord = recent.filter(
    (c) => !alreadyRecorded.has(c.sha) && !store.commitExists(c.sha),
  );

  // `git log` returns newest-first; record oldest-first so created_at ordering matches commit order.
  const recordedCommits: GitLogEntry[] = [];
  for (const commit of [...toRecord].reverse()) {
    store.recordCommit({ sha: commit.sha, taskId, message: commit.message || null });
    recordedCommits.push(commit);
    // Backfill `files` from the commit's own diff — this is what lets
    // `recentFiles` in status/resume/get_context reflect real work even for
    // CLI/MCP-driven sessions that have no editor-level "file saved" event
    // to hook into; every commit already carries its own file list for free.
    for (const changed of listCommitFiles(repoRoot, commit.sha)) {
      store.touchFile({ taskId, path: changed.path, role: fileRoleFromGitStatus(changed.status) });
    }
  }

  return { branchChanged, newBranch: branchChanged ? branch : null, recordedCommits };
}
