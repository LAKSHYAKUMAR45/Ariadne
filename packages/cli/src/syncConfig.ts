import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Local credentials/config for `ariadne sync`, stored at
 * `~/.ariadne/sync-config.json` (mirrors `@ariadne-dev/core`'s
 * `~/.ariadne/registry.db` — one file per machine, not per workspace,
 * since a sync-server login is a machine/user-level thing, not tied to any
 * one project). `ARIADNE_SYNC_CONFIG_PATH` overrides the path, mainly for
 * tests.
 */
export interface SyncConfig {
  serverUrl: string;
  token: string;
  username: string;
  /** `serverTime` from the last successful tasks pull response; used as the next pull's `since`. Omitted before the first pull (a first pull fetches everything). */
  lastTasksPullAt?: string;
  /** Per-remote-task-id `serverTime` from the last successful checkpoints pull for that task. */
  checkpointsPullAt?: Record<string, string>;
}

export function getSyncConfigPath(): string {
  return process.env.ARIADNE_SYNC_CONFIG_PATH ?? path.join(os.homedir(), '.ariadne', 'sync-config.json');
}

export function readSyncConfig(): SyncConfig | undefined {
  const configPath = getSyncConfigPath();
  if (!fs.existsSync(configPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as SyncConfig;
  } catch {
    return undefined;
  }
}

export function writeSyncConfig(config: SyncConfig): void {
  const configPath = getSyncConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/** Reads the config or exits with a helpful error — used by every `sync` subcommand except `login`/`register`. */
export function requireSyncConfig(): SyncConfig {
  const config = readSyncConfig();
  if (!config) {
    console.error('Not logged in to a sync server. Run "ariadne sync login <username> <password> --server <url>" first.');
    process.exit(1);
  }
  return config;
}
