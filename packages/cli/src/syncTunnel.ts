import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { SyncConfig } from './syncConfig.js';

export const PROJECT_SYNC_CONFIG_RELATIVE_PATH = path.join('.github', 'ariadne-sync.json');

export interface SyncTunnelConfig {
  sshHost: string;
  sshUser: string;
  sshHostKey: string;
  remotePort: number;
  localPort: number;
}

export interface ProjectSyncConnection {
  profile: string;
  serverUrl: string;
  tunnel: SyncTunnelConfig;
}

interface CommandResult {
  status: number | null;
  error?: Error;
  stdout?: string;
}

interface CommandDependencies {
  runCommand?: (file: string, args: string[]) => CommandResult;
}

interface TunnelDependencies extends CommandDependencies {
  canReachServer?: (serverUrl: string) => Promise<boolean>;
  isTunnelActive?: (tunnel: SyncTunnelConfig, controlPath: string) => boolean;
  homeDir?: string;
}

interface BootstrapDependencies extends CommandDependencies {
  fileExists?: (filePath: string) => boolean;
  homeDir?: string;
  platform?: NodeJS.Platform;
  commandExists?: (command: string) => boolean;
  confirmTrust?: (host: string, fingerprint: string) => Promise<boolean>;
}

const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Ariadne sync connection config must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requireSafeString(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Invalid ${field} in ${PROJECT_SYNC_CONFIG_RELATIVE_PATH}.`);
  }
  return value;
}

function requirePort(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) {
    throw new Error(`Invalid ${field} in ${PROJECT_SYNC_CONFIG_RELATIVE_PATH}; expected an integer from 1 to 65535.`);
  }
  return value as number;
}

export function readProjectSyncConnection(projectRoot: string): ProjectSyncConnection {
  const configPath = path.join(projectRoot, PROJECT_SYNC_CONFIG_RELATIVE_PATH);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No ${PROJECT_SYNC_CONFIG_RELATIVE_PATH} found. Run "ariadne init" in this repository or create the connection config first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = requireObject(parsed);
  if (raw.version !== 1) {
    throw new Error(`Unsupported Ariadne sync connection config version in ${configPath}; expected version 1.`);
  }

  const profile = requireSafeString(raw.profile, 'profile', SAFE_PROFILE);
  const tunnel: SyncTunnelConfig = {
    sshHost: requireSafeString(raw.sshHost, 'sshHost', SAFE_HOST),
    sshUser: requireSafeString(raw.sshUser, 'sshUser', SAFE_USER),
    sshHostKey: requireSafeString(raw.sshHostKey, 'sshHostKey', SAFE_FINGERPRINT),
    remotePort: requirePort(raw.remotePort, 'remotePort'),
    localPort: requirePort(raw.localPort, 'localPort'),
  };
  return {
    profile,
    tunnel,
    serverUrl: `http://127.0.0.1:${tunnel.localPort}`,
  };
}

function defaultRunCommand(file: string, args: string[]): CommandResult {
  const captureOutput = file === 'ssh-keyscan';
  const result = spawnSync(file, args, captureOutput ? { encoding: 'utf8' } : { stdio: 'inherit' });
  return {
    status: result.status,
    error: result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : undefined,
  };
}

function assertCommandSucceeded(result: CommandResult, description: string): void {
  if (result.error) {
    throw new Error(`${description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function sshTarget(tunnel: SyncTunnelConfig): string {
  return `${tunnel.sshUser}@${tunnel.sshHost}`;
}

function sshStateDir(homeDir: string): string {
  return path.join(homeDir, '.ariadne', 'ssh');
}

function knownHostsPath(homeDir: string): string {
  return path.join(sshStateDir(homeDir), 'known_hosts');
}

function controlSocketPath(tunnel: SyncTunnelConfig, homeDir: string): string {
  const identity = `${tunnel.sshUser}@${tunnel.sshHost}:${tunnel.remotePort}:${tunnel.localPort}`;
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return path.join(sshStateDir(homeDir), `ariadne-${suffix}.sock`);
}

function defaultIsTunnelActive(tunnel: SyncTunnelConfig, controlPath: string): boolean {
  const result = spawnSync('ssh', ['-S', controlPath, '-O', 'check', sshTarget(tunnel)], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function strictHostArgs(homeDir: string): string[] {
  return ['-o', `UserKnownHostsFile=${knownHostsPath(homeDir)}`, '-o', 'StrictHostKeyChecking=yes'];
}

function batchAccessArgs(tunnel: SyncTunnelConfig, homeDir: string): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=5',
    ...strictHostArgs(homeDir),
    sshTarget(tunnel),
    'true',
  ];
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync(command, ['-V'], { stdio: 'ignore' });
  return !(result.error && 'code' in result.error && result.error.code === 'ENOENT');
}

async function defaultConfirmTrust(host: string, fingerprint: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot confirm the SSH host key for ${host} without an interactive terminal.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Trust SSH host ${host} with fingerprint ${fingerprint}? Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function fingerprintHostKey(keyscanLine: string): string {
  const fields = keyscanLine.trim().split(/\s+/);
  if (fields.length < 3 || fields[1] !== 'ssh-ed25519') {
    throw new Error('ssh-keyscan did not return a valid ED25519 host key.');
  }
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(fields[2], 'base64');
  } catch {
    throw new Error('ssh-keyscan returned an invalid base64 host key.');
  }
  return `SHA256:${createHash('sha256').update(keyBytes).digest('base64').replace(/=+$/, '')}`;
}

async function installPinnedHostKey(
  tunnel: SyncTunnelConfig,
  homeDir: string,
  runCommand: (file: string, args: string[]) => CommandResult,
  confirmTrust: (host: string, fingerprint: string) => Promise<boolean>,
): Promise<void> {
  const scan = runCommand('ssh-keyscan', ['-T', '5', '-t', 'ed25519', tunnel.sshHost]);
  assertCommandSucceeded(scan, `Reading the SSH host key for ${tunnel.sshHost}`);
  const keyLine = scan.stdout?.split('\n').find((line) => line.trim() && !line.startsWith('#'));
  if (!keyLine) throw new Error(`ssh-keyscan returned no ED25519 host key for ${tunnel.sshHost}.`);

  const fingerprint = fingerprintHostKey(keyLine);
  if (fingerprint !== tunnel.sshHostKey) {
    throw new Error(
      `The SSH host key for ${tunnel.sshHost} (${fingerprint}) does not match the pinned fingerprint (${tunnel.sshHostKey}).`,
    );
  }

  const hostsPath = knownHostsPath(homeDir);
  const existing = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf8') : '';
  const alreadyTrusted = existing.split('\n').some((line) => {
    if (!line.trim() || line.startsWith('#')) return false;
    try {
      return fingerprintHostKey(line) === fingerprint && line.split(/\s+/)[0] === tunnel.sshHost;
    } catch {
      return false;
    }
  });
  if (!alreadyTrusted) {
    if (!(await confirmTrust(tunnel.sshHost, fingerprint))) {
      throw new Error(`SSH host key for ${tunnel.sshHost} was not trusted; setup cancelled.`);
    }
    fs.mkdirSync(path.dirname(hostsPath), { recursive: true, mode: 0o700 });
    const retained = existing
      .split('\n')
      .filter((line) => line.trim() && line.split(/\s+/)[0] !== tunnel.sshHost);
    fs.writeFileSync(hostsPath, `${retained.length > 0 ? `${retained.join('\n')}\n` : ''}${keyLine.trim()}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(hostsPath, 0o600);
  }
}

export async function bootstrapSshAccess(
  tunnel: SyncTunnelConfig,
  dependencies: BootstrapDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error(
      'Ariadne SSH tunnel setup currently requires Unix-like OpenSSH (Linux, macOS, or WSL). On Windows, run it from WSL.',
    );
  }
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  for (const command of ['ssh', 'ssh-keygen', 'ssh-keyscan', 'ssh-copy-id']) {
    if (!commandExists(command)) {
      throw new Error(`Required OpenSSH command "${command}" was not found on PATH.`);
    }
  }

  const homeDir = dependencies.homeDir ?? os.homedir();
  await installPinnedHostKey(tunnel, homeDir, runCommand, dependencies.confirmTrust ?? defaultConfirmTrust);

  const initial = runCommand('ssh', batchAccessArgs(tunnel, homeDir));
  if (!initial.error && initial.status === 0) return;

  const fileExists = dependencies.fileExists ?? fs.existsSync;
  const privateKeyPath = path.join(homeDir, '.ssh', 'id_ed25519');
  const publicKeyPath = `${privateKeyPath}.pub`;
  if (!fileExists(publicKeyPath)) {
    fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
    assertCommandSucceeded(
      runCommand('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', privateKeyPath]),
      'SSH key generation',
    );
  }

  assertCommandSucceeded(
    runCommand('ssh-copy-id', ['-i', publicKeyPath, ...strictHostArgs(homeDir), sshTarget(tunnel)]),
    `Installing the SSH public key on ${tunnel.sshHost}`,
  );
  assertCommandSucceeded(
    runCommand('ssh', batchAccessArgs(tunnel, homeDir)),
    `Verifying key-based SSH access to ${tunnel.sshHost}`,
  );
}

export async function canReachSyncServer(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverUrl}/healthz`, {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureSshTunnel(tunnel: SyncTunnelConfig, dependencies: TunnelDependencies = {}): Promise<void> {
  const serverUrl = `http://127.0.0.1:${tunnel.localPort}`;
  const canReachServer = dependencies.canReachServer ?? canReachSyncServer;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const stateDir = sshStateDir(homeDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const controlPath = controlSocketPath(tunnel, homeDir);
  const isTunnelActive = dependencies.isTunnelActive ?? defaultIsTunnelActive;

  const active = isTunnelActive(tunnel, controlPath);
  const reachable = await canReachServer(serverUrl);
  if (active && reachable) return;
  if (active && !reachable) {
    throw new Error(`The Ariadne SSH tunnel is active, but the sync server is not healthy at ${serverUrl}.`);
  }
  if (!active && reachable) {
    throw new Error(
      `Local port ${tunnel.localPort} is already in use by a process that is not the Ariadne SSH tunnel; refusing to send credentials.`,
    );
  }

  fs.rmSync(controlPath, { force: true });
  assertCommandSucceeded(
    runCommand('ssh', [
      '-M',
      '-S',
      controlPath,
      '-f',
      '-N',
      '-o',
      'BatchMode=yes',
      ...strictHostArgs(homeDir),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=60',
      '-o',
      'ServerAliveCountMax=3',
      '-L',
      `127.0.0.1:${tunnel.localPort}:127.0.0.1:${tunnel.remotePort}`,
      sshTarget(tunnel),
    ]),
    `Starting the SSH tunnel to ${tunnel.sshHost}`,
  );

  if (!isTunnelActive(tunnel, controlPath) || !(await canReachServer(serverUrl))) {
    throw new Error(
      `SSH tunnel started but the Ariadne sync server is not reachable at ${serverUrl}. Check the sync-server service on ${tunnel.sshHost}.`,
    );
  }
}

export async function ensureConfiguredSyncTunnel(config: SyncConfig): Promise<SyncConfig> {
  if (config.tunnel) {
    await ensureSshTunnel(config.tunnel);
  }
  return config;
}

export async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Ariadne password input requires an interactive terminal.');
  }

  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(Boolean(wasRaw));
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Password prompt cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char >= ' ') {
          value += char;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
