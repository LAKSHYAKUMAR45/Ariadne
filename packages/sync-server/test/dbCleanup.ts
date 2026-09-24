import type { Pool } from 'pg';

/**
 * Test-only cleanup helpers.
 *
 * `migrations/0008_admin_operations.sql` makes `admin_audit_events` strictly
 * append-only, including a `BEFORE TRUNCATE` trigger. Production must keep that
 * guarantee exactly as migrated, but fixture cleanup still needs to wipe
 * `users` (and the tables that cascade from it, `admin_audit_events` included)
 * between tests.
 *
 * `truncateFixtureTables` therefore disables *only* the truncate trigger, for
 * the duration of one controlled `TRUNCATE`, and always re-enables it in a
 * `finally` block — including when the truncate fails. The row-level
 * append-only trigger (`UPDATE`/`DELETE`) is never touched.
 */

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

export const AUDIT_TRUNCATE_TRIGGER_NAME = 'trg_admin_audit_events_append_only_truncate';

/** Tables shared by most fixture suites; `CASCADE` reaches the rest. */
export const CORE_FIXTURE_TABLES = [
  'backup_records',
  'todos',
  'decisions',
  'errors',
  'open_questions',
  'commands',
  'checkpoints',
  'tasks',
  'team_memberships',
  'teams',
  'users',
] as const;

/** Fixture tables for suites that also exercise encrypted task history. */
export const TASK_HISTORY_FIXTURE_TABLES = [
  'task_file_capture_entries',
  'task_file_captures',
  'task_file_history_deletions',
  'encrypted_blobs',
  ...CORE_FIXTURE_TABLES,
] as const;

function assertPlainIdentifiers(tables: readonly string[]): void {
  if (tables.length === 0) {
    throw new Error('truncateFixtureTables requires at least one table name');
  }
  for (const table of tables) {
    if (!IDENTIFIER_PATTERN.test(table)) {
      throw new Error(`invalid table name for test cleanup: ${table}`);
    }
  }
}

async function setAuditTruncateTrigger(pool: Pool, enabled: boolean): Promise<void> {
  await pool.query(
    `ALTER TABLE admin_audit_events ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${AUDIT_TRUNCATE_TRIGGER_NAME}`,
  );
}

/**
 * Truncates fixture tables with `CASCADE`, temporarily disabling the
 * append-only truncate trigger on `admin_audit_events` only for that one
 * statement.
 */
export async function truncateFixtureTables(
  pool: Pool,
  tables: readonly string[] = CORE_FIXTURE_TABLES,
): Promise<void> {
  assertPlainIdentifiers(tables);

  await setAuditTruncateTrigger(pool, false);
  try {
    await pool.query(`TRUNCATE TABLE ${tables.join(', ')} CASCADE`);
  } finally {
    await setAuditTruncateTrigger(pool, true);
  }
}

/** Reports whether the append-only truncate trigger is currently armed. */
export async function isAuditTruncateTriggerEnabled(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ tgenabled: string }>(
    `SELECT tgenabled
       FROM pg_trigger
      WHERE tgrelid = 'admin_audit_events'::regclass
        AND tgname = $1`,
    [AUDIT_TRUNCATE_TRIGGER_NAME],
  );

  if (rows.length === 0) {
    return false;
  }
  return rows[0]!.tgenabled !== 'D';
}
