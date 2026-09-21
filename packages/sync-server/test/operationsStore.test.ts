import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import {
  OUTPUT_TRUNCATION_MARKER,
  OperationTransitionError,
  createOperationsStore,
  type OperationsStore,
} from '../src/operationsStore.js';
import { TEST_DATABASE_URL } from './testConfig.js';

describe('operationsStore', () => {
  let pool: Pool;
  let store: OperationsStore;
  let teamId: string;
  let adminUserId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    store = createOperationsStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE admin_operation_events, admin_audit_events, backup_records, admin_operations, team_memberships, teams, users CASCADE',
    );

    teamId = await createSingletonTeam();
    adminUserId = await createAdminUser(teamId, 'alice');
  });

  async function createSingletonTeam(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO teams (singleton_key, name, created_at)
       VALUES ('default', 'Default team', '2026-09-21T00:00:00.000Z')
       RETURNING id`,
    );
    return rows[0].id;
  }

  async function createAdminUser(teamIdValue: string, username: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (username, password_hash, created_at)
       VALUES ($1, $2, '2026-09-21T00:05:00.000Z')
       RETURNING id`,
      [username, `hash-${username}`],
    );
    const userId = rows[0].id;
    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active, created_at)
       VALUES ($1, $2, 'admin', true, '2026-09-21T00:05:01.000Z')`,
      [teamIdValue, userId],
    );
    return userId;
  }

  it('creates queued operations with an initial event and audit row', async () => {
    const created = await store.createOperation({
      id: 'op-create-1',
      requestedBy: adminUserId,
      type: 'backup_create',
      summary: 'Create the daily safety backup',
      source: 'admin_api',
      createdAt: '2026-09-21T01:00:00.000Z',
      metadata: { phase: 'queued' },
    });

    expect(created).toEqual({
      id: 'op-create-1',
      requestedBy: adminUserId,
      type: 'backup_create',
      state: 'queued',
      summary: 'Create the daily safety backup',
      output: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-09-21T01:00:00.000Z',
    });

    const events = await store.listOperationEvents('op-create-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operationId: 'op-create-1',
      state: 'queued',
      message: 'Operation queued',
      metadata: { phase: 'queued' },
    });

    const audits = await store.listAuditEvents();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: adminUserId,
      action: 'admin_operation.created',
      source: 'admin_api',
      outcome: 'accepted',
      metadata: {
        operationId: 'op-create-1',
        type: 'backup_create',
        state: 'queued',
        phase: 'queued',
      },
    });
  });

  it('allows legal state transitions and appends chronological events', async () => {
    await store.createOperation({
      id: 'op-transition-1',
      requestedBy: adminUserId,
      type: 'deployment_apply',
      summary: 'Deploy revision aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      source: 'admin_api',
      createdAt: '2026-09-21T02:00:00.000Z',
    });

    const running = await store.transitionOperation({
      id: 'op-transition-1',
      nextState: 'running',
      actorUserId: adminUserId,
      source: 'operator',
      message: 'Deployment started',
      metadata: { revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      occurredAt: '2026-09-21T02:00:05.000Z',
    });

    expect(running.state).toBe('running');
    expect(running.startedAt).toBe('2026-09-21T02:00:05.000Z');
    expect(running.completedAt).toBeNull();

    const succeeded = await store.transitionOperation({
      id: 'op-transition-1',
      nextState: 'succeeded',
      actorUserId: adminUserId,
      source: 'operator',
      message: 'Deployment completed',
      metadata: { revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      output: 'Deployment finished successfully.',
      occurredAt: '2026-09-21T02:00:10.000Z',
    });

    expect(succeeded).toMatchObject({
      id: 'op-transition-1',
      state: 'succeeded',
      startedAt: '2026-09-21T02:00:05.000Z',
      completedAt: '2026-09-21T02:00:10.000Z',
      output: 'Deployment finished successfully.',
    });

    expect(await store.getOperation('op-transition-1')).toEqual(succeeded);

    const events = await store.listOperationEvents('op-transition-1');
    expect(events.map((event) => event.state)).toEqual(['queued', 'running', 'succeeded']);
    expect(events.map((event) => event.message)).toEqual([
      'Operation queued',
      'Deployment started',
      'Deployment completed',
    ]);
  });

  it('rejects transitions after an operation reaches a terminal state', async () => {
    await store.createOperation({
      id: 'op-terminal-1',
      requestedBy: adminUserId,
      type: 'service_restart',
      summary: 'Restart the sync-server service',
      source: 'admin_api',
      createdAt: '2026-09-21T03:00:00.000Z',
    });

    await store.transitionOperation({
      id: 'op-terminal-1',
      nextState: 'failed',
      actorUserId: adminUserId,
      source: 'operator',
      message: 'Socket unavailable',
      output: 'operator_unavailable',
      occurredAt: '2026-09-21T03:00:01.000Z',
    });

    await expect(
      store.transitionOperation({
        id: 'op-terminal-1',
        nextState: 'running',
        actorUserId: adminUserId,
        source: 'operator',
        message: 'Should not restart a failed operation',
        occurredAt: '2026-09-21T03:00:02.000Z',
      }),
    ).rejects.toBeInstanceOf(OperationTransitionError);

    const operation = await store.getOperation('op-terminal-1');
    expect(operation?.state).toBe('failed');
    expect((await store.listOperationEvents('op-terminal-1')).map((event) => event.state)).toEqual([
      'queued',
      'failed',
    ]);
    expect(await countRows('admin_audit_events')).toBe(2);
  });

  it('redacts secrets and truncates persisted output and audit metadata', async () => {
    await store.createOperation({
      id: 'op-output-1',
      requestedBy: adminUserId,
      type: 'backup_verify',
      summary: 'Verify the newest dump',
      source: 'admin_api',
      createdAt: '2026-09-21T04:00:00.000Z',
    });

    const longSecretOutput =
      `TOKEN=abc123\npassword=hunter2\n` +
      `ghp_1234567890abcdefghij1234567890ABCD\n` +
      'x'.repeat(300 * 1024);

    const failed = await store.transitionOperation({
      id: 'op-output-1',
      nextState: 'failed',
      actorUserId: adminUserId,
      source: 'operator',
      message: 'Verification failed',
      metadata: {
        command: 'PGPASSWORD=hunter2 pg_restore --dbname=postgres',
        token: 'ghp_1234567890abcdefghij1234567890ABCD',
      },
      output: longSecretOutput,
      occurredAt: '2026-09-21T04:00:05.000Z',
    });

    expect(failed.output).not.toContain('abc123');
    expect(failed.output).not.toContain('hunter2');
    expect(failed.output).not.toContain('ghp_1234567890abcdefghij1234567890ABCD');
    expect(failed.output).toContain('TOKEN=***');
    expect(failed.output).toContain('password=***');
    expect(failed.output).toContain(OUTPUT_TRUNCATION_MARKER);

    const audits = await store.listAuditEvents();
    expect(audits[0].metadata).toMatchObject({
      command: 'PGPASSWORD=*** pg_restore --dbname=postgres',
      token: '***',
    });
  });

  it('lists operations newest first', async () => {
    await store.createOperation({
      id: 'op-list-1',
      requestedBy: adminUserId,
      type: 'backup_create',
      summary: 'Older operation',
      source: 'admin_api',
      createdAt: '2026-09-21T05:00:00.000Z',
    });
    await store.createOperation({
      id: 'op-list-2',
      requestedBy: adminUserId,
      type: 'backup_restore',
      summary: 'Newer operation',
      source: 'admin_api',
      createdAt: '2026-09-21T05:00:01.000Z',
    });

    const operations = await store.listOperations();
    expect(operations.map((operation) => operation.id)).toEqual(['op-list-2', 'op-list-1']);
  });

  it('stores immutable audit rows and upserts backup metadata records', async () => {
    await store.recordAuditEvent({
      actorUserId: null,
      action: 'admin.login.failed',
      source: 'dashboard',
      outcome: 'rejected',
      metadata: {
        username: 'alice',
        password: 'hunter2',
      },
      createdAt: '2026-09-21T06:00:00.000Z',
    });

    await store.upsertBackupRecord({
      filename: 'ariadne-20260921T060000Z.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      status: 'created',
      createdAt: '2026-09-21T06:00:00.000Z',
      verifiedAt: null,
      restoreVerificationMessage: null,
    });
    await store.upsertBackupRecord({
      filename: 'ariadne-20260921T060000Z.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      status: 'verified',
      createdAt: '2026-09-21T06:00:00.000Z',
      verifiedAt: '2026-09-21T06:05:00.000Z',
      restoreVerificationMessage: 'Restored into verification DB successfully',
    });

    expect(await store.listBackupRecords()).toEqual([
      {
        filename: 'ariadne-20260921T060000Z.dump',
        sha256: 'a'.repeat(64),
        sizeBytes: 1024,
        status: 'verified',
        createdAt: '2026-09-21T06:00:00.000Z',
        verifiedAt: '2026-09-21T06:05:00.000Z',
        restoreVerificationMessage: 'Restored into verification DB successfully',
      },
    ]);

    const audits = await store.listAuditEvents();
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      action: 'admin.login.failed',
      outcome: 'rejected',
      metadata: {
        username: 'alice',
        password: '***',
      },
    });

    await expect(
      pool.query(`UPDATE admin_audit_events SET outcome = 'accepted' WHERE action = 'admin.login.failed'`),
    ).rejects.toThrow(/append-only/i);
    await expect(
      pool.query(`DELETE FROM admin_audit_events WHERE action = 'admin.login.failed'`),
    ).rejects.toThrow(/append-only/i);
  });

  async function countRows(table: string): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    return rows[0].count;
  }
});
