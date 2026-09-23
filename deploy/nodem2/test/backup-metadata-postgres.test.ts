/**
 * Real-PostgreSQL regression coverage for `ariadne_record_backup_metadata`.
 *
 * `deploy/nodem2/test/backups.test.ts` fakes `docker`/`psql` entirely, so it
 * only ever asserts which `--set=name=value` arguments were passed - it never
 * asks a real `psql` to parse and execute the SQL text. That blind spot let a
 * defect ship where the metadata statement embedded `:'ariadne_backup_*'`
 * psql variable references but was sent through `psql --command`, which does
 * not perform variable interpolation. Production `psql` rejected the literal
 * `:` and the safety-backup workflow failed after publishing a valid dump.
 *
 * This suite starts a disposable, throwaway PostgreSQL container (not the
 * tracked Compose stack, and never nodem2) and drives the real
 * `ariadne_record_backup_metadata` / `ariadne_psql*` shell functions against
 * it, so the exact input channel and psql variable-substitution semantics are
 * exercised. It is skipped automatically when no `docker` daemon is reachable
 * (e.g. some sandboxes), matching the pattern already used for other
 * Docker-dependent checks in this repository.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptsDir = path.join(repoRoot, 'deploy', 'nodem2', 'scripts');

const DB_USER = 'ariadne';
const DB_NAME = 'ariadne_sync';
const DB_PASSWORD = 'regression-only-throwaway-password';
const CONTAINER_NAME = `ariadne-backup-metadata-regress-${process.pid}-${Date.now()}`;

function dockerReachable(): boolean {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return result.status === 0;
}

const hasDocker = dockerReachable();
const describeWithDocker = hasDocker ? describe : describe.skip;

function dockerExecPsql(sql: string, extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      CONTAINER_NAME,
      'psql',
      '--username',
      DB_USER,
      '--dbname',
      DB_NAME,
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set',
      'ON_ERROR_STOP=1',
      ...extraArgs,
      '--command',
      sql,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function waitForPostgresReady(): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync('docker', ['exec', CONTAINER_NAME, 'pg_isready', '-U', DB_USER, '-d', DB_NAME], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (ready.status === 0) return;
    spawnSync('sleep', ['1']);
  }
  throw new Error('disposable regression PostgreSQL container never became ready');
}

const tempRoots: string[] = [];

describeWithDocker('ariadne_record_backup_metadata against real PostgreSQL', () => {
  beforeAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { encoding: 'utf8' });
    const run = spawnSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        CONTAINER_NAME,
        '-e',
        `POSTGRES_PASSWORD=${DB_PASSWORD}`,
        '-e',
        `POSTGRES_USER=${DB_USER}`,
        '-e',
        `POSTGRES_DB=${DB_NAME}`,
        'postgres:16-bookworm',
      ],
      { encoding: 'utf8', timeout: 30_000 },
    );
    if (run.status !== 0) {
      throw new Error(`failed to start disposable regression PostgreSQL: ${run.stderr}`);
    }
    waitForPostgresReady();

    // `pg_isready` can report success mid-initdb (the entrypoint restarts
    // Postgres once after creating the requested database), so the schema
    // statement itself is retried until the target database actually exists.
    let schema: { status: number | null; stdout: string; stderr: string } | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      schema = dockerExecPsql(
        `CREATE TABLE backup_records (
           filename TEXT PRIMARY KEY,
           sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
           size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
           status TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL,
           verified_at TIMESTAMPTZ,
           restore_verification_message TEXT
         )`,
      );
      if (schema.status === 0) break;
      spawnSync('sleep', ['1']);
    }
    if (!schema || schema.status !== 0) {
      throw new Error(`failed to create regression backup_records table: ${schema?.stderr}`);
    }
  }, 60_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { encoding: 'utf8' });
  });

  afterEach(() => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('documents that psql --command never expands :\'var\' references (the production failure mode)', () => {
    const literal = dockerExecPsql("SELECT :'foo'", ['--set=foo=bar']);
    expect(literal.status).not.toBe(0);
    expect(literal.stderr).toContain('syntax error at or near ":"');

    const viaStdin = spawnSync(
      'docker',
      [
        'exec',
        '-i',
        CONTAINER_NAME,
        'psql',
        '--username',
        DB_USER,
        '--dbname',
        DB_NAME,
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=1',
        '--set=foo=bar',
      ],
      { encoding: 'utf8', input: "SELECT :'foo'\n", timeout: 15_000 },
    );
    expect(viaStdin.status).toBe(0);
    expect((viaStdin.stdout ?? '').trim()).toBe('bar');
  });

  it('inserts a real backup_records row through the tracked ariadne_record_backup_metadata function, with substitution actually performed by psql', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-backup-metadata-'));
    tempRoots.push(root);
    const etcDir = path.join(root, 'etc');
    const stateDir = path.join(root, 'state');
    const backupDir = path.join(root, 'backups');
    fs.mkdirSync(etcDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

    const base = 'ariadne-20260401T021500Z';
    const dumpContents = 'PGDMP real regression dump\n';
    fs.writeFileSync(path.join(backupDir, `${base}.dump`), dumpContents, { mode: 0o600 });
    const digest = crypto.createHash('sha256').update(dumpContents).digest('hex');
    fs.writeFileSync(path.join(backupDir, `${base}.sha256`), `${digest}  ${base}.dump\n`, { mode: 0o600 });
    fs.writeFileSync(
      path.join(backupDir, `${base}.json`),
      `${JSON.stringify({ basename: `${base}.dump`, timestamp: '20260401T021500Z', database: DB_NAME })}\n`,
      { mode: 0o600 },
    );

    // Bridges the tracked `ariadne_compose` contract onto the disposable
    // container started above instead of the real Compose stack, so the rest
    // of lib-common (including `ariadne_psql` and
    // `ariadne_record_backup_metadata`) runs completely unmodified against a
    // real `psql` and real PostgreSQL.
    const driverPath = path.join(root, 'drive-record-backup-metadata.sh');
    fs.writeFileSync(
      driverPath,
      `#!/bin/sh
set -eu
SCRIPT_DIR="${scriptsDir}"
# shellcheck source=deploy/nodem2/scripts/lib-common
. "$SCRIPT_DIR/lib-common"

ariadne_compose() {
    if [ "\${1:-}" = exec ] && [ "\${2:-}" = -T ] && [ "\${3:-}" = postgres ]; then
        shift 3
        exec docker exec -i "${CONTAINER_NAME}" "$@"
    fi
    echo "unsupported ariadne_compose invocation in regression driver: $*" >&2
    return 1
}

ariadne_record_backup_metadata "$1" "$2" "\${3:-}"
`,
      { mode: 0o755 },
    );

    const result = spawnSync('sh', [driverPath, base, 'created'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? '',
        ARIADNE_DEPLOY_SELFTEST: '1',
        ARIADNE_DEPLOY_ROOT: path.join(root, 'opt', 'ariadne'),
        ARIADNE_DEPLOY_ETC: etcDir,
        ARIADNE_DEPLOY_STATE: stateDir,
        ARIADNE_DEPLOY_BACKUP_DIR: backupDir,
        ARIADNE_DEPLOY_HEALTH_ATTEMPTS: '2',
        ARIADNE_DEPLOY_HEALTH_INTERVAL: '0',
      },
    });

    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(/syntax error/i);
    expect(result.status).toBe(0);

    const row = dockerExecPsql(
      `SELECT filename || '|' || sha256 || '|' || status FROM backup_records WHERE filename = '${base}.dump'`,
    );
    expect(row.status).toBe(0);
    expect(row.stdout.trim()).toBe(`${base}.dump|${digest}|created`);
  });
});
