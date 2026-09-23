/**
 * Backup, restore, verification, and pruning contract tests for the tracked
 * nodem2 deployment.
 *
 * The scripts under deploy/nodem2/scripts are POSIX shell, so they are tested
 * by executing them with fake `docker`, `sha256sum`, `date`, and `curl`
 * executables placed first in `PATH`. The fakes record every invocation so
 * ordering (verify before mutate), fixed paths, file modes, metadata hygiene,
 * and failure recovery can be asserted without touching a real database.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const deployDir = path.join(repoRoot, 'deploy', 'nodem2');
const scriptsDir = path.join(deployDir, 'scripts');
const systemdDir = path.join(deployDir, 'systemd');

const IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const JWT_SECRET_VALUE = 'top-secret-jwt-value-must-never-be-printed';
const POSTGRES_PASSWORD_VALUE = 'top-secret-postgres-password-value';
const KEY_MATERIAL_VALUE = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

/** Fake "now" used by every script run unless a test overrides it. */
const NOW_STAMP = '20260401T021500Z';
const NOW_EPOCH = Math.floor(Date.parse('2026-04-01T02:15:00Z') / 1000);
const DAY_SECONDS = 86_400;

const tempRoots: string[] = [];

interface Harness {
  root: string;
  etcDir: string;
  keysDir: string;
  stateDir: string;
  backupDir: string;
  worktree: string;
  composeFile: string;
  binDir: string;
  dockerLog: string;
  curlLog: string;
}

function writeExecutable(target: string, body: string): void {
  fs.writeFileSync(target, body, { mode: 0o755 });
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-backup-'));
  tempRoots.push(root);

  const etcDir = path.join(root, 'etc', 'ariadne');
  const keysDir = path.join(etcDir, 'keys');
  const stateDir = path.join(root, 'var', 'lib', 'ariadne', 'deploy');
  const backupDir = path.join(root, 'var', 'backups', 'ariadne');
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
  fs.writeFileSync(path.join(keysDir, 'secondary.key'), `${KEY_MATERIAL_VALUE}\n`, { mode: 0o600 });

  const composeFile = path.join(worktreeDeployDir, 'compose.yaml');
  fs.copyFileSync(path.join(deployDir, 'compose.yaml'), composeFile);

  const dockerLog = path.join(root, 'docker.log');
  const curlLog = path.join(root, 'curl.log');

  writeExecutable(
    path.join(binDir, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
for var_name in FAKE_DOCKER_FAIL FAKE_DOCKER_FAIL_2; do
  case "$var_name" in
    FAKE_DOCKER_FAIL) fail_pattern="\${FAKE_DOCKER_FAIL:-}" ;;
    FAKE_DOCKER_FAIL_2) fail_pattern="\${FAKE_DOCKER_FAIL_2:-}" ;;
  esac
  if [ -n "$fail_pattern" ]; then
    case "$*" in
      *"$fail_pattern"*) echo "fake docker failure: $fail_pattern" >&2; exit 1 ;;
    esac
  fi
done
if [ "\${1:-}" = image ] && [ "\${2:-}" = inspect ]; then
  echo "${IMAGE_ID}"
  exit 0
fi
case "$*" in
  *pg_dump*)
    printf 'PGDMP fake custom dump %s\\n' "\${FAKE_DUMP_MARKER:-default}"
    exit 0 ;;
  *"pg_restore --list"*)
    cat > /dev/null
    printf ';\\n; Archive created by fake pg_dump\\n;\\n245; 1259 16385 TABLE public tasks ariadne\\n'
    exit 0 ;;
  *pg_restore*)
    cat > /dev/null
    exit 0 ;;
  *psql*)
    case "$*" in
      *migrations_applied*) printf '%s\\n' "\${FAKE_SCHEMA_VERSION:-0007_task_history.sql}" ;;
      *count*) printf '%s\\n' "\${FAKE_TABLE_COUNT:-42}" ;;
    esac
    exit 0 ;;
esac
exit 0
`,
  );

  // Deterministic clock. Real `date -d ...` conversions (used when pruning
  // parses a filename timestamp) pass through so only "now" is faked.
  writeExecutable(
    path.join(binDir, 'date'),
    `#!/bin/sh
for arg in "$@"; do
  case "\$arg" in
    -d|--date|-d*|--date=*) exec /usr/bin/date "$@" ;;
  esac
done
case "\$*" in
  *+%s*) printf '%s\\n' "\${FAKE_NOW_EPOCH:-${NOW_EPOCH}}" ;;
  *) printf '%s\\n' "\${FAKE_NOW_STAMP:-${NOW_STAMP}}" ;;
esac
exit 0
`,
  );

  // Real hashing keeps checksum assertions meaningful; the wrapper only adds
  // deterministic failure injection.
  writeExecutable(
    path.join(binDir, 'sha256sum'),
    `#!/bin/sh
if [ "\${FAKE_SHA256_FAIL:-0}" = 1 ]; then
  echo "fake sha256sum failure" >&2
  exit 1
fi
exec /usr/bin/sha256sum "$@"
`,
  );

  writeExecutable(
    path.join(binDir, 'curl'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
exit "\${FAKE_CURL_EXIT:-0}"
`,
  );

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
    backupDir,
    worktree,
    composeFile,
    binDir,
    dockerLog,
    curlLog,
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
    HOME: harness.root,
    FAKE_DOCKER_LOG: harness.dockerLog,
    FAKE_CURL_LOG: harness.curlLog,
    ...(selftest
      ? {
          ARIADNE_DEPLOY_SELFTEST: '1',
          ARIADNE_DEPLOY_ROOT: path.join(harness.root, 'opt', 'ariadne'),
          ARIADNE_DEPLOY_ETC: harness.etcDir,
          ARIADNE_DEPLOY_STATE: harness.stateDir,
          ARIADNE_DEPLOY_BACKUP_DIR: harness.backupDir,
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

function listBackupDir(harness: Harness): string[] {
  if (!fs.existsSync(harness.backupDir)) return [];
  return fs.readdirSync(harness.backupDir).sort();
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

function output(result: { stdout: string | null; stderr: string | null }): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

interface SeedOptions {
  /** Omit one sidecar to model an incomplete triplet. */
  omit?: 'sha256' | 'json';
  contents?: string;
}

function seedBackup(harness: Harness, stamp: string, options: SeedOptions = {}): string {
  fs.mkdirSync(harness.backupDir, { recursive: true, mode: 0o700 });
  const base = `ariadne-${stamp}`;
  const contents = options.contents ?? `PGDMP fake custom dump ${stamp}\n`;
  fs.writeFileSync(path.join(harness.backupDir, `${base}.dump`), contents, { mode: 0o600 });
  if (options.omit !== 'sha256') {
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    fs.writeFileSync(path.join(harness.backupDir, `${base}.sha256`), `${digest}  ${base}.dump\n`, {
      mode: 0o600,
    });
  }
  if (options.omit !== 'json') {
    fs.writeFileSync(
      path.join(harness.backupDir, `${base}.json`),
      `${JSON.stringify({ basename: `${base}.dump`, timestamp: stamp, database: 'ariadne_sync' })}\n`,
      { mode: 0o600 },
    );
  }
  return base;
}

/** Filename stamp for a backup created `days` before the faked clock. */
function stampDaysAgo(days: number): string {
  const when = new Date((NOW_EPOCH - days * DAY_SECONDS) * 1000);
  return when.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function newestDump(harness: Harness): string | undefined {
  return listBackupDir(harness)
    .filter((entry) => entry.endsWith('.dump'))
    .sort()
    .pop();
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('backup script', () => {
  it('creates a complete dump/checksum/metadata triplet with fixed Compose inputs', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup');

    expect(output(result)).not.toMatch(/error/i);
    expect(result.status).toBe(0);

    const base = `ariadne-${NOW_STAMP}`;
    expect(listBackupDir(harness)).toEqual([`${base}.dump`, `${base}.json`, `${base}.sha256`]);

    const docker = readLog(harness.dockerLog);
    const dumpLine = docker[indexOfMatch(docker, 'pg_dump')];
    expect(dumpLine).toContain('compose');
    expect(dumpLine).toContain(`-f ${harness.composeFile}`);
    expect(dumpLine).toContain('-p ariadne-nodem2');
    expect(dumpLine).toContain(`--env-file ${path.join(harness.etcDir, 'compose.env')}`);
    expect(dumpLine).toContain('exec -T postgres');
  });

  it('dumps in PostgreSQL custom format without owner or ACL statements', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    const dumpLine = readLog(harness.dockerLog)[indexOfMatch(readLog(harness.dockerLog), 'pg_dump')];
    expect(dumpLine).toContain('--format=custom');
    expect(dumpLine).toContain('--no-owner');
    expect(dumpLine).toContain('--no-acl');
  });

  it('names backups with an ISO-8601 UTC timestamp taken from the clock', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup', { env: { FAKE_NOW_STAMP: '20260415T031000Z' } }).status).toBe(
      0,
    );

    expect(listBackupDir(harness)).toContain('ariadne-20260415T031000Z.dump');
  });

  it('writes 0600 files inside a 0700 backup directory', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    expect(mode(harness.backupDir)).toBe(0o700);
    for (const entry of listBackupDir(harness)) {
      expect(mode(path.join(harness.backupDir, entry)), entry).toBe(0o600);
    }
  });

  it('publishes each file atomically and leaves no temporary files behind', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    expect(listBackupDir(harness).filter((entry) => entry.includes('.tmp'))).toEqual([]);

    const base = `ariadne-${NOW_STAMP}`;
    const dump = fs.readFileSync(path.join(harness.backupDir, `${base}.dump`));
    const recorded = fs
      .readFileSync(path.join(harness.backupDir, `${base}.sha256`), 'utf8')
      .trim()
      .split(/\s+/)[0];
    expect(recorded).toBe(crypto.createHash('sha256').update(dump).digest('hex'));

    // Atomic publication lives in the shared library used by `backup` and the
    // pre-restore safety backup.
    const libText = fs.readFileSync(path.join(scriptsDir, 'lib-common'), 'utf8');
    expect(libText).toContain('.dump.tmp');
    expect(libText).toMatch(/\bmv\b/);
    expect(fs.readFileSync(path.join(scriptsDir, 'backup'), 'utf8')).toContain(
      'ariadne_create_backup',
    );
  });

  it('records non-secret metadata describing the dump', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    const base = `ariadne-${NOW_STAMP}`;
    const metaText = fs.readFileSync(path.join(harness.backupDir, `${base}.json`), 'utf8');
    const meta = JSON.parse(metaText) as Record<string, unknown>;

    expect(meta.timestamp).toBe(NOW_STAMP);
    expect(meta.database).toBe('ariadne_sync');
    expect(meta.image).toBe(IMAGE_ID);
    expect(meta.schemaVersion).toBe('0007_task_history.sql');
    expect(meta.basename).toBe(`${base}.dump`);
    expect(typeof meta.dumpBytes).toBe('number');
    expect(meta.dumpBytes).toBe(fs.statSync(path.join(harness.backupDir, `${base}.dump`)).size);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(metaText).not.toContain(JWT_SECRET_VALUE);
    expect(metaText).not.toContain(POSTGRES_PASSWORD_VALUE);
    expect(metaText).not.toContain(KEY_MATERIAL_VALUE);
    expect(metaText.toLowerCase()).not.toContain('password');
  });

  it('lists the encrypted-blob key IDs required to read the dump, never key material', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    const meta = JSON.parse(
      fs.readFileSync(path.join(harness.backupDir, `ariadne-${NOW_STAMP}.json`), 'utf8'),
    ) as { keyIds?: unknown; activeKeyId?: unknown };

    expect(Array.isArray(meta.keyIds)).toBe(true);
    expect((meta.keyIds as string[]).slice().sort()).toEqual(['primary', 'secondary']);
    expect(meta.activeKeyId).toBe('primary');
  });

  it('never archives or reads the encryption key directory as backup input', () => {
    const harness = createHarness();
    expect(runScript(harness, 'backup').status).toBe(0);

    for (const entry of listBackupDir(harness)) {
      const contents = fs.readFileSync(path.join(harness.backupDir, entry), 'utf8');
      expect(contents, entry).not.toContain(KEY_MATERIAL_VALUE);
    }
    expect(readLog(harness.dockerLog).join('\n')).not.toContain(harness.keysDir);

    for (const script of ['backup', 'restore-backup', 'verify-backup', 'prune-backups']) {
      const text = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
      expect(text, script).not.toMatch(/\b(tar|zip|cpio|rsync)\b/);
      expect(text, script).not.toMatch(/cat\s+"?\$\{?ARIADNE_KEYS_DIR/);
    }
  });

  it('removes every temporary file and publishes nothing when the dump fails', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup', { env: { FAKE_DOCKER_FAIL: 'pg_dump' } });

    expect(result.status).not.toBe(0);
    expect(listBackupDir(harness)).toEqual([]);
  });

  it('publishes nothing when the dump fails its pg_restore --list validation', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup', { env: { FAKE_DOCKER_FAIL: 'pg_restore --list' } });

    expect(result.status).not.toBe(0);
    expect(listBackupDir(harness)).toEqual([]);
  });

  it('publishes nothing when checksumming fails', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup', { env: { FAKE_SHA256_FAIL: '1' } });

    expect(result.status).not.toBe(0);
    expect(listBackupDir(harness)).toEqual([]);
  });

  it('prunes expired backups after the new backup is published', () => {
    const harness = createHarness();
    const expired = seedBackup(harness, stampDaysAgo(120));
    const recent = seedBackup(harness, stampDaysAgo(2));

    expect(runScript(harness, 'backup').status).toBe(0);

    const entries = listBackupDir(harness);
    expect(entries).toContain(`ariadne-${NOW_STAMP}.dump`);
    expect(entries).toContain(`${recent}.dump`);
    expect(entries).not.toContain(`${expired}.dump`);
  });

  it('rejects caller-supplied arguments', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup', { args: ['/tmp/elsewhere'] });

    expect(result.status).not.toBe(0);
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('never prints secret values', () => {
    const harness = createHarness();
    for (const env of [{}, { FAKE_DOCKER_FAIL: 'pg_dump' }]) {
      const text = output(runScript(harness, 'backup', { env }));
      expect(text).not.toContain(JWT_SECRET_VALUE);
      expect(text).not.toContain(POSTGRES_PASSWORD_VALUE);
      expect(text).not.toContain(KEY_MATERIAL_VALUE);
    }
  });
});

describe('restore-backup script', () => {
  function confirmEnv(base: string): Record<string, string> {
    return { ARIADNE_RESTORE_CONFIRM: `${base}.dump` };
  }

  it('accepts only a validated backup basename resolved under the fixed backup root', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    for (const bad of [
      '../../etc/passwd',
      `${harness.backupDir}/${base}.dump`,
      'ariadne-20260301T021500Z.dump.tmp',
      'ariadne-2026-03-01T02:15:00Z.dump',
      'ariadne-20260301T021500Z.sha256',
      'backup.dump',
      '',
    ]) {
      const result = runScript(harness, 'restore-backup', {
        args: [bad],
        env: { ARIADNE_RESTORE_CONFIRM: bad },
      });
      expect(result.status, bad).not.toBe(0);
    }

    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('requires exactly one argument', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    expect(runScript(harness, 'restore-backup', { args: [] }).status).not.toBe(0);
    expect(
      runScript(harness, 'restore-backup', {
        args: [`${base}.dump`, `${base}.dump`],
        env: confirmEnv(base),
      }).status,
    ).not.toBe(0);
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('refuses to run without the separately provided confirmation environment', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const missing = runScript(harness, 'restore-backup', { args: [`${base}.dump`] });
    expect(missing.status).not.toBe(0);
    expect(output(missing)).toContain('ARIADNE_RESTORE_CONFIRM');

    const mismatched = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: { ARIADNE_RESTORE_CONFIRM: 'ariadne-20260101T000000Z.dump' },
    });
    expect(mismatched.status).not.toBe(0);

    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('requires both sidecars before touching the database', () => {
    const harness = createHarness();
    const noSum = seedBackup(harness, '20260301T021500Z', { omit: 'sha256' });
    const noMeta = seedBackup(harness, '20260302T021500Z', { omit: 'json' });

    for (const base of [noSum, noMeta]) {
      const result = runScript(harness, 'restore-backup', {
        args: [`${base}.dump`],
        env: confirmEnv(base),
      });
      expect(result.status, base).not.toBe(0);
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('verifies the checksum and pg_restore listing before any mutation', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');
    fs.writeFileSync(
      path.join(harness.backupDir, `${base}.sha256`),
      `${'0'.repeat(64)}  ${base}.dump\n`,
      { mode: 0o600 },
    );

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: confirmEnv(base),
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog).join('\n');
    expect(docker).not.toContain('stop sync-server');
    expect(docker).not.toContain('psql');
    expect(docker).not.toContain('pg_dump');
  });

  it('aborts before stopping the application when the listing is unreadable', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: { ...confirmEnv(base), FAKE_DOCKER_FAIL: 'pg_restore --list' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog).join('\n');
    expect(docker).not.toContain('stop sync-server');
    expect(docker).not.toContain('CREATE DATABASE');
  });

  it('creates and verifies a fresh safety backup before stopping the application', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: confirmEnv(base),
    });

    expect(result.status).toBe(0);
    const safetyBase = `ariadne-${NOW_STAMP}`;
    expect(listBackupDir(harness)).toEqual(
      expect.arrayContaining([`${safetyBase}.dump`, `${safetyBase}.sha256`, `${safetyBase}.json`]),
    );

    const docker = readLog(harness.dockerLog);
    const dumpIndex = indexOfMatch(docker, 'pg_dump');
    const stopIndex = indexOfMatch(docker, 'stop sync-server');
    const createIndex = indexOfMatch(docker, 'CREATE DATABASE');
    expect(dumpIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(dumpIndex);
    expect(createIndex).toBeGreaterThan(stopIndex);

    // The safety dump is verified (listed) before the application stops.
    const listIndexes = docker
      .map((line, index) => (line.includes('pg_restore --list') ? index : -1))
      .filter((index) => index >= 0);
    expect(listIndexes.some((index) => index > dumpIndex && index < stopIndex)).toBe(true);
    expect(output(result)).toContain(`${safetyBase}.dump`);
  });

  it('restores into a new database and swaps it in without dropping production first', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: confirmEnv(base),
    });

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const joined = docker.join('\n');

    const createIndex = indexOfMatch(docker, 'CREATE DATABASE');
    const restoreIndex = docker.findIndex(
      (line) => line.includes('pg_restore') && !line.includes('--list'),
    );
    const renameIndex = indexOfMatch(docker, 'RENAME TO');
    expect(restoreIndex).toBeGreaterThan(createIndex);
    expect(renameIndex).toBeGreaterThan(restoreIndex);

    expect(joined).not.toContain('DROP DATABASE ariadne_sync ');
    expect(joined).not.toMatch(/DROP DATABASE ariadne_sync"/);
    expect(docker[restoreIndex]).toContain('--no-owner');
    expect(docker[restoreIndex]).toContain('--exit-on-error');
  });

  it('restarts the application, runs migrations, and verifies health on success', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: confirmEnv(base),
    });

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const renameIndex = indexOfMatch(docker, 'RENAME TO');
    const upIndex = indexOfMatch(docker, 'up -d --no-deps sync-server');
    const migrateIndex = indexOfMatch(docker, 'run --rm --no-deps migrate');
    expect(upIndex).toBeGreaterThan(renameIndex);
    expect(migrateIndex).toBeGreaterThan(renameIndex);
    expect(readLog(harness.curlLog).join('\n')).toContain('/healthz');
  });

  it('leaves the application stopped and prints the exact recovery command on failure', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: { ...confirmEnv(base), FAKE_DOCKER_FAIL: 'pg_restore --no-owner' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog).join('\n');
    expect(docker).toContain('stop sync-server');
    expect(docker).not.toContain('up -d --no-deps sync-server');

    const safetyBase = `ariadne-${NOW_STAMP}`;
    const text = output(result);
    expect(text).toContain(`${safetyBase}.dump`);
    expect(text).toContain(
      `ARIADNE_RESTORE_CONFIRM=${safetyBase}.dump /usr/local/lib/ariadne/restore-backup ${safetyBase}.dump`,
    );
    expect(text).not.toMatch(/restore complete|succeeded/i);
  });

  it('renames the retired database back and points the operator at restart-sync-server when promotion fails', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: { ...confirmEnv(base), FAKE_DOCKER_FAIL: 'ALTER DATABASE ariadne_sync_restore_' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog);
    const retireIndex = indexOfMatch(docker, 'ALTER DATABASE ariadne_sync RENAME TO ariadne_sync_prerestore_');
    const promoteIndex = indexOfMatch(
      docker,
      'ALTER DATABASE ariadne_sync_restore_20260401t021500z RENAME TO ariadne_sync',
    );
    const recoverIndex = indexOfMatch(
      docker,
      'ALTER DATABASE ariadne_sync_prerestore_20260401t021500z RENAME TO ariadne_sync',
    );
    expect(retireIndex).toBeGreaterThanOrEqual(0);
    expect(promoteIndex).toBeGreaterThan(retireIndex);
    expect(recoverIndex).toBeGreaterThan(promoteIndex);
    expect(docker.join('\n')).not.toContain('up -d --no-deps sync-server');

    const text = output(result);
    expect(text).toContain('the application is stopped and was NOT restarted');
    expect(text).toContain('/usr/local/lib/ariadne/restart-sync-server');
    expect(text).toContain(`ariadne-${NOW_STAMP}.dump`);
    expect(text).not.toContain('/usr/local/lib/ariadne/restore-backup');
    expect(text).not.toContain(JWT_SECRET_VALUE);
    expect(text).not.toContain(POSTGRES_PASSWORD_VALUE);
    expect(text).not.toContain(KEY_MATERIAL_VALUE);
  });

  it('prints the exact ALTER DATABASE recovery command when promotion rollback also fails', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: {
        ...confirmEnv(base),
        FAKE_DOCKER_FAIL: 'ALTER DATABASE ariadne_sync_restore_',
        FAKE_DOCKER_FAIL_2: 'ALTER DATABASE ariadne_sync_prerestore_',
      },
    });

    expect(result.status).not.toBe(0);
    const text = output(result);
    expect(text).toContain('the application is stopped and was NOT restarted');
    expect(text).toContain(`safety backup basename: ariadne-${NOW_STAMP}.dump`);
    expect(text).toContain('ALTER DATABASE ariadne_sync_prerestore_20260401t021500z RENAME TO ariadne_sync');
    expect(text).toContain('--dbname postgres');
    expect(text).not.toContain(JWT_SECRET_VALUE);
    expect(text).not.toContain(POSTGRES_PASSWORD_VALUE);
    expect(text).not.toContain(KEY_MATERIAL_VALUE);
  });

  it('fails without stopping the application when the safety backup cannot be made', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'restore-backup', {
      args: [`${base}.dump`],
      env: { ...confirmEnv(base), FAKE_DOCKER_FAIL: 'pg_dump' },
    });

    expect(result.status).not.toBe(0);
    expect(readLog(harness.dockerLog).join('\n')).not.toContain('stop sync-server');
    expect(listBackupDir(harness).filter((entry) => entry.includes(NOW_STAMP))).toEqual([]);
  });

  it('never prints secret values', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');
    const text = output(
      runScript(harness, 'restore-backup', { args: [`${base}.dump`], env: confirmEnv(base) }),
    );
    expect(text).not.toContain(JWT_SECRET_VALUE);
    expect(text).not.toContain(POSTGRES_PASSWORD_VALUE);
    expect(text).not.toContain(KEY_MATERIAL_VALUE);
  });
});

describe('verify-backup script', () => {
  it('verifies the newest backup in an isolated temporary database and drops it', () => {
    const harness = createHarness();
    seedBackup(harness, '20260301T021500Z');
    const newest = seedBackup(harness, '20260320T021500Z');

    const result = runScript(harness, 'verify-backup');

    expect(result.status).toBe(0);
    const docker = readLog(harness.dockerLog);
    const joined = docker.join('\n');

    const createIndex = indexOfMatch(docker, 'CREATE DATABASE ariadne_verify_');
    const restoreIndex = docker.findIndex(
      (line) => line.includes('pg_restore') && line.includes('ariadne_verify_'),
    );
    const dropIndex = indexOfMatch(docker, 'DROP DATABASE');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(createIndex);
    expect(dropIndex).toBeGreaterThan(restoreIndex);
    expect(docker[dropIndex]).toContain('ariadne_verify_');

    expect(joined).toContain('migrations_applied');
    expect(joined).not.toContain('RENAME TO');
    expect(joined).not.toContain('stop sync-server');
    expect(output(result)).toContain(`${newest}.dump`);
    expect(listBackupDir(harness).length).toBe(6);
  });

  it('verifies the requested backup basename when one is supplied', () => {
    const harness = createHarness();
    const older = seedBackup(harness, '20260301T021500Z');
    seedBackup(harness, '20260320T021500Z');

    const result = runScript(harness, 'verify-backup', { args: [`${older}.dump`] });

    expect(result.status).toBe(0);
    expect(output(result)).toContain(`${older}.dump`);
  });

  it('rejects basenames that are not validated backup names', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    for (const bad of ['../../etc/passwd', `${harness.backupDir}/${base}.dump`, 'nope.dump']) {
      expect(runScript(harness, 'verify-backup', { args: [bad] }).status, bad).not.toBe(0);
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('checks the checksum before creating the temporary database', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');
    fs.writeFileSync(
      path.join(harness.backupDir, `${base}.sha256`),
      `${'0'.repeat(64)}  ${base}.dump\n`,
      { mode: 0o600 },
    );

    const result = runScript(harness, 'verify-backup', { args: [`${base}.dump`] });

    expect(result.status).not.toBe(0);
    expect(readLog(harness.dockerLog).join('\n')).not.toContain('CREATE DATABASE');
    expect(fs.existsSync(path.join(harness.backupDir, `${base}.dump`))).toBe(true);
  });

  it('always drops the verification database and keeps the backup when a check fails', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'verify-backup', {
      args: [`${base}.dump`],
      env: { FAKE_DOCKER_FAIL: 'pg_restore --no-owner' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog);
    const dropIndex = indexOfMatch(docker, 'DROP DATABASE');
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(docker[dropIndex]).toContain('ariadne_verify_');
    expect(fs.existsSync(path.join(harness.backupDir, `${base}.dump`))).toBe(true);
    expect(output(result)).toMatch(/verification failed/i);
  });

  it('drops the verification database even when database creation exits non-zero', () => {
    const harness = createHarness();
    const base = seedBackup(harness, '20260301T021500Z');

    const result = runScript(harness, 'verify-backup', {
      args: [`${base}.dump`],
      env: { FAKE_DOCKER_FAIL: 'CREATE DATABASE ariadne_verify_' },
    });

    expect(result.status).not.toBe(0);
    const docker = readLog(harness.dockerLog);
    const createIndex = indexOfMatch(docker, 'CREATE DATABASE ariadne_verify_');
    const dropIndex = indexOfMatch(docker, 'DROP DATABASE IF EXISTS ariadne_verify_');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(dropIndex).toBeGreaterThan(createIndex);
  });

  it('fails clearly when there is no backup to verify', () => {
    const harness = createHarness();
    const result = runScript(harness, 'verify-backup');

    expect(result.status).not.toBe(0);
    expect(readLog(harness.dockerLog)).toEqual([]);
  });
});

describe('prune-backups script', () => {
  it('deletes only complete triplets older than 30 days', () => {
    const harness = createHarness();
    const expired = seedBackup(harness, stampDaysAgo(45));
    const recent = seedBackup(harness, stampDaysAgo(10));
    const newest = seedBackup(harness, stampDaysAgo(1));

    const result = runScript(harness, 'prune-backups');

    expect(result.status).toBe(0);
    const entries = listBackupDir(harness);
    expect(entries).not.toContain(`${expired}.dump`);
    expect(entries).not.toContain(`${expired}.sha256`);
    expect(entries).not.toContain(`${expired}.json`);
    expect(entries).toContain(`${recent}.dump`);
    expect(entries).toContain(`${newest}.dump`);
  });

  it('never deletes the newest valid backup even when every backup is expired', () => {
    const harness = createHarness();
    const oldest = seedBackup(harness, stampDaysAgo(400));
    const middle = seedBackup(harness, stampDaysAgo(200));
    const newest = seedBackup(harness, stampDaysAgo(60));

    expect(runScript(harness, 'prune-backups').status).toBe(0);

    const entries = listBackupDir(harness);
    expect(entries).toEqual([`${newest}.dump`, `${newest}.json`, `${newest}.sha256`]);
    expect(entries).not.toContain(`${oldest}.dump`);
    expect(entries).not.toContain(`${middle}.dump`);
  });

  it('keeps incomplete backup sets instead of deleting partial evidence', () => {
    const harness = createHarness();
    const incomplete = seedBackup(harness, stampDaysAgo(120), { omit: 'sha256' });
    const newest = seedBackup(harness, stampDaysAgo(1));

    expect(runScript(harness, 'prune-backups').status).toBe(0);

    const entries = listBackupDir(harness);
    expect(entries).toContain(`${incomplete}.dump`);
    expect(entries).toContain(`${incomplete}.json`);
    expect(entries).toContain(`${newest}.dump`);
  });

  it('leaves unrelated and non-conforming files untouched', () => {
    const harness = createHarness();
    seedBackup(harness, stampDaysAgo(1));
    fs.writeFileSync(path.join(harness.backupDir, 'notes.txt'), 'keep me\n', { mode: 0o600 });
    fs.writeFileSync(path.join(harness.backupDir, 'ariadne-oldstyle.dump'), 'keep me\n', {
      mode: 0o600,
    });

    expect(runScript(harness, 'prune-backups').status).toBe(0);

    const entries = listBackupDir(harness);
    expect(entries).toContain('notes.txt');
    expect(entries).toContain('ariadne-oldstyle.dump');
  });

  it('removes orphaned temporary files older than one day only', () => {
    const harness = createHarness();
    seedBackup(harness, stampDaysAgo(1));

    const staleTmp = path.join(harness.backupDir, `ariadne-${stampDaysAgo(5)}.dump.tmp`);
    const freshTmp = path.join(harness.backupDir, `ariadne-${NOW_STAMP}.dump.tmp`);
    fs.writeFileSync(staleTmp, 'stale\n', { mode: 0o600 });
    fs.writeFileSync(freshTmp, 'fresh\n', { mode: 0o600 });
    const staleTime = new Date((NOW_EPOCH - 5 * DAY_SECONDS) * 1000);
    fs.utimesSync(staleTmp, staleTime, staleTime);

    expect(runScript(harness, 'prune-backups').status).toBe(0);

    expect(fs.existsSync(staleTmp)).toBe(false);
    expect(fs.existsSync(freshTmp)).toBe(true);
  });

  it('never trusts metadata files as a source of truth for retention', () => {
    const harness = createHarness();
    const newest = seedBackup(harness, stampDaysAgo(1));
    fs.writeFileSync(
      path.join(harness.backupDir, `${newest}.json`),
      'timestamp=19700101T000000Z; rm -rf /\n',
      { mode: 0o600 },
    );

    expect(runScript(harness, 'prune-backups').status).toBe(0);
    expect(listBackupDir(harness)).toContain(`${newest}.dump`);

    const text = fs.readFileSync(path.join(scriptsDir, 'prune-backups'), 'utf8');
    expect(text).not.toMatch(/^\s*\.\s+.*\.json/m);
    expect(text).not.toMatch(/\beval\b/);
  });

  it('rejects caller-supplied arguments', () => {
    const harness = createHarness();
    expect(runScript(harness, 'prune-backups', { args: [harness.root] }).status).not.toBe(0);
  });
});

describe('backup scripts hygiene', () => {
  it('are executable POSIX shell scripts that fail fast', () => {
    for (const script of ['backup', 'restore-backup', 'verify-backup', 'prune-backups']) {
      const file = path.join(scriptsDir, script);
      expect(fs.existsSync(file), script).toBe(true);
      expect(mode(file) & 0o111, script).not.toBe(0);
      const text = fs.readFileSync(file, 'utf8');
      expect(text.startsWith('#!/bin/sh'), script).toBe(true);
      expect(text, script).toContain('set -eu');
      expect(text, script).toContain('umask 077');
      expect(text, script).toContain('lib-common');
    }
  });

  it('refuse production invocations that try to redirect the fixed backup root', () => {
    const harness = createHarness();
    const result = runScript(harness, 'backup', {
      selftest: false,
      env: { ARIADNE_DEPLOY_BACKUP_DIR: harness.backupDir },
    });

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain('ARIADNE_DEPLOY_BACKUP_DIR');
    expect(readLog(harness.dockerLog)).toEqual([]);
  });

  it('pin the production backup root to /var/backups/ariadne', () => {
    const libCommon = fs.readFileSync(path.join(scriptsDir, 'lib-common'), 'utf8');
    expect(libCommon).toContain('/var/backups/ariadne');
  });

  it('refuse self-test mode when the caller is root', () => {
    const harness = createHarness();
    for (const script of ['backup', 'verify-backup', 'prune-backups']) {
      const result = runScript(harness, script, { env: { FAKE_ID_UID: '0' } });
      expect(result.status, script).not.toBe(0);
      expect(output(result).toLowerCase(), script).toContain('root');
    }
    expect(readLog(harness.dockerLog)).toEqual([]);
  });
});

describe('systemd units', () => {
  const unit = (name: string) => fs.readFileSync(path.join(systemdDir, name), 'utf8');

  it('schedules the daily backup at 02:15 with persistence and jitter', () => {
    const text = unit('ariadne-backup.timer');
    expect(text).toContain('OnCalendar=*-*-* 02:15:00');
    expect(text).toContain('Persistent=true');
    expect(text).toMatch(/RandomizedDelaySec=\d+/);
    expect(text).toContain('WantedBy=timers.target');
  });

  it('schedules the weekly verification on Sunday at 03:30', () => {
    const text = unit('ariadne-backup-verify.timer');
    expect(text).toContain('OnCalendar=Sun *-*-* 03:30:00');
    expect(text).toContain('Persistent=true');
    expect(text).toMatch(/RandomizedDelaySec=\d+/);
  });

  it('runs hardened one-shot services against the fixed installed scripts', () => {
    for (const [name, script] of [
      ['ariadne-backup.service', '/usr/local/lib/ariadne/backup'],
      ['ariadne-backup-verify.service', '/usr/local/lib/ariadne/verify-backup'],
    ] as const) {
      const text = unit(name);
      expect(text, name).toContain('Type=oneshot');
      expect(text, name).toContain(`ExecStart=${script}`);
      expect(text, name).toContain('NoNewPrivileges=true');
      expect(text, name).toContain('PrivateTmp=true');
      expect(text, name).toContain('ProtectSystem=strict');
      expect(text, name).toContain('ProtectHome=true');
      expect(text, name).toContain('ExecStartPre=/usr/bin/install -d -m 0700 /var/backups/ariadne');
      expect(text, name).toContain('ReadWritePaths=/var/backups');
      expect(text, name).toContain('UMask=0077');
    }
  });

  it('documents the correct verify service install path', () => {
    const text = unit('ariadne-backup-verify.service');
    expect(text).toContain('Install as /etc/systemd/system/ariadne-backup-verify.service');
  });

  it('keeps the encryption key directory out of the backup units', () => {
    for (const name of [
      'ariadne-backup.service',
      'ariadne-backup.timer',
      'ariadne-backup-verify.service',
      'ariadne-backup-verify.timer',
    ]) {
      expect(unit(name), name).not.toContain('/etc/ariadne/keys');
    }
  });
});
