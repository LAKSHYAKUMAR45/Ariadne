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
  runCommand?: SyncCliRunner;
}

export interface SyncProfile {
  name: string;
  current: boolean;
  serverUrl?: string;
}

export type SyncCliRunner = (args: string[], cwd: string) => string;

const PROFILE_ROW = /^(\*)?\s*([A-Za-z0-9._-]+)(?:\s+(https?:\/\/\S+))?\s*$/;

export function runAriadneSyncCli(args: string[], cwd: string): string {
  try {
    return execFileSync('ariadne', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).toString().trim();
    throw new Error(`ariadne ${args.join(' ')} failed: ${detail || 'unknown error'}`);
  }
}

function runSyncCommand(options: SyncCliOptions, args: string[]): string {
  const runCommand = options.runCommand ?? runAriadneSyncCli;
  return runCommand(args, options.cwd);
}

export function parseSyncProfiles(output: string): SyncProfile[] {
  const profiles: SyncProfile[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    if (!line.startsWith('*') && !/^\s{2,}/.test(line)) {
      continue;
    }

    const match = line.match(PROFILE_ROW);
    if (!match) {
      continue;
    }

    const [, currentMarker, name, serverUrl] = match;
    profiles.push({
      name,
      current: currentMarker === '*',
      ...(serverUrl ? { serverUrl } : {}),
    });
  }

  return profiles;
}

/** `ariadne sync push [--profile <name>]` */
export function syncPush(options: SyncCliOptions): string {
  const args = ['sync', 'push'];
  if (options.profile) args.push('--profile', options.profile);
  return runSyncCommand(options, args);
}

/** `ariadne sync pull [--import-new] [--on-conflict <remote-wins|local-wins>] [--profile <name>]` */
export function syncPull(options: SyncCliOptions & { importNew?: boolean; onConflict?: 'remote-wins' | 'local-wins' }): string {
  const args = ['sync', 'pull'];
  if (options.importNew) args.push('--import-new');
  if (options.onConflict) args.push('--on-conflict', options.onConflict);
  if (options.profile) args.push('--profile', options.profile);
  return runSyncCommand(options, args);
}

/** `ariadne sync list-remote [--profile <name>]` */
export function syncListRemote(options: SyncCliOptions): string {
  const args = ['sync', 'list-remote'];
  if (options.profile) args.push('--profile', options.profile);
  return runSyncCommand(options, args);
}

/** `ariadne sync profile list [--profile <name>]` */
export function syncProfileList(options: SyncCliOptions): string {
  const args = ['sync', 'profile', 'list'];
  if (options.profile) args.push('--profile', options.profile);
  return runSyncCommand(options, args);
}
