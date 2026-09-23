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
const ROLLBACK_SHA = 'b'.repeat(40);
const NEXT_SHA = 'c'.repeat(40);
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
  gitHeadFile: string;
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
    `DATABASE_URL=postgres://ariadne@127.0.0.1:5432/ariadne_sync\nSYNC_SERVER_JWT_SECRET=${JWT_SECRET_VALUE}\nADMIN_PUBLIC_ORIGIN=http://127.0.0.1:14300\n`,
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
  const gitHeadFile = path.join(root, 'git-head');
  fs.writeFileSync(gitHeadFile, `${VALID_SHA}\n`, { mode: 0o600 });

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
case "$*" in
  *pg_dump*)
    printf 'PGDMP fake custom dump\\n'
    exit 0 ;;
  *"pg_restore --list"*)
    cat > /dev/null
    printf ';\\n; Archive created by fake pg_dump\\n;\\n245; 1259 16385 TABLE public tasks ariadne\\n'
    exit 0 ;;
  *pg_restore*)
    cat > /dev/null
    exit 0 ;;
  *psql*)
    exit 0 ;;
esac
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
      *HEAD*)
        if [ -n "\${FAKE_GIT_HEAD:-}" ]; then
          printf '%s\\n' "$FAKE_GIT_HEAD"
        else
          head -n 1 "$FAKE_GIT_HEAD_FILE"
        fi ;;
      *) printf '%s\\n' "\${FAKE_GIT_TRUSTED_TIP:-${'b'.repeat(40)}}" ;;
    esac
    exit 0 ;;
  merge-base) exit "\${FAKE_GIT_ANCESTOR_EXIT:-0}" ;;
  cat-file) exit "\${FAKE_GIT_CATFILE_EXIT:-0}" ;;
  checkout)
    [ -z "\${4:-}" ] || printf '%s\\n' "$4" > "$FAKE_GIT_HEAD_FILE"
    exit "\${FAKE_GIT_CHECKOUT_EXIT:-0}" ;;
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

  // Lets a test claim to be uid 0 without actually being root.
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

  return {
    root,
    etcDir,
    keysDir,
    stateDir,
    worktree,
    composeFile,
    binDir,
    dockerLog,
    gitLog,
    curlLog,
    gitHeadFile,
  };
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
    FAKE_GIT_HEAD_FILE: harness.gitHeadFile,
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

function readGitHead(harness: Harness): string {
  return fs.readFileSync(harness.gitHeadFile, 'utf8').trim();
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

  it('rejects production invocations that try to redirect the fixed paths', () => {
    const harness = createHarness();
    for (const variable of ['ARIADNE_DEPLOY_ROOT', 'ARIADNE_DEPLOY_ETC', 'ARIADNE_DEPLOY_STATE']) {
      const result = runScript(harness, 'deploy', {
        args: [VALID_SHA],
        selftest: false,
        env: { [variable]: harness.etcDir },
      });

      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(variable);
      expect(output).not.toContain(harness.etcDir);
      expect(readLog(harness.dockerLog)).toEqual([]);
    }
  });

  it('rejects self-test mode outside self-test runs, keeping the fixed paths', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      selftest: false,
      env: { ARIADNE_DEPLOY_SELFTEST: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('ARIADNE_DEPLOY_SELFTEST');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('refuses self-test mode when the caller is root', () => {
    const harness = createHarness();
    for (const script of ['deploy', 'restart-sync-server', 'restart-postgres']) {
      const result = runScript(harness, script, {
        args: script === 'deploy' ? [VALID_SHA] : [],
        env: { FAKE_ID_UID: '0' },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('root');
      expect(readLog(harness.dockerLog)).toEqual([]);
    }
  });

  it('refuses self-test mode for scripts installed under the production root', () => {
    const libCommon = fs.readFileSync(path.join(scriptsDir, 'lib-common'), 'utf8');
    const selftestBlock = libCommon.slice(
      libCommon.indexOf('ARIADNE_DEPLOY_SELFTEST'),
      libCommon.indexOf('ARIADNE_COMPOSE_PROJECT='),
    );
    // The installed copy at /opt/ariadne/... must never honour the flag, so a
    // root-writable environment cannot redirect a privileged deploy.
    expect(selftestBlock).toContain('/opt/ariadne');
    expect(selftestBlock).toMatch(/id -u/);
  });

  it('checks required secret and key files before invoking Compose', () => {
    const harness = createHarness();
    fs.rmSync(path.join(harness.etcDir, 'sync-server.env'));

    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('sync-server.env');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('aborts before Compose when ADMIN_PUBLIC_ORIGIN is missing from sync-server.env', () => {
    const harness = createHarness();
    fs.writeFileSync(
      path.join(harness.etcDir, 'sync-server.env'),
      `DATABASE_URL=postgres://ariadne@127.0.0.1:5432/ariadne_sync\nSYNC_SERVER_JWT_SECRET=${JWT_SECRET_VALUE}\n`,
      { mode: 0o600 },
    );

    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('ADMIN_PUBLIC_ORIGIN');
    expect(indexOfMatch(readLog(harness.dockerLog), 'config --quiet')).toBe(-1);
    expect(indexOfMatch(readLog(harness.dockerLog), 'run --rm')).toBe(-1);
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

  it('aborts before touching Docker when the trusted ref cannot be refreshed', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', {
      args: [VALID_SHA],
      env: { FAKE_GIT_FETCH_EXIT: '1' },
    });

    // Deploying against a stale local ref would let a revision that has since
    // been removed from the trusted branch reach production, so a failed fetch
    // is fatal rather than a warning.
    expect(result.status).not.toBe(0);
    const text = `${result.stdout}${result.stderr}`.toLowerCase();
    expect(text).toContain('fetch');
    expect(text).not.toContain('continuing');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('refreshes the trusted ref before checking reachability or checking out', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const git = readLog(harness.gitLog);
    const fetchIndex = indexOfMatch(git, 'fetch');
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(indexOfMatch(git, 'merge-base --is-ancestor')).toBeGreaterThan(fetchIndex);
    expect(indexOfMatch(git, 'checkout')).toBeGreaterThan(fetchIndex);
  });

  it('fetches only the dedicated nodem2 deployment branch into the trusted remote ref', () => {
    const harness = createHarness();
    const result = runScript(harness, 'deploy', { args: [VALID_SHA] });

    expect(result.status).toBe(0);
    const fetch = readLog(harness.gitLog).find((line) => line.includes('fetch --quiet --no-tags'));
    expect(fetch).toContain(
      'origin +refs/heads/deploy/nodem2:refs/remotes/origin/deploy/nodem2',
    );
    expect(fetch).not.toContain('refs/heads/main');
    expect(fetch).not.toContain('refs/remotes/origin/main');
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

  it('runs the tracked rollback only for the exact eligible revision', () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), `${ROLLBACK_SHA}\n`, {
      mode: 0o600,
    });

    const wrong = runScript(harness, 'rollback', { args: [VALID_SHA] });
    expect(wrong.status).not.toBe(0);
    expect(readLog(harness.dockerLog)).toEqual([]);

    const correct = runScript(harness, 'rollback', { args: [ROLLBACK_SHA] });
    expect(correct.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    expect(indexOfMatch(docker, 'build sync-server')).toBeGreaterThanOrEqual(0);
    expect(indexOfMatch(docker, 'run --rm')).toBeGreaterThanOrEqual(0);
    expect(indexOfMatch(docker, 'up -d --no-deps sync-server')).toBeGreaterThanOrEqual(0);
  });

  it('takes and verifies a fresh safety backup before rollback cutover', () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), `${ROLLBACK_SHA}\n`, {
      mode: 0o600,
    });

    const result = runScript(harness, 'rollback', { args: [ROLLBACK_SHA] });

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const backupIndex = indexOfMatch(docker, 'exec -T postgres pg_dump');
    const verifyIndex = indexOfMatch(docker, 'pg_restore --list');
    const buildIndex = indexOfMatch(docker, 'build sync-server');
    expect(backupIndex).toBeGreaterThanOrEqual(0);
    expect(verifyIndex).toBeGreaterThan(backupIndex);
    expect(buildIndex).toBeGreaterThan(verifyIndex);
  });

  it('preserves rollback artifacts when rollback health verification fails', () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), `${ROLLBACK_SHA}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(harness.stateDir, 'current-revision'), `${VALID_SHA}\n`, {
      mode: 0o600,
    });

    const result = runScript(harness, 'rollback', {
      args: [ROLLBACK_SHA],
      env: { FAKE_CURL_EXIT: '7' },
    });

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(path.join(harness.stateDir, 'rollback-revision'), 'utf8').trim()).toBe(
      ROLLBACK_SHA,
    );
    expect(fs.readFileSync(path.join(harness.stateDir, 'current-revision'), 'utf8').trim()).toBe(
      VALID_SHA,
    );
  });

  it('restores the worktree revision recorded as running when rollback cleanup fails after cutover', () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), `${ROLLBACK_SHA}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(harness.stateDir, 'current-revision'), `${VALID_SHA}\n`, {
      mode: 0o600,
    });

    const result = runScript(harness, 'rollback', {
      args: [ROLLBACK_SHA],
      env: { FAKE_CURL_EXIT: '7' },
    });

    expect(result.status).not.toBe(0);
    expect(readGitHead(harness)).toBe(VALID_SHA);
  });

  it('keeps rollback-revision pinned to the pre-failure running revision after a failed rollback and later deploy', () => {
    const harness = createHarness();
    fs.writeFileSync(path.join(harness.stateDir, 'rollback-revision'), `${ROLLBACK_SHA}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(harness.stateDir, 'current-revision'), `${VALID_SHA}\n`, {
      mode: 0o600,
    });

    const failedRollback = runScript(harness, 'rollback', {
      args: [ROLLBACK_SHA],
      env: { FAKE_CURL_EXIT: '7' },
    });
    expect(failedRollback.status).not.toBe(0);

    const deploy = runScript(harness, 'deploy', { args: [NEXT_SHA] });
    expect(deploy.status).toBe(0);
    expect(fs.readFileSync(path.join(harness.stateDir, 'rollback-revision'), 'utf8').trim()).toBe(
      VALID_SHA,
    );
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
    expect(docker[0]).toMatch(/restart postgres$/);
    // Only the restart itself plus the readiness probe touch Docker.
    expect(docker.length).toBe(2);
    expect(docker.join('\n')).not.toContain('sync-server');
  });

  it('rejects caller-supplied service arguments', () => {
    const harness = createHarness();
    for (const script of ['restart-sync-server', 'restart-postgres']) {
      const result = runScript(harness, script, { args: ['postgres'] });
      expect(result.status).not.toBe(0);
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('waits for the health endpoint after restarting sync-server', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-sync-server');

    expect(result.status).toBe(0);
    const curl = readLog(harness.curlLog);
    expect(curl.length).toBe(1);
    expect(curl[0]).toContain('/healthz');
  });

  it('fails when sync-server never becomes healthy after a restart', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-sync-server', {
      env: { FAKE_CURL_EXIT: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('did not become healthy');
    // Bounded by the configured attempt count, never an unbounded wait.
    expect(readLog(harness.curlLog).length).toBe(2);
  });

  it('waits for postgres readiness and then the health endpoint after restarting postgres', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-postgres');

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const restartIndex = indexOfMatch(docker, 'restart postgres');
    const readyIndex = indexOfMatch(docker, 'pg_isready');
    expect(restartIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(restartIndex);
    expect(readLog(harness.curlLog).join('\n')).toContain('/healthz');
  });

  it('fails when postgres never accepts connections after a restart', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-postgres', {
      env: { FAKE_DOCKER_FAIL: 'pg_isready' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('did not accept connections');
    expect(readLog(harness.curlLog)).toEqual([]);
  });

  it('fails when sync-server never becomes healthy after a postgres restart', () => {
    const harness = createHarness();
    const result = runScript(harness, 'restart-postgres', {
      env: { FAKE_CURL_EXIT: '1' },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('did not become healthy');
    expect(readLog(harness.curlLog).length).toBe(2);
  });

  it('keeps secrets out of restart output on every failure path', () => {
    const harness = createHarness();
    const results = [
      runScript(harness, 'restart-sync-server', { env: { FAKE_CURL_EXIT: '1' } }),
      runScript(harness, 'restart-postgres', { env: { FAKE_DOCKER_FAIL: 'pg_isready' } }),
    ];

    for (const result of results) {
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(JWT_SECRET_VALUE);
      expect(output).not.toContain(POSTGRES_PASSWORD_VALUE);
      expect(output).not.toContain(KEY_MATERIAL_VALUE);
    }
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

  it('defines a real build for the shared sync-server/migrate image', () => {
    const text = compose();
    for (const service of ['sync-server', 'migrate']) {
      const start = text.indexOf(`  ${service}:`);
      expect(start).toBeGreaterThan(0);
      const block = text.slice(start, text.indexOf('\n  ', text.indexOf('init: true', start)));
      expect(block).toContain('build:');
      expect(block).toMatch(/context:\s*\.\.\/\.\./);
      expect(block).toMatch(/dockerfile:\s*deploy\/nodem2\/sync-server\.Dockerfile/);
    }
    expect(fs.existsSync(path.join(deployDir, 'sync-server.Dockerfile'))).toBe(true);
  });

  it('warns that only `config --quiet` keeps env_file values out of output', () => {
    const text = compose();
    expect(text).toContain('config --quiet');
    expect(text).toMatch(/docker compose config[^\n]*(prints|reveals|renders)/i);
    expect(text).not.toMatch(/`?docker compose config`? output\s*\n?#?\s*stays secret-free/i);

    const readme = fs.readFileSync(
      path.join(repoRoot, 'packages', 'sync-server', 'README.md'),
      'utf8',
    );
    expect(readme).toMatch(/config --quiet/);
    expect(readme).toMatch(/docker compose config[^\n]*(prints|reveals|renders)/i);
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

const dockerAvailable = (() => {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return probe.status === 0;
})();

describe.skipIf(!dockerAvailable)('compose build (real docker)', () => {
  const composeArgs = ['compose', '-f', composeSource, '--env-file', path.join(deployDir, '.env.example')];

  it('resolves a build context and Dockerfile that exist on disk', () => {
    const result = spawnSync('docker', [...composeArgs, 'config', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: Record<string, { image?: string; build?: { context?: string; dockerfile?: string } }>;
    };

    for (const service of ['sync-server', 'migrate']) {
      const build = config.services[service]?.build;
      expect(build?.context, `${service} has no build context`).toBeTruthy();
      expect(fs.existsSync(build!.context!)).toBe(true);
      const dockerfile = path.resolve(build!.context!, build!.dockerfile ?? 'Dockerfile');
      expect(fs.existsSync(dockerfile)).toBe(true);
    }
    expect(config.services['sync-server'].image).toBe(config.services.migrate.image);
  });

  it('produces the candidate image that `docker compose build` is asked for', () => {
    const tag = `ariadne-sync-server:contract-test-${process.pid}`;
    spawnSync('docker', ['image', 'rm', '-f', tag], { timeout: 60_000 });
    try {
      const build = spawnSync('docker', [...composeArgs, 'build', 'sync-server'], {
        encoding: 'utf8',
        timeout: 900_000,
        env: { ...process.env, SYNC_SERVER_IMAGE: tag },
      });
      expect(build.stderr ?? '').not.toMatch(/no such service|failed to solve/i);
      expect(build.status).toBe(0);

      const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(inspect.status, `candidate image ${tag} was never created`).toBe(0);
      expect(inspect.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      spawnSync('docker', ['image', 'rm', '-f', tag], { timeout: 60_000 });
    }
  }, 960_000);
});
