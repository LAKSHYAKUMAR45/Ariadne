/**
 * Deployment contract tests for the tracked nodem2 Compose stack.
 *
 * The scripts under deploy/nodem2/scripts are POSIX shell, so they are tested
 * by executing them with fake `docker`, `git`, and `curl` executables placed
 * first in `PATH`. The fakes record every invocation so ordering, fixed paths,
 * rollback behaviour, and secret hygiene can be asserted.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const deployDir = path.join(repoRoot, 'deploy', 'nodem2');
const scriptsDir = path.join(deployDir, 'scripts');
const composeSource = path.join(deployDir, 'compose.yaml');

const VALID_SHA = 'a'.repeat(40);
const PREVIOUS_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const JWT_SECRET_VALUE = 'top-secret-jwt-value-must-never-be-printed';
const POSTGRES_PASSWORD_VALUE = 'top-secret-postgres-password-value';
const KEY_MATERIAL_VALUE = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

const tempRoots: string[] = [];

interface Harness {
  root: string;
  etcDir: string;
  keysDir: string;
  stateDir: string;
  worktree: string;
  composeFile: string;
  binDir: string;
  dockerLog: string;
  gitLog: string;
  curlLog: string;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-deploy-'));
  tempRoots.push(root);

  const etcDir = path.join(root, 'etc', 'ariadne');
  const keysDir = path.join(etcDir, 'keys');
  const stateDir = path.join(root, 'var', 'lib', 'ariadne', 'deploy');
  const deployRoot = path.join(root, 'opt', 'ariadne');
  const worktree = path.join(deployRoot, 'worktree');
  const worktreeDeployDir = path.join(worktree, 'deploy', 'nodem2');
  const binDir = path.join(root, 'bin');

  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(worktreeDeployDir, { recursive: true });
  fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  fs.writeFileSync(path.join(etcDir, 'compose.env'), `POSTGRES_PASSWORD=${POSTGRES_PASSWORD_VALUE}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(etcDir, 'sync-server.env'),
    `SYNC_SERVER_JWT_SECRET=${JWT_SECRET_VALUE}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(keysDir, 'active-key-id'), 'primary\n', { mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, 'primary.key'), `${KEY_MATERIAL_VALUE}\n`, { mode: 0o600 });

  const composeFile = path.join(worktreeDeployDir, 'compose.yaml');
  fs.writeFileSync(
    composeFile,
    fs.existsSync(composeSource) ? fs.readFileSync(composeSource) : Buffer.from('services: {}\n'),
  );

  const dockerLog = path.join(root, 'docker.log');
  const gitLog = path.join(root, 'git.log');
  const curlLog = path.join(root, 'curl.log');

  writeExecutable(
    path.join(binDir, 'docker'),
    `#!/bin/sh
printf '%s\\n' "SYNC_SERVER_IMAGE=\${SYNC_SERVER_IMAGE:-} :: $*" >> "$FAKE_DOCKER_LOG"
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  if [ "\${FAKE_DOCKER_NO_CURRENT:-0}" = 1 ]; then
    echo "Error: No such image" >&2
    exit 1
  fi
  echo "${PREVIOUS_IMAGE_ID}"
  exit 0
fi
for pattern in \${FAKE_DOCKER_FAIL:-}; do
  case "$*" in
    *"$pattern"*) echo "fake docker failure: $pattern" >&2; exit 1 ;;
  esac
done
exit 0
`,
  );

  writeExecutable(
    path.join(binDir, 'git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
if [ "\${1:-}" = -C ]; then shift 2; fi
case "\${1:-}" in
  status)
    if [ -n "\${FAKE_GIT_STATUS:-}" ]; then printf '%s\\n' "$FAKE_GIT_STATUS"; fi
    exit 0 ;;
  fetch) exit "\${FAKE_GIT_FETCH_EXIT:-0}" ;;
  rev-parse)
    case "$*" in
      *HEAD*) printf '%s\\n' "\${FAKE_GIT_HEAD:-${VALID_SHA}}" ;;
      *) printf '%s\\n' "\${FAKE_GIT_TRUSTED_TIP:-${'b'.repeat(40)}}" ;;
    esac
    exit 0 ;;
  merge-base) exit "\${FAKE_GIT_ANCESTOR_EXIT:-0}" ;;
  cat-file) exit "\${FAKE_GIT_CATFILE_EXIT:-0}" ;;
  checkout) exit "\${FAKE_GIT_CHECKOUT_EXIT:-0}" ;;
esac
exit 0
`,
  );

  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
exit "\${FAKE_CURL_EXIT:-0}"
`,
  );

  return { root, etcDir, keysDir, stateDir, worktree, composeFile, binDir, dockerLog, gitLog, curlLog };
}

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
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
    HOME: harness.root,
    FAKE_DOCKER_LOG: harness.dockerLog,
    FAKE_GIT_LOG: harness.gitLog,
    FAKE_CURL_LOG: harness.curlLog,
    ...(selftest
      ? {
          ARIADNE_DEPLOY_SELFTEST: '1',
          ARIADNE_DEPLOY_ROOT: path.join(harness.root, 'opt', 'ariadne'),
          ARIADNE_DEPLOY_ETC: harness.etcDir,
          ARIADNE_DEPLOY_STATE: harness.stateDir,
          ARIADNE_DEPLOY_HEALTH_ATTEMPTS: '2',
          ARIADNE_DEPLOY_HEALTH_INTERVAL: '0',
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

function readLog(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function indexOfMatch(lines: string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('deploy script', () => {
  it('validates config, builds, migrates, and starts in a safe order', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);

    const configIndex = indexOfMatch(docker, 'config --quiet');
    const buildIndex = indexOfMatch(docker, 'build sync-server');
    const migrateIndex = indexOfMatch(docker, 'run --rm');
    const upIndex = indexOfMatch(docker, 'up -d --no-deps sync-server');

    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(configIndex);
    expect(migrateIndex).toBeGreaterThan(buildIndex);
    expect(upIndex).toBeGreaterThan(migrateIndex);
    expect(docker[migrateIndex]).toContain('migrate');
    expect(readLog(harness.curlLog).join('\n')).toContain('/healthz');
  });

  it('builds an immutable candidate tag derived from the deployed revision', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const buildLine = docker[indexOfMatch(docker, 'build sync-server')];
    expect(buildLine).toContain(`SYNC_SERVER_IMAGE=ariadne-sync-server:${VALID_SHA}`);
  });

  it('uses fixed compose file, project name, and env files', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const composeLines = readLog(harness.dockerLog).filter((line) => line.includes(' compose '));
    expect(composeLines.length).toBeGreaterThan(0);
    for (const line of composeLines) {
      expect(line).toContain(`-f ${harness.composeFile}`);
      expect(line).toContain('-p ariadne-nodem2');
      expect(line).toContain(`--env-file ${path.join(harness.etcDir, 'compose.env')}`);
    }
  });

  it('ignores path overrides unless the self-test flag is set', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      selftest: false,
      env: {
        ARIADNE_DEPLOY_ROOT: path.join(harness.root, 'opt', 'ariadne'),
        ARIADNE_DEPLOY_ETC: harness.etcDir,
        ARIADNE_DEPLOY_STATE: harness.stateDir,
      },
    });

    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('/etc/ariadne');
    expect(output).not.toContain(harness.etcDir);
  });

  it('checks required secret and key files before invoking Compose', () => {
    const harness = createHarness();
    fs.rmSync(path.join(harness.etcDir, 'sync-server.env'));

    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('sync-server.env');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('requires the encryption key material before invoking Compose', () => {
    const harness = createHarness();
    fs.rmSync(path.join(harness.keysDir, 'active-key-id'));

    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('active-key-id');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('rejects a commit that is not reachable from the trusted remote ref', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_GIT_ANCESTOR_EXIT: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('trusted');
    expect(indexOfMatch(readLog(harness.dockerLog), 'build sync-server')).toBe(-1);
  });

  it('rejects a dirty deployment worktree', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_GIT_STATUS: ' M packages/sync-server/src/app.ts' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('dirty');
    expect(indexOfMatch(readLog(harness.dockerLog), 'build sync-server')).toBe(-1);
  });

  it('rejects revisions that are not full 40-character hex SHAs', () => {
    const harness = createHarness();
    for (const bad of ['main', 'abc123', `${'a'.repeat(39)}z`, `${VALID_SHA}extra`]) {
      const result = runScript(harness, 'deploy', { args: [bad] });
      expect(result.status).not.toBe(0);
      expect(readLog(harness.dockerLog)).toEqual([]);
    }
  });

  it('rejects an invocation without exactly one revision argument', () => {
    const harness = createHarness();
    expect(runScript(harness, 'deploy', { args: [] }).status).not.toBe(0);
    expect(runScript(harness, 'deploy', { args: [VALID_SHA, VALID_SHA] }).status).not.toBe(0);
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('records the rollback image target before replacing the app', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const recorded = fs.readFileSync(path.join(harness.stateDir, 'rollback-image'), 'utf8').trim();
    expect(recorded).toBe(PREVIOUS_IMAGE_ID);
  });

  it('rolls back to the prior image when health verification fails', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_CURL_EXIT: '7' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('rollback');

    const docker = readLog(harness.dockerLog);
    const rollbackLines = docker.filter(
      (line) =>
        line.includes('up -d --no-deps sync-server') &&
        line.includes(`SYNC_SERVER_IMAGE=${PREVIOUS_IMAGE_ID}`),
    );
    expect(rollbackLines.length).toBe(1);
    expect(docker[docker.length - 1]).toContain(`SYNC_SERVER_IMAGE=${PREVIOUS_IMAGE_ID}`);
  });

  it('fails without rollback when no prior image exists', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_CURL_EXIT: '7', FAKE_DOCKER_NO_CURRENT: '1' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog);
    expect(docker.filter((line) => line.includes('up -d --no-deps sync-server')).length).toBe(1);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('no previous image');
  });

  it('aborts before build when compose config validation fails', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_DOCKER_FAIL: 'config' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog);
    expect(indexOfMatch(docker, 'build sync-server')).toBe(-1);
    expect(indexOfMatch(docker, 'up -d --no-deps sync-server')).toBe(-1);
  });

  it('does not replace the app when migrations fail', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_DOCKER_FAIL: 'run --rm' },
    });

    expect(result.status).not.toBe(0);
    expect(indexOfMatch(readLog(harness.dockerLog), 'up -d --no-deps sync-server')).toBe(-1);
  });

  it('never prints secret values from key or env files', () => {
    const harness = createHarness();
    const results = [
      runScript(harness, 'deploy', { args: [VALID_SHA] }),
      runScript(harness, 'deploy', { args: [VALID_SHA], env: { FAKE_CURL_EXIT: '7' } }),
    ];

    for (const result of results) {
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(JWT_SECRET_VALUE);
      expect(output).not.toContain(POSTGRES_PASSWORD_VALUE);
      expect(output).not.toContain(KEY_MATERIAL_VALUE);
    }
  });
});

describe('restart scripts', () => {
  it('restarts only the sync-server service', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-sync-server');

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    expect(docker.length).toBe(1);
    expect(docker[0]).toContain(`-f ${harness.composeFile}`);
    expect(docker[0]).toContain('-p ariadne-nodem2');
    expect(docker[0]).toMatch(/restart sync-server$/);
    expect(docker[0]).not.toContain('postgres');
  });

  it('restarts only the postgres service', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-postgres');

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    expect(docker.length).toBe(1);
    expect(docker[0]).toMatch(/restart postgres$/);
    expect(docker[0]).not.toContain('sync-server');
  });

  it('rejects caller-supplied service arguments', () => {
    const harness = createHarness();
    for (const script of ['restart-sync-server', 'restart-postgres']) {
      const result = runScript(harness, script, { args: ['postgres'] });
      expect(result.status).not.toBe(0);
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });
});

describe('compose topology', () => {
  const compose = () => fs.readFileSync(composeSource, 'utf8');

  it('binds every published port to loopback only', () => {
    const ports = compose().match(/^\s*-\s*['"]?[^'"\s]+:\d+["']?\s*$/gm) ?? [];
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port).toContain('127.0.0.1:');
    }
    expect(compose()).toContain('127.0.0.1:4300:4300');
  });

  it('never mounts the Docker socket into a service', () => {
    expect(compose()).not.toContain('docker.sock');
  });

  it('hardens the sync-server runtime', () => {
    const text = compose();
    expect(text).toContain('read_only: true');
    expect(text).toContain('no-new-privileges:true');
    expect(text).toContain('cap_drop:');
    expect(text).toContain('/etc/ariadne/keys:/etc/ariadne/keys:ro');
    expect(text).toContain('init: true');
  });

  it('runs migrations as a one-shot service on the same image', () => {
    const text = compose();
    expect(text).toMatch(/migrate:[\s\S]*restart:\s*"?no"?/);
    expect(text.match(/\$\{SYNC_SERVER_IMAGE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('keeps the example env file free of secret values', () => {
    const example = fs.readFileSync(path.join(deployDir, '.env.example'), 'utf8');
    for (const line of example.split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      expect(line).toMatch(/^[A-Z0-9_]+=$/);
    }
  });

  it('grants the sync-server only the capabilities the startup handoff needs', () => {
    const syncServerBlock = compose().slice(compose().indexOf('  sync-server:'));
    const capAdd = syncServerBlock.slice(syncServerBlock.indexOf('cap_add:'));
    expect(capAdd).toContain('- CHOWN');
    expect(capAdd).toContain('- SETGID');
    expect(capAdd).toContain('- SETUID');
    expect(capAdd).not.toContain('- DAC_OVERRIDE');
    expect(capAdd).not.toContain('- SYS_ADMIN');
    expect(capAdd).not.toContain('- SETPCAP');
  });
});

describe('sync-server image', () => {
  const dockerfile = () =>
    fs.readFileSync(path.join(deployDir, 'sync-server.Dockerfile'), 'utf8');
  const entrypointPath = path.join(scriptsDir, 'sync-server-entrypoint');
  const entrypoint = () => fs.readFileSync(entrypointPath, 'utf8');

  it('builds a multi-stage production image without build tooling at runtime', () => {
    const text = dockerfile();
    expect(text).toMatch(/FROM node:20-\S+ AS builder/);
    expect(text).toMatch(/FROM node:20-\S+ AS runtime/);
    expect(text).toContain('pnpm deploy');
    expect(text).toContain('--prod');
    expect(text).toContain('HEALTHCHECK');
    expect(text).toContain('/usr/local/bin/sync-server-entrypoint');
    const runtime = text.slice(text.indexOf('AS runtime'));
    expect(runtime).not.toMatch(/corepack enable|pnpm install|apt-get install/);
  });

  it('drops to the non-root service account before exec-ing the app', () => {
    const text = entrypoint();
    const setprivIndex = text.indexOf('exec setpriv');
    expect(setprivIndex).toBeGreaterThan(0);
    const dropBlock = text.slice(setprivIndex);
    expect(dropBlock).toContain('--reuid="$APP_UID"');
    expect(dropBlock).toContain('--regid="$APP_GID"');
    expect(dropBlock).toContain('--clear-groups');
    expect(dropBlock).toContain('--inh-caps=-all');
    expect(dropBlock).toContain('--no-new-privs');
    // The handoff copy must happen before the drop, never after.
    expect(text.indexOf('chown -R')).toBeLessThan(setprivIndex);
  });

  it('execs the command directly when it is already unprivileged', () => {
    const result = spawnSync(entrypointPath, ['/bin/sh', '-c', 'id -u'], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(process.getuid?.() ?? ''));
  });

  it('refuses to start without a command', () => {
    const result = spawnSync(entrypointPath, [], {
      env: { PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
  });
});
