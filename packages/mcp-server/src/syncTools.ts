import { execFileSync } from 'node:child_process';

/**
 * Thin wrappers that shell out to the globally-installed `ariadne` CLI
 * binary for cloud sync operations, rather than reimplementing the sync
 * client/auth/config logic here. Sync (network calls, credentials,
 * per-profile config in `~/.ariadne/sync-config.json`) is owned entirely by
 * `@ariadne-dev/cli` — this keeps that single source of truth instead of
 * duplicating it into a second package. It assumes `ariadne` is on `PATH`,
 * which is true whenever the CLI and this MCP server are installed together
 * (see docs/06-QUICKSTART.md / the install scripts) — the same assumption
 * the VS Code extension's sync commands make.
 *
 * Deliberately NOT exposed here: `login`/`register`/`logout` and `profile
 * use` — these mutate stored credentials/which-profile-is-default, which
 * should stay a deliberate human action taken via the CLI directly, not
 * something an AI agent can trigger autonomously through an MCP tool call.
 */

export interface SyncCliOptions {
  /** Workspace root to run the command in (so the CLI resolves the right `.ariadne/state.db`). */
  cwd: string;
  /** Named sync profile to use, if not the current default (see `ariadne sync profile list`). */
  profile?: string;
}

function runAriadneCli(args: string[], cwd: string): string {
  try {
    return execFileSync('ariadne', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).toString().trim();
    throw new Error(`ariadne ${args.join(' ')} failed: ${detail || 'unknown error'}`);
  }
}

/** `ariadne sync push [--task <id>] [--profile <name>]` */
export function syncPush(options: SyncCliOptions & { taskId?: string }): string {
  const args = ['sync', 'push'];
  if (options.taskId) args.push('--task', options.taskId);
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneCli(args, options.cwd);
}

/** `ariadne sync pull [--task <id>] [--import-new] [--on-conflict <remote-wins|local-wins>] [--profile <name>]` */
export function syncPull(options: SyncCliOptions & { taskId?: string; importNew?: boolean; onConflict?: 'remote-wins' | 'local-wins' }): string {
  const args = ['sync', 'pull'];
  if (options.taskId) args.push('--task', options.taskId);
  if (options.importNew) args.push('--import-new');
  if (options.onConflict) args.push('--on-conflict', options.onConflict);
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneCli(args, options.cwd);
}

/** `ariadne sync list-remote [--profile <name>]` */
export function syncListRemote(options: SyncCliOptions): string {
  const args = ['sync', 'list-remote'];
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneCli(args, options.cwd);
}

/** `ariadne sync profile list` — read-only, so safe to expose alongside push/pull/list-remote. */
export function syncProfileList(options: { cwd: string }): string {
  return runAriadneCli(['sync', 'profile', 'list'], options.cwd);
}
