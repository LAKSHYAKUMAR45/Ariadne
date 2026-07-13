import { execFileSync } from 'node:child_process';

/**
 * Thin wrappers that shell out to the globally-installed `ariadne` CLI
 * binary for cloud sync operations, mirroring `packages/mcp-server/src/syncTools.ts`.
 * The extension deliberately does not reimplement sync's network/auth/config
 * logic — `@ariadne-dev/cli` remains the single source of truth for that;
 * this just runs it and relays its output into the "Ariadne" output channel.
 * Kept vscode-independent so it's unit-testable without mocking `vscode`.
 */

export interface SyncCliOptions {
  cwd: string;
  profile?: string;
}

export function runAriadneSyncCli(args: string[], cwd: string): string {
  try {
    return execFileSync('ariadne', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).toString().trim();
    throw new Error(`ariadne ${args.join(' ')} failed: ${detail || 'unknown error'}`);
  }
}

/** `ariadne sync push [--profile <name>]` */
export function syncPush(options: SyncCliOptions): string {
  const args = ['sync', 'push'];
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneSyncCli(args, options.cwd);
}

/** `ariadne sync pull [--import-new] [--on-conflict <remote-wins|local-wins>] [--profile <name>]` */
export function syncPull(options: SyncCliOptions & { importNew?: boolean; onConflict?: 'remote-wins' | 'local-wins' }): string {
  const args = ['sync', 'pull'];
  if (options.importNew) args.push('--import-new');
  if (options.onConflict) args.push('--on-conflict', options.onConflict);
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneSyncCli(args, options.cwd);
}

/** `ariadne sync list-remote [--profile <name>]` */
export function syncListRemote(options: SyncCliOptions): string {
  const args = ['sync', 'list-remote'];
  if (options.profile) args.push('--profile', options.profile);
  return runAriadneSyncCli(args, options.cwd);
}
