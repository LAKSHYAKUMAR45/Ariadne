import { execFileSync } from 'node:child_process';
import type { TaskStore } from './TaskStore.js';

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
  }

  return { branchChanged, newBranch: branchChanged ? branch : null, recordedCommits };
}
