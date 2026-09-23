/**
 * Installation contract tests for the privileged nodem2 host artifacts.
 *
 * `scripts/install`, `scripts/transfer-admin`, and `scripts/rotate-encryption-key`
 * are POSIX shell and must run as root, so they are exercised through their
 * self-test harness (`ARIADNE_ADMIN_SELFTEST=1` plus an explicit throwaway
 * prefix) with fake `id`, `chown`, `getent`, `groupadd`, `systemctl`, and
 * `docker` executables placed first in `PATH`. The fakes record every
 * invocation so ownership intent, unit installation, and the SQL a transfer
 * really executes can be asserted without touching this host.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const deployDir = path.join(repoRoot, 'deploy', 'nodem2');
const scriptsDir = path.join(deployDir, 'scripts');
const systemdDir = path.join(deployDir, 'systemd');

const HEX_64 = /^[0-9a-f]{64}$/;
const EXISTING_KEY_MATERIAL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const EXISTING_TOKEN = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const EXISTING_COMPOSE_ENV = 'POSTGRES_PASSWORD=do-not-touch-this-secret\n';
const EXISTING_SERVER_ENV =
  'DATABASE_URL=postgres://ariadne@127.0.0.1:5432/ariadne_sync\nSYNC_SERVER_JWT_SECRET=do-not-touch-this-secret\nADMIN_PUBLIC_ORIGIN=http://127.0.0.1:14300\n';

const INSTALLED_EXECUTABLES = [
  'backup',
  'deployment-status',
  'deploy',
  'prune-backups',
  'rollback',
  'restart-postgres',
  'restart-sync-server',
  'restore-backup',
  'rotate-encryption-key',
  'status',
  'transfer-admin',
  'verify-backup',
];
const INSTALLED_LIBRARIES = ['lib-common'];
const INSTALLED_UNITS = [
  'ariadne-backup-verify.service',
  'ariadne-backup-verify.timer',
  'ariadne-backup.service',
  'ariadne-backup.timer',
  'ariadne-operator.service',
];

const tempRoots: string[] = [];

interface Harness {
  prefix: string;
  etcDir: string;
  keysDir: string;
  libDir: string;
  unitDir: string;
  tmpfilesDir: string;
  runDir: string;
  backupDir: string;
  stateDir: string;
  binDir: string;
  chownLog: string;
  systemctlLog: string;
  tmpfilesLog: string;
  groupaddLog: string;
  dockerLog: string;
  dockerStdin: string;
  gitLog: string;
  psqlLog: string;
}

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

function createHarness(): Harness {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-install-'));
  tempRoots.push(prefix);

  const binDir = path.join(prefix, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });

  const chownLog = path.join(prefix, 'chown.log');
  const systemctlLog = path.join(prefix, 'systemctl.log');
  const tmpfilesLog = path.join(prefix, 'tmpfiles.log');
  const groupaddLog = path.join(prefix, 'groupadd.log');
  const dockerLog = path.join(prefix, 'docker.log');
  const dockerStdin = path.join(prefix, 'docker.stdin');
  const gitLog = path.join(prefix, 'git.log');
  const psqlLog = path.join(prefix, 'psql.log');

  // Claims uid 0 without granting any privilege; the scripts must still refuse
  // to touch production paths because the self-test prefix is enforced.
  writeExecutable(
    path.join(binDir, 'id'),
    `#!/bin/sh
if [ -n "\${FAKE_ID_UID:-}" ] && [ "\${1:-}" = "-u" ]; then
  printf '%s\\n' "$FAKE_ID_UID"
  exit 0
fi
exec /usr/bin/id "$@"
`,
  );

  writeExecutable(
    path.join(binDir, 'chown'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CHOWN_LOG"
exit "\${FAKE_CHOWN_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'systemctl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
if [ "\${1:-}" = show ]; then
  printf '%s' "\${FAKE_SYSTEMCTL_SHOW_OUTPUT:-active\\nrunning\\nsuccess\\n}"
fi
exit "\${FAKE_SYSTEMCTL_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'systemd-tmpfiles'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMPFILES_LOG"
exit "\${FAKE_TMPFILES_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'getent'),
    `#!/bin/sh
if [ "\${FAKE_GROUP_EXISTS:-0}" = 1 ]; then
  printf '%s:x:%s:\\n' "\${2:-}" "\${FAKE_GROUP_GID:-10001}"
  exit 0
fi
exit 2
`,
  );

  writeExecutable(
    path.join(binDir, 'groupadd'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GROUPADD_LOG"
exit "\${FAKE_GROUPADD_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" ps "*)
  printf '%s' "\${FAKE_DOCKER_PS_OUTPUT:-}"
    ;;
esac
case "$*" in
  *"SELECT value FROM schema_meta"*)
    printf '%s' "\${FAKE_DOCKER_PSQL_OUTPUT:-10\\n}"
    ;;
esac
cat >> "$FAKE_DOCKER_STDIN"
exit "\${FAKE_DOCKER_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "\${1:-}" = -C ]; then shift 2; fi
case "\${1:-}" in
  rev-parse)
    if printf '%s' "$*" | grep -q 'HEAD'; then
      printf '%s\\n' "\${FAKE_GIT_HEAD:-${'a'.repeat(40)}}"
    else
      printf '%s\\n' "\${FAKE_GIT_TRUSTED_TIP:-${'b'.repeat(40)}}"
    fi
    ;;
  log)
    if [ "\${FAKE_GIT_LOG_OUTPUT+x}" = x ]; then
      printf '%s' "$FAKE_GIT_LOG_OUTPUT"
    else
      printf '%s' "${'c'.repeat(40)}\t2026-09-23T10:20:00Z\tfeat: release candidate\\n"
    fi
    ;;
esac
exit "\${FAKE_GIT_EXIT:-0}"
`,
  );

  writeExecutable(
    path.join(binDir, 'psql'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_PSQL_LOG"
printf '%s' "\${FAKE_PSQL_OUTPUT:-10\\n}"
`,
  );

  return {
    prefix,
    etcDir: path.join(prefix, 'etc', 'ariadne'),
    keysDir: path.join(prefix, 'etc', 'ariadne', 'keys'),
    libDir: path.join(prefix, 'usr', 'local', 'lib', 'ariadne'),
    unitDir: path.join(prefix, 'etc', 'systemd', 'system'),
    tmpfilesDir: path.join(prefix, 'etc', 'tmpfiles.d'),
    runDir: path.join(prefix, 'run', 'ariadne'),
    backupDir: path.join(prefix, 'var', 'backups', 'ariadne'),
    stateDir: path.join(prefix, 'var', 'lib', 'ariadne', 'deploy'),
    binDir,
    chownLog,
    systemctlLog,
    tmpfilesLog,
    groupaddLog,
    dockerLog,
    dockerStdin,
    gitLog,
    psqlLog,
  };
}

interface RunOptions {
  args?: string[];
  env?: Record<string, string>;
  selftest?: boolean;
}

function runScript(harness: Harness, script: string, options: RunOptions = {}) {
  const selftest = options.selftest ?? true;
  const env: Record<string, string> = {
    PATH: `${harness.binDir}:${process.env.PATH ?? ''}`,
    HOME: harness.prefix,
    FAKE_ID_UID: '0',
    FAKE_CHOWN_LOG: harness.chownLog,
    FAKE_SYSTEMCTL_LOG: harness.systemctlLog,
    FAKE_TMPFILES_LOG: harness.tmpfilesLog,
    FAKE_GROUPADD_LOG: harness.groupaddLog,
    FAKE_DOCKER_LOG: harness.dockerLog,
    FAKE_DOCKER_STDIN: harness.dockerStdin,
    FAKE_GIT_LOG: harness.gitLog,
    FAKE_PSQL_LOG: harness.psqlLog,
    ...(selftest
      ? {
          ARIADNE_ADMIN_SELFTEST: '1',
          ARIADNE_ADMIN_PREFIX: harness.prefix,
          ARIADNE_ADMIN_OWNER_UID: String(process.getuid?.() ?? 0),
        }
      : {}),
    ...options.env,
  };

  return spawnSync(path.join(scriptsDir, script), options.args ?? [], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function runInstalledScript(harness: Harness, script: string, options: RunOptions = {}) {
  const selftest = options.selftest ?? true;
  const env: Record<string, string> = {
    PATH: `${harness.binDir}:${process.env.PATH ?? ''}`,
    HOME: harness.prefix,
    FAKE_ID_UID: String(process.getuid?.() ?? 0),
    FAKE_CHOWN_LOG: harness.chownLog,
    FAKE_SYSTEMCTL_LOG: harness.systemctlLog,
    FAKE_TMPFILES_LOG: harness.tmpfilesLog,
    FAKE_GROUPADD_LOG: harness.groupaddLog,
    FAKE_DOCKER_LOG: harness.dockerLog,
    FAKE_DOCKER_STDIN: harness.dockerStdin,
    FAKE_GIT_LOG: harness.gitLog,
    FAKE_PSQL_LOG: harness.psqlLog,
    ...(selftest
      ? {
          ARIADNE_ADMIN_SELFTEST: '1',
          ARIADNE_ADMIN_PREFIX: harness.prefix,
          ARIADNE_ADMIN_OWNER_UID: String(process.getuid?.() ?? 0),
        }
      : {}),
    ...options.env,
  };

  return spawnSync(path.join(harness.libDir, script), options.args ?? [], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
}

function output(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

function readLog(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function modeOf(target: string): string {
  return (fs.statSync(target).mode & 0o7777).toString(8).padStart(3, '0');
}

function seedSecrets(harness: Harness): void {
  fs.mkdirSync(harness.etcDir, { recursive: true, mode: 0o750 });
  fs.chmodSync(harness.etcDir, 0o750);
  fs.writeFileSync(path.join(harness.etcDir, 'compose.env'), EXISTING_COMPOSE_ENV, { mode: 0o600 });
  fs.writeFileSync(path.join(harness.etcDir, 'sync-server.env'), EXISTING_SERVER_ENV, {
    mode: 0o600,
  });
}

function seedKeys(harness: Harness): void {
  fs.mkdirSync(harness.keysDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(harness.keysDir, 0o700);
  fs.writeFileSync(path.join(harness.keysDir, 'primary.key'), EXISTING_KEY_MATERIAL, {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(harness.keysDir, 'active-key-id'), 'primary\n', { mode: 0o600 });
}

function seedComposeStack(harness: Harness): void {
  const worktreeDeploy = path.join(harness.prefix, 'opt', 'ariadne', 'worktree', 'deploy', 'nodem2');
  fs.mkdirSync(worktreeDeploy, { recursive: true });
  fs.writeFileSync(path.join(worktreeDeploy, 'compose.yaml'), 'services: {}\n');
}

function seedDeploymentStatusInputs(harness: Harness): void {
  seedComposeStack(harness);
  for (const directory of [
    path.join(harness.prefix, 'opt'),
    path.join(harness.prefix, 'opt', 'ariadne'),
    path.join(harness.prefix, 'opt', 'ariadne', 'worktree'),
    path.join(harness.prefix, 'opt', 'ariadne', 'worktree', '.git'),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.chmodSync(directory, 0o755);
  }
  fs.mkdirSync(harness.stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(harness.stateDir, 0o700);
}

function listKeyFiles(harness: Harness): string[] {
  if (!fs.existsSync(harness.keysDir)) return [];
  return fs
    .readdirSync(harness.keysDir)
    .filter((entry) => entry.endsWith('.key'))
    .sort();
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('install script', () => {
  it('creates the service group and every fixed directory with restrictive modes', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install');

    expect(output(result)).not.toMatch(/error/i);
    expect(result.status).toBe(0);

    expect(modeOf(harness.libDir)).toBe('755');
    expect(modeOf(harness.etcDir)).toBe('750');
    expect(modeOf(harness.keysDir)).toBe('700');
    expect(modeOf(harness.backupDir)).toBe('700');
    expect(modeOf(harness.stateDir)).toBe('700');
    expect(modeOf(harness.runDir)).toBe('750');

    // The container runs the web tier as uid/gid 10001, so the host group that
    // owns the operator socket and callback token must use the same gid.
    expect(readLog(harness.groupaddLog).join('\n')).toMatch(/--gid 10001[\s\S]*ariadne-web/);
    const chowns = readLog(harness.chownLog).join('\n');
    expect(chowns).toContain(`root:ariadne-web ${harness.runDir}`);
    expect(chowns).toContain(`root:root ${harness.keysDir}`);
  });

  it('reuses an existing service group instead of recreating it', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install', { env: { FAKE_GROUP_EXISTS: '1' } });

    expect(result.status).toBe(0);
    expect(readLog(harness.groupaddLog)).toEqual([]);
  });

  it('refuses a pre-existing service group with a conflicting gid', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install', {
      env: { FAKE_GROUP_EXISTS: '1', FAKE_GROUP_GID: '9999' },
    });

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('10001');
    expect(fs.existsSync(harness.libDir)).toBe(false);
  });

  it('copies only the tracked script allowlist with fixed modes', () => {
    const harness = createHarness();
    expect(runScript(harness, 'install').status).toBe(0);

    expect(fs.readdirSync(harness.libDir).sort()).toEqual(
      [...INSTALLED_EXECUTABLES, ...INSTALLED_LIBRARIES].sort(),
    );
    for (const name of INSTALLED_EXECUTABLES) {
      expect(modeOf(path.join(harness.libDir, name))).toBe('755');
      expect(fs.readFileSync(path.join(harness.libDir, name), 'utf8')).toBe(
        fs.readFileSync(path.join(scriptsDir, name), 'utf8'),
      );
    }
    for (const name of INSTALLED_LIBRARIES) {
      expect(modeOf(path.join(harness.libDir, name))).toBe('644');
    }
    // Container-only artifacts must never land on the host.
    expect(fs.existsSync(path.join(harness.libDir, 'sync-server-entrypoint'))).toBe(false);
    expect(fs.existsSync(path.join(harness.libDir, 'install'))).toBe(false);
  });

  it('installs and enables only the tracked units without starting them', () => {
    const harness = createHarness();
    expect(runScript(harness, 'install').status).toBe(0);

    expect(fs.readdirSync(harness.unitDir).sort()).toEqual([...INSTALLED_UNITS].sort());
    for (const unit of INSTALLED_UNITS) {
      expect(modeOf(path.join(harness.unitDir, unit))).toBe('644');
    }

    const systemctl = readLog(harness.systemctlLog);
    expect(systemctl[0]).toBe('daemon-reload');
    const enabled = systemctl.join('\n');
    expect(enabled).toContain('enable ariadne-operator.service');
    expect(enabled).toContain('ariadne-backup.timer');
    expect(enabled).toContain('ariadne-backup-verify.timer');
    expect(enabled).not.toContain('--now');
    expect(enabled).not.toContain('start ');
  });

  it('installs the runtime-directory tmpfiles rule so a fresh boot cannot race Docker', () => {
    const harness = createHarness();
    expect(runScript(harness, 'install').status).toBe(0);

    const installed = path.join(harness.tmpfilesDir, 'ariadne.conf');
    expect(fs.readFileSync(installed, 'utf8')).toBe(
      fs.readFileSync(path.join(deployDir, 'tmpfiles', 'ariadne.conf'), 'utf8'),
    );
    expect(modeOf(installed)).toBe('644');
    // Applied immediately so the very first install needs no reboot, and the
    // containers can only ever see the directory the operator owns.
    expect(readLog(harness.tmpfilesLog).join('\n')).toContain('--create');
  });

  it('installs and runs the tracked read scripts with strict JSON output', () => {
    const harness = createHarness();
    seedSecrets(harness);
    seedKeys(harness);
    seedDeploymentStatusInputs(harness);

    expect(runScript(harness, 'install').status).toBe(0);
    expect(modeOf(path.join(harness.libDir, 'status'))).toBe('755');
    expect(modeOf(path.join(harness.libDir, 'deployment-status'))).toBe('755');
    expect(modeOf(path.join(harness.libDir, 'rollback'))).toBe('755');

    const statusResult = runInstalledScript(harness, 'status', {
      env: {
        FAKE_SYSTEMCTL_SHOW_OUTPUT: 'active\nrunning\nsuccess\n',
        FAKE_DOCKER_PS_OUTPUT: 'sync-server running\npostgres running\n',
      },
    });
    expect(statusResult.status).toBe(0);
    const status = JSON.parse(statusResult.stdout) as unknown;
    expect(status).toEqual({
      services: [
        { name: 'sync-server', state: 'running' },
        { name: 'operator', state: 'running' },
        { name: 'postgres', state: 'running' },
      ],
    });

    const deploymentResult = runInstalledScript(harness, 'deployment-status', {
      env: {
        FAKE_GIT_HEAD: 'a'.repeat(40),
        FAKE_GIT_LOG_OUTPUT: `${'c'.repeat(40)}\t2026-09-23T10:20:00Z\tfeat: release candidate\n`,
        FAKE_DOCKER_PSQL_OUTPUT: '10\n',
      },
    });
    expect(deploymentResult.status).toBe(0);
    const deployment = JSON.parse(deploymentResult.stdout) as Record<string, unknown>;
    expect(deployment).toMatchObject({
      currentRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
      rollbackRevision: null,
      schemaVersion: 10,
      candidates: expect.any(Array),
    });
  });

  it('fails status when service probes fail while preserving legitimate stopped states', () => {
    const harness = createHarness();
    seedSecrets(harness);
    seedKeys(harness);
    seedDeploymentStatusInputs(harness);
    expect(runScript(harness, 'install').status).toBe(0);

    const composeFailure = runInstalledScript(harness, 'status', {
      env: { FAKE_DOCKER_EXIT: '1' },
    });
    expect(composeFailure.status).not.toBe(0);
    expect(output(composeFailure)).toContain('service status is unavailable');

    const systemctlFailure = runInstalledScript(harness, 'status', {
      env: {
        FAKE_DOCKER_PS_OUTPUT: 'sync-server exited\npostgres running\n',
        FAKE_SYSTEMCTL_EXIT: '1',
      },
    });
    expect(systemctlFailure.status).not.toBe(0);
    expect(output(systemctlFailure)).toContain('operator status is unavailable');

    const stopped = runInstalledScript(harness, 'status', {
      env: {
        FAKE_DOCKER_PS_OUTPUT: 'sync-server exited\npostgres dead\n',
        FAKE_SYSTEMCTL_SHOW_OUTPUT: 'inactive\ndead\nsuccess\n',
      },
    });
    expect(stopped.status).toBe(0);
    expect(JSON.parse(stopped.stdout)).toEqual({
      services: [
        { name: 'sync-server', state: 'stopped' },
        { name: 'operator', state: 'stopped' },
        { name: 'postgres', state: 'stopped' },
      ],
    });
  });

  it('fails deployment status when rollback state is malformed or the trusted source is unavailable', () => {
    const harness = createHarness();
    seedSecrets(harness);
    seedKeys(harness);
    seedDeploymentStatusInputs(harness);
    expect(runScript(harness, 'install').status).toBe(0);

    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), 'not-a-sha\n');
    const malformedRollback = runInstalledScript(harness, 'deployment-status', {
      env: { FAKE_DOCKER_PSQL_OUTPUT: '10\n' },
    });
    expect(malformedRollback.status).not.toBe(0);
    expect(output(malformedRollback)).toContain('rollback revision is invalid');

    fs.rmSync(path.join(harness.stateDir, 'rollback-revision'));
    fs.writeFileSync(path.join(harness.stateDir, 'current-revision'), `${'a'.repeat(40)}\n`);
    const sourceFailure = runInstalledScript(harness, 'deployment-status', {
      env: { FAKE_GIT_EXIT: '1', FAKE_DOCKER_PSQL_OUTPUT: '10\n' },
    });
    expect(sourceFailure.status).not.toBe(0);
    expect(output(sourceFailure)).toContain('trusted candidate revisions are unavailable');

    const emptyCandidates = runInstalledScript(harness, 'deployment-status', {
      env: { FAKE_GIT_LOG_OUTPUT: '', FAKE_DOCKER_PSQL_OUTPUT: '10\n' },
    });
    expect(emptyCandidates.status).toBe(0);
    expect(JSON.parse(emptyCandidates.stdout)).toMatchObject({ candidates: [] });
  });

  it('generates one encryption key when none exists and never prints key bytes', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install');

    expect(result.status).toBe(0);
    const keys = listKeyFiles(harness);
    expect(keys).toHaveLength(1);

    const keyPath = path.join(harness.keysDir, keys[0]);
    const material = fs.readFileSync(keyPath, 'utf8');
    expect(material).toMatch(HEX_64);
    expect(modeOf(keyPath)).toBe('600');

    const activeKeyId = fs
      .readFileSync(path.join(harness.keysDir, 'active-key-id'), 'utf8')
      .trim();
    expect(`${activeKeyId}.key`).toBe(keys[0]);
    expect(activeKeyId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(modeOf(path.join(harness.keysDir, 'active-key-id'))).toBe('600');

    expect(output(result)).not.toContain(material);
  });

  it('preserves existing secrets and key material on re-installation', () => {
    const harness = createHarness();
    seedSecrets(harness);
    seedKeys(harness);

    const result = runScript(harness, 'install');
    expect(result.status).toBe(0);

    expect(fs.readFileSync(path.join(harness.etcDir, 'compose.env'), 'utf8')).toBe(
      EXISTING_COMPOSE_ENV,
    );
    expect(fs.readFileSync(path.join(harness.etcDir, 'sync-server.env'), 'utf8')).toBe(
      EXISTING_SERVER_ENV,
    );
    expect(listKeyFiles(harness)).toEqual(['primary.key']);
    expect(fs.readFileSync(path.join(harness.keysDir, 'primary.key'), 'utf8')).toBe(
      EXISTING_KEY_MATERIAL,
    );
    expect(
      fs.readFileSync(path.join(harness.keysDir, 'active-key-id'), 'utf8').trim(),
    ).toBe('primary');
    expect(output(result)).not.toContain(EXISTING_KEY_MATERIAL);
    expect(output(result)).not.toContain('do-not-touch-this-secret');
  });

  it('creates a 32-byte callback token readable only by root and the web group', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install');

    expect(result.status).toBe(0);
    const tokenPath = path.join(harness.runDir, 'operator-callback-token');
    const token = fs.readFileSync(tokenPath, 'utf8').trim();

    expect(token).toMatch(HEX_64);
    expect(modeOf(tokenPath)).toBe('640');
    expect(readLog(harness.chownLog).join('\n')).toContain(`root:ariadne-web ${tokenPath}`);
    expect(output(result)).not.toContain(token);
  });

  it('never rewrites an existing callback token', () => {
    const harness = createHarness();
    fs.mkdirSync(harness.runDir, { recursive: true, mode: 0o750 });
    fs.chmodSync(harness.runDir, 0o750);
    const tokenPath = path.join(harness.runDir, 'operator-callback-token');
    fs.writeFileSync(tokenPath, EXISTING_TOKEN, { mode: 0o640 });

    expect(runScript(harness, 'install').status).toBe(0);
    expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe(EXISTING_TOKEN);
  });

  it('is idempotent: a second run changes no generated material', () => {
    const harness = createHarness();
    expect(runScript(harness, 'install').status).toBe(0);

    const keyName = listKeyFiles(harness)[0];
    const keyMaterial = fs.readFileSync(path.join(harness.keysDir, keyName), 'utf8');
    const token = fs.readFileSync(path.join(harness.runDir, 'operator-callback-token'), 'utf8');

    const second = runScript(harness, 'install');
    expect(second.status).toBe(0);
    expect(listKeyFiles(harness)).toEqual([keyName]);
    expect(fs.readFileSync(path.join(harness.keysDir, keyName), 'utf8')).toBe(keyMaterial);
    expect(fs.readFileSync(path.join(harness.runDir, 'operator-callback-token'), 'utf8')).toBe(
      token,
    );
  });

  it('prints explicit next steps for missing environment secrets without creating them', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install');

    expect(result.status).toBe(0);
    const text = output(result);
    expect(text).toContain('compose.env');
    expect(text).toContain('sync-server.env');
    expect(text).toContain('DATABASE_URL');
    expect(text).toContain('SYNC_SERVER_JWT_SECRET');
    expect(text).toContain('ADMIN_PUBLIC_ORIGIN');
    expect(text).toContain('POSTGRES_PASSWORD');
    expect(fs.existsSync(path.join(harness.etcDir, 'compose.env'))).toBe(false);
    expect(fs.existsSync(path.join(harness.etcDir, 'sync-server.env'))).toBe(false);
  });

  it('reports the missing variables of an incomplete environment file', () => {
    const harness = createHarness();
    fs.mkdirSync(harness.etcDir, { recursive: true, mode: 0o750 });
    fs.chmodSync(harness.etcDir, 0o750);
    fs.writeFileSync(path.join(harness.etcDir, 'compose.env'), EXISTING_COMPOSE_ENV, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(harness.etcDir, 'sync-server.env'), 'DATABASE_URL=set\n', {
      mode: 0o600,
    });

    const result = runScript(harness, 'install');
    expect(result.status).toBe(0);
    const text = output(result);
    expect(text).toContain('ADMIN_PUBLIC_ORIGIN');
    expect(text).toContain('SYNC_SERVER_JWT_SECRET');
    expect(text).not.toContain('do-not-touch-this-secret');
  });

  it('refuses to install into a directory owned by someone else', () => {
    const harness = createHarness();
    fs.mkdirSync(harness.etcDir, { recursive: true, mode: 0o750 });
    fs.chmodSync(harness.etcDir, 0o750);

    const result = runScript(harness, 'install', {
      env: { ARIADNE_ADMIN_OWNER_UID: '4242' },
    });

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('owned');
    expect(fs.existsSync(harness.libDir)).toBe(false);
    expect(readLog(harness.systemctlLog)).toEqual([]);
  });

  it('refuses to install into a group- or world-writable directory', () => {
    const harness = createHarness();
    fs.mkdirSync(harness.etcDir, { recursive: true });
    fs.chmodSync(harness.etcDir, 0o777);

    const result = runScript(harness, 'install');

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toContain('writable');
    expect(fs.existsSync(harness.libDir)).toBe(false);
    expect(readLog(harness.systemctlLog)).toEqual([]);
  });

  it('refuses to run as a non-root user', () => {
    const harness = createHarness();
    const result = runScript(harness, 'install', { env: { FAKE_ID_UID: '1000' } });

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toContain('root');
    expect(fs.existsSync(harness.libDir)).toBe(false);
  });

  it('refuses self-test mode and prefix overrides for privileged invocations', () => {
    const harness = createHarness();

    const selftestLeak = runScript(harness, 'install', {
      selftest: false,
      env: { ARIADNE_ADMIN_SELFTEST: 'yes' },
    });
    expect(selftestLeak.status).not.toBe(0);
    expect(output(selftestLeak)).toContain('ARIADNE_ADMIN_SELFTEST');

    const prefixLeak = runScript(harness, 'install', {
      selftest: false,
      env: { ARIADNE_ADMIN_PREFIX: harness.prefix },
    });
    expect(prefixLeak.status).not.toBe(0);
    expect(output(prefixLeak)).toContain('ARIADNE_ADMIN_PREFIX');
    expect(fs.existsSync(harness.libDir)).toBe(false);
  });

  it('refuses a self-test prefix that points at a real system directory', () => {
    const harness = createHarness();
    for (const prefix of ['/', '/etc', '/usr/local', '/var/lib']) {
      const result = runScript(harness, 'install', { env: { ARIADNE_ADMIN_PREFIX: prefix } });
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('ARIADNE_ADMIN_PREFIX');
    }
  });
});

describe('transfer-admin script', () => {
  function seedTransferHarness(): Harness {
    const harness = createHarness();
    seedSecrets(harness);
    seedKeys(harness);
    seedComposeStack(harness);
    return harness;
  }

  function executedSql(harness: Harness): string {
    return fs.existsSync(harness.dockerStdin)
      ? fs.readFileSync(harness.dockerStdin, 'utf8')
      : '';
  }

  it('requires uid 0', () => {
    const harness = seedTransferHarness();
    const result = runScript(harness, 'transfer-admin', {
      args: ['new-admin'],
      env: { FAKE_ID_UID: '1000' },
    });

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toContain('root');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('requires exactly one plausible username', () => {
    const harness = seedTransferHarness();

    expect(runScript(harness, 'transfer-admin').status).not.toBe(0);
    expect(runScript(harness, 'transfer-admin', { args: ['a', 'b'] }).status).not.toBe(0);

    for (const bad of ["bob'; DROP TABLE users;--", 'bob user', '../bob', '']) {
      const result = runScript(harness, 'transfer-admin', { args: [bad] });
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('username');
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('transfers in one locked transaction that preserves exactly one admin', () => {
    const harness = seedTransferHarness();
    const result = runScript(harness, 'transfer-admin', { args: ['new-admin'] });

    expect(result.status).toBe(0);
    const invocation = readLog(harness.dockerLog).join('\n');
    expect(invocation).toContain('exec -T postgres psql');
    expect(invocation).toContain('ON_ERROR_STOP=1');
    expect(invocation).toContain('--single-transaction');

    const sql = executedSql(harness);
    // Locks the singleton team and its membership rows before reading roles.
    expect(sql).toMatch(/FROM teams[\s\S]*FOR UPDATE/);
    expect(sql).toMatch(/FROM team_memberships[\s\S]*FOR UPDATE/);
    // Demotes the incumbent and promotes the target inside the same statement
    // sequence, then refuses to commit unless exactly one admin remains.
    expect(sql).toContain("SET role = 'member'");
    expect(sql).toContain("SET role = 'admin'");
    expect(sql).toMatch(/count\(\*\)[\s\S]*<>\s*1/);
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('admin_audit_events');
    expect(sql).toContain('admin.transfer');
  });

  it('binds the username as a parameter rather than splicing it into SQL', () => {
    const harness = seedTransferHarness();
    const username = 'new-admin';
    expect(runScript(harness, 'transfer-admin', { args: [username] }).status).toBe(0);

    const sql = executedSql(harness);
    expect(sql).toContain('current_setting(');
    expect(sql).toContain("set_config('ariadne.transfer_username'");
    // The only occurrence of the raw name is inside the psql-quoted binding.
    expect(sql).not.toContain(`'${username}'`);
    expect(sql).not.toContain(`username = ${username}`);
  });

  it('fails loudly when the database rejects the transfer', () => {
    const harness = seedTransferHarness();
    const result = runScript(harness, 'transfer-admin', {
      args: ['new-admin'],
      env: { FAKE_DOCKER_EXIT: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toContain('transfer');
    expect(output(result).toLowerCase()).not.toContain('succeeded');
  });

  it('requires the deployment inputs before touching the database', () => {
    const harness = createHarness();
    const result = runScript(harness, 'transfer-admin', { args: ['new-admin'] });

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('compose.env');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });
});

describe('rotate-encryption-key script', () => {
  it('requires uid 0', () => {
    const harness = createHarness();
    seedKeys(harness);
    const result = runScript(harness, 'rotate-encryption-key', {
      env: { FAKE_ID_UID: '1000' },
    });

    expect(result.status).not.toBe(0);
    expect(output(result).toLowerCase()).toContain('root');
    expect(listKeyFiles(harness)).toEqual(['primary.key']);
  });

  it('creates a new 0600 key, switches active-key-id, and retains old keys', () => {
    const harness = createHarness();
    seedKeys(harness);

    const result = runScript(harness, 'rotate-encryption-key');
    expect(result.status).toBe(0);

    const keys = listKeyFiles(harness);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('primary.key');
    expect(fs.readFileSync(path.join(harness.keysDir, 'primary.key'), 'utf8')).toBe(
      EXISTING_KEY_MATERIAL,
    );

    const activeKeyId = fs
      .readFileSync(path.join(harness.keysDir, 'active-key-id'), 'utf8')
      .trim();
    expect(activeKeyId).not.toBe('primary');
    expect(keys).toContain(`${activeKeyId}.key`);

    const newKeyPath = path.join(harness.keysDir, `${activeKeyId}.key`);
    const material = fs.readFileSync(newKeyPath, 'utf8');
    expect(material).toMatch(HEX_64);
    expect(modeOf(newKeyPath)).toBe('600');
    expect(output(result)).not.toContain(material);
    expect(output(result)).not.toContain(EXISTING_KEY_MATERIAL);
  });

  it('leaves no temporary files behind and never truncates active-key-id', () => {
    const harness = createHarness();
    seedKeys(harness);
    expect(runScript(harness, 'rotate-encryption-key').status).toBe(0);

    const entries = fs.readdirSync(harness.keysDir);
    expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
    expect(
      fs.readFileSync(path.join(harness.keysDir, 'active-key-id'), 'utf8').trim().length,
    ).toBeGreaterThan(0);
  });

  it('refuses to rotate when the key directory is missing or insecure', () => {
    const missing = createHarness();
    const missingResult = runScript(missing, 'rotate-encryption-key');
    expect(missingResult.status).not.toBe(0);
    expect(output(missingResult)).toContain('keys');

    const insecure = createHarness();
    seedKeys(insecure);
    fs.chmodSync(insecure.keysDir, 0o777);
    const insecureResult = runScript(insecure, 'rotate-encryption-key');
    expect(insecureResult.status).not.toBe(0);
    expect(output(insecureResult).toLowerCase()).toContain('writable');
    expect(listKeyFiles(insecure)).toEqual(['primary.key']);
  });

  it('prints the follow-up restart instruction', () => {
    const harness = createHarness();
    seedKeys(harness);
    const result = runScript(harness, 'rotate-encryption-key');

    expect(result.status).toBe(0);
    expect(output(result)).toContain('restart-sync-server');
  });
});

describe('ariadne-operator.service unit', () => {
  const unitPath = path.join(systemdDir, 'ariadne-operator.service');

  function unit(): string {
    return fs.readFileSync(unitPath, 'utf8');
  }

  it('runs as root with the web group and the fixed socket path', () => {
    const text = unit();
    expect(text).toContain('User=root');
    expect(text).toContain('Group=ariadne-web');
    expect(text).toContain('Environment=OPERATOR_SOCKET_PATH=/run/ariadne/operator.sock');
    expect(text).toContain(
      'Environment=OPERATOR_CALLBACK_TOKEN_PATH=/run/ariadne/operator-callback-token',
    );
    expect(text).toMatch(/Environment=OPERATOR_CALLBACK_URL=http:\/\/127\.0\.0\.1:4300\//);
    expect(text).toContain('RuntimeDirectory=ariadne');
    expect(text).toContain('RuntimeDirectoryMode=0750');
  });

  it('keeps the filesystem and network surface minimal', () => {
    const text = unit();
    expect(text).toContain('NoNewPrivileges=true');
    expect(text).toContain('ProtectSystem=strict');
    expect(text).toContain('ProtectHome=true');
    expect(text).toContain('PrivateTmp=true');
    expect(text).toContain('ProtectKernelTunables=true');
    expect(text).toContain('ProtectKernelModules=true');
    expect(text).toContain('RestrictSUIDSGID=true');
    expect(text).toContain('LockPersonality=true');
    expect(text).toContain('SystemCallArchitectures=native');
    // The operator must refresh the trusted git ref before every deployment,
    // so egress denial is incompatible with its required work and must not be
    // reintroduced here.
    expect(text).not.toContain('IPAddressDeny');
    expect(text).not.toContain('IPAddressAllow');
    expect(text).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6');

    const writablePaths = [...text.matchAll(/^ReadWritePaths=(.+)$/gm)].map((match) =>
      match[1].trim(),
    );
    expect(writablePaths).toContain('/run/ariadne');
    expect(writablePaths).toContain('/var/backups/ariadne');
    expect(writablePaths).toContain('/var/lib/ariadne');
    expect(writablePaths).toContain('/run/docker.sock');
    expect(writablePaths).not.toContain('/etc');
    expect(writablePaths).not.toContain('/');
  });

  it('starts the built operator entry point without a shell', () => {
    const text = unit();
    const execStart = /^ExecStart=(.+)$/m.exec(text)?.[1] ?? '';
    expect(execStart).toMatch(
      /^\/usr\/bin\/node \/opt\/ariadne\/worktree\/packages\/operator\/dist\/index\.js$/,
    );
    expect(text).not.toContain('/bin/sh');
  });

  it('passes systemd-analyze verification when systemd is available', () => {
    const probe = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      return;
    }

    const verify = spawnSync('systemd-analyze', ['verify', unitPath], { encoding: 'utf8' });
    const text = `${verify.stdout}${verify.stderr}`;
    expect(text).not.toMatch(/Unknown lvalue|Failed to parse|Invalid/i);
  });
});

describe('deploy under the operator service', () => {
  it('treats a failed trusted-ref refresh as fatal instead of deploying a stale ref', () => {
    const deployScript = fs.readFileSync(path.join(scriptsDir, 'deploy'), 'utf8');
    const fetchLine = deployScript.slice(deployScript.indexOf('fetch --quiet'));
    expect(fetchLine.slice(0, 400)).toMatch(/fail "/);
    expect(deployScript).not.toMatch(/continuing with the last fetched/);
    // Reachability from the trusted ref stays enforced on top of the refresh.
    expect(deployScript).toContain('merge-base --is-ancestor');
  });
});
