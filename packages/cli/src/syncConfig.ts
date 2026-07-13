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
 *
 * Supports multiple named **profiles** (e.g. one per team/employer/sync
 * server), so a machine used across several projects/orgs isn't limited to
 * a single serverUrl+token. One profile is always "current" (used when a
 * command omits `--profile`); `ariadne sync login --profile <name>` creates
 * or updates a profile and makes it current, `ariadne sync profile use
 * <name>` switches which one is current without logging in again, and
 * `ariadne sync profile list` shows what's configured.
 */
export interface SyncConfig {
  serverUrl: string;
  token: string;
  username: string;
  /** `serverTime` from the last successful tasks pull response; used as the next pull's `since`. Omitted before the first pull (a first pull fetches everything). */
  lastTasksPullAt?: string;
  /** Per-remote-task-id `serverTime` from the last successful checkpoints pull for that task. */
  checkpointsPullAt?: Record<string, string>;
  /** Per-remote-task-id `serverTime` cursors for the other sub-entity types, same shape/purpose as `checkpointsPullAt`. */
  todosPullAt?: Record<string, string>;
  decisionsPullAt?: Record<string, string>;
  errorsPullAt?: Record<string, string>;
  openQuestionsPullAt?: Record<string, string>;
  commandsPullAt?: Record<string, string>;
}

export const DEFAULT_SYNC_PROFILE = 'default';

interface SyncConfigFile {
  version: 2;
  currentProfile: string;
  profiles: Record<string, SyncConfig>;
}

function emptyFile(): SyncConfigFile {
  return { version: 2, currentProfile: DEFAULT_SYNC_PROFILE, profiles: {} };
}

/**
 * Reads raw JSON off disk and upgrades it to the multi-profile shape if
 * it's still in the pre-profiles (single serverUrl/token/username at the
 * top level) format, so machines that logged in before profiles existed
 * keep working with no manual migration step.
 */
function migrate(raw: unknown): SyncConfigFile {
  if (raw && typeof raw === 'object' && (raw as SyncConfigFile).version === 2 && (raw as SyncConfigFile).profiles) {
    return raw as SyncConfigFile;
  }
  if (raw && typeof raw === 'object' && 'serverUrl' in raw) {
    return { version: 2, currentProfile: DEFAULT_SYNC_PROFILE, profiles: { [DEFAULT_SYNC_PROFILE]: raw as SyncConfig } };
  }
  return emptyFile();
}

export function getSyncConfigPath(): string {
  return process.env.ARIADNE_SYNC_CONFIG_PATH ?? path.join(os.homedir(), '.ariadne', 'sync-config.json');
}

function readFile(): SyncConfigFile {
  const configPath = getSyncConfigPath();
  if (!fs.existsSync(configPath)) return emptyFile();
  try {
    return migrate(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch {
    return emptyFile();
  }
}

function writeFile(file: SyncConfigFile): void {
  const configPath = getSyncConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(file, null, 2), 'utf8');
}

/** Reads a profile's config (defaults to whichever profile is current). */
export function readSyncConfig(profileName?: string): SyncConfig | undefined {
  const file = readFile();
  const name = profileName ?? file.currentProfile ?? DEFAULT_SYNC_PROFILE;
  return file.profiles[name];
}

/**
 * Writes a profile's config. Deliberately does NOT change which profile is
 * "current" — that's only changed by `setCurrentSyncProfile` (used by
 * `login`/`register`/`profile use`), so routine cursor updates from `push`/
 * `pull` against a non-current `--profile` never silently switch the
 * default out from under the user.
 */
export function writeSyncConfig(config: SyncConfig, profileName?: string): void {
  const file = readFile();
  const name = profileName ?? file.currentProfile ?? DEFAULT_SYNC_PROFILE;
  file.profiles[name] = config;
  if (!file.currentProfile) file.currentProfile = name;
  writeFile(file);
}

/** Makes `name` the current profile (used implicitly by commands run without `--profile`). Throws if it doesn't exist. */
export function setCurrentSyncProfile(name: string): void {
  const file = readFile();
  if (!file.profiles[name]) {
    const known = Object.keys(file.profiles);
    const knownNote = known.length > 0 ? ` Known profiles: ${known.join(', ')}.` : ' No profiles are configured yet.';
    throw new Error(`No sync profile named "${name}".${knownNote}`);
  }
  file.currentProfile = name;
  writeFile(file);
}

/** Lists every configured profile, flagging which one is current. Used by `ariadne sync profile list`. */
export function listSyncProfiles(): { name: string; config: SyncConfig; current: boolean }[] {
  const file = readFile();
  const currentName = file.currentProfile ?? DEFAULT_SYNC_PROFILE;
  return Object.entries(file.profiles).map(([name, config]) => ({ name, config, current: name === currentName }));
}

/** Reads a profile's config or exits with a helpful error — used by every `sync` subcommand except `login`/`register`/`profile`. */
export function requireSyncConfig(profileName?: string): SyncConfig {
  const config = readSyncConfig(profileName);
  if (!config) {
    const hint = profileName ? ` for profile "${profileName}"` : '';
    console.error(`Not logged in to a sync server${hint}. Run "ariadne sync login <username> <password> --server <url>" first.`);
    process.exit(1);
  }
  return config;
}
