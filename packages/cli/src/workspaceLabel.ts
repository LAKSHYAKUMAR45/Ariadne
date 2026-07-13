import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Computes a short, human-readable label identifying "which repo, on which
 * machine" a task push came from — e.g. `laptop1:org/atom` or
 * `laptop1:my-folder` (falls back to the workspace's folder name if it
 * isn't a git repo or has no `origin` remote). Sent with every `sync push`
 * so the server (and teammates running `sync pull`/`sync list-remote`) can
 * tell tasks from different repos apart, not just different user accounts.
 * Recomputed fresh on every push (not cached/stored) since it's cheap and
 * stays accurate even if a workspace is renamed or its remote changes.
 */
export function getWorkspaceLabel(workspaceRoot: string): string {
  const hostname = os.hostname();
  const repoLabel = getRepoLabel(workspaceRoot);
  return `${hostname}:${repoLabel}`;
}

function getRepoLabel(workspaceRoot: string): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    const shorthand = shorthandFromRemoteUrl(url);
    if (shorthand) return shorthand;
  } catch {
    // Not a git repo, no `origin` remote, or `git` isn't installed — fall through to the folder name.
  }
  return path.basename(workspaceRoot);
}

/** Turns `git@github.com:org/repo.git` or `https://github.com/org/repo.git` into `org/repo`. */
function shorthandFromRemoteUrl(url: string): string | null {
  const sshMatch = url.match(/^[\w.-]+@[\w.-]+:(.+?)(\.git)?$/);
  if (sshMatch) return sshMatch[1];
  try {
    const parsed = new URL(url);
    const trimmed = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return trimmed || null;
  } catch {
    return null;
  }
}
