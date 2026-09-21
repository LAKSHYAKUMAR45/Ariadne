import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/schema.js';
import { runMigrations, MIGRATIONS, type Migration } from '../src/migrations.js';
import { openDatabase } from '../src/db.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('runMigrations', () => {
  it('is a no-op against a fresh v1 database when there are no pending migrations', () => {
    const db = freshDb();
    expect(() => runMigrations(db, [])).not.toThrow();
    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(version.value).toBe('1');
  });

  it('applies a pending migration and bumps schema_version', () => {
    const db = freshDb();
    const migration: Migration = {
      version: 2,
      description: 'add a note column to tasks',
      up: (d) => d.exec(`ALTER TABLE tasks ADD COLUMN note TEXT`),
    };

    runMigrations(db, [migration]);

    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(version.value).toBe('2');

    // The column should actually exist now.
    expect(() => db.prepare(`SELECT note FROM tasks`).all()).not.toThrow();
  });

  it('does not re-apply a migration once its version has already been recorded', () => {
    const db = freshDb();
    let calls = 0;
    const migration: Migration = {
      version: 2,
      description: 'count calls',
      up: () => {
        calls++;
      },
    };

    runMigrations(db, [migration]);
    runMigrations(db, [migration]);

    expect(calls).toBe(1);
  });

  it('applies multiple pending migrations in ascending version order', () => {
    const db = freshDb();
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 3, description: 'third', up: () => order.push(3) },
      { version: 2, description: 'second', up: () => order.push(2) },
    ];

    runMigrations(db, migrations);

    expect(order).toEqual([2, 3]);
    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(version.value).toBe('3');
  });

  it('rolls back and throws a descriptive error if a migration fails, leaving schema_version unchanged', () => {
    const db = freshDb();
    const migration: Migration = {
      version: 2,
      description: 'a broken migration',
      up: (d) => d.exec(`ALTER TABLE nonexistent_table ADD COLUMN x TEXT`),
    };

    expect(() => runMigrations(db, [migration])).toThrow(/a broken migration/);

    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(version.value).toBe('1');
  });
});

describe('MIGRATIONS (real app migrations)', () => {
  it('v2 adds remote_id/synced_at columns to tasks and checkpoints, nullable and defaulting to null', () => {
    const db = openDatabase(':memory:');

    // openDatabase already runs MIGRATIONS, so schema_version should reflect the latest.
    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(Number(version.value)).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);

    db.prepare(
      `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t1', 'Task', 'active', '2020-01-01', '2020-01-01')`,
    ).run();
    const task = db.prepare(`SELECT remote_id, synced_at FROM tasks WHERE id = 't1'`).get() as {
      remote_id: string | null;
      synced_at: string | null;
    };
    expect(task.remote_id).toBeNull();
    expect(task.synced_at).toBeNull();

    db.prepare(
      `INSERT INTO checkpoints (id, task_id, level, summary, created_at) VALUES ('c1', 't1', 'micro', 'did a thing', '2020-01-01')`,
    ).run();
    const checkpoint = db.prepare(`SELECT remote_id, synced_at FROM checkpoints WHERE id = 'c1'`).get() as {
      remote_id: string | null;
      synced_at: string | null;
    };
    expect(checkpoint.remote_id).toBeNull();
    expect(checkpoint.synced_at).toBeNull();

    db.close();
  });

  it('v4 adds updated_at to decisions/errors/open_questions/commands and backfills existing rows from created_at', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 3));

    db.prepare(`INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t1', 'Task', 'active', '2020-01-01', '2020-01-01')`).run();
    db.prepare(`INSERT INTO decisions (id, task_id, text, created_at) VALUES ('d1', 't1', 'Decide', '2020-01-02')`).run();
    db.prepare(`INSERT INTO errors (id, task_id, message, resolved, created_at) VALUES ('e1', 't1', 'Oops', 0, '2020-01-03')`).run();
    db.prepare(`INSERT INTO open_questions (id, task_id, text, resolved, created_at) VALUES ('q1', 't1', 'Why?', 0, '2020-01-04')`).run();
    db.prepare(`INSERT INTO commands (id, task_id, cmd_redacted, created_at) VALUES ('c1', 't1', 'npm test', '2020-01-05')`).run();

    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 4));

    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe('4');
    expect(() => db.prepare(`SELECT updated_at FROM decisions`).all()).not.toThrow();
    expect(() => db.prepare(`SELECT updated_at FROM errors`).all()).not.toThrow();
    expect(() => db.prepare(`SELECT updated_at FROM open_questions`).all()).not.toThrow();
    expect(() => db.prepare(`SELECT updated_at FROM commands`).all()).not.toThrow();

    expect((db.prepare(`SELECT created_at, updated_at FROM decisions WHERE id = 'd1'`).get() as { created_at: string; updated_at: string }).updated_at).toBe('2020-01-02');
    expect((db.prepare(`SELECT created_at, updated_at FROM errors WHERE id = 'e1'`).get() as { created_at: string; updated_at: string }).updated_at).toBe('2020-01-03');
    expect((db.prepare(`SELECT created_at, updated_at FROM open_questions WHERE id = 'q1'`).get() as { created_at: string; updated_at: string }).updated_at).toBe('2020-01-04');
    expect((db.prepare(`SELECT created_at, updated_at FROM commands WHERE id = 'c1'`).get() as { created_at: string; updated_at: string }).updated_at).toBe('2020-01-05');

    db.close();
  });

  it('v5 adds immutable task file captures with same-task reference integrity', () => {
    const db = freshDb();
    runMigrations(db, MIGRATIONS.filter((m) => m.version <= 4));

    db.prepare(
      `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t1', 'Task', 'active', '2020-01-01', '2020-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES ('t2', 'Other task', 'active', '2020-01-01', '2020-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, level, summary, created_at) VALUES ('cp1', 't1', 'micro', 'checkpoint', '2020-01-02')`,
    ).run();
    db.prepare(
      `INSERT INTO checkpoints (id, task_id, level, summary, created_at) VALUES ('cp2', 't2', 'micro', 'other checkpoint', '2020-01-02')`,
    ).run();
    db.prepare(
      `INSERT INTO commits (sha, task_id, message, created_at) VALUES ('commit-1', 't1', 'capture commit', '2020-01-02')`,
    ).run();
    db.prepare(
      `INSERT INTO decisions (id, task_id, text, created_at, updated_at) VALUES ('d1', 't1', 'Decide', '2020-01-03', '2020-01-03')`,
    ).run();
    runMigrations(db, MIGRATIONS);

    const version = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(version.value).toBe('5');
    expect((db.prepare(`SELECT COUNT(*) AS count FROM tasks`).get() as { count: number }).count).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM checkpoints`).get() as { count: number }).count).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM decisions`).get() as { count: number }).count).toBe(1);

    db.prepare(
      `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
       VALUES ('cap-g1', 't1', 'git_commit', 'commit-1', NULL, '2020-01-04', NULL)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-g2', 't1', 'git_commit', 'commit-1', NULL, '2020-01-05', NULL)`,
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-g3', 't1', 'git_commit', 'missing-commit', NULL, '2020-01-05', NULL)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-g4', 't2', 'git_commit', 'commit-1', NULL, '2020-01-05', NULL)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);

    db.prepare(
      `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
       VALUES ('cap-c1', 't1', 'checkpoint', NULL, 'cp1', '2020-01-06', NULL)`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-c2', 't1', 'checkpoint', NULL, 'cp1', '2020-01-07', NULL)`,
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-c3', 't1', 'checkpoint', NULL, 'missing-checkpoint', '2020-01-07', NULL)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-c4', 't2', 'checkpoint', NULL, 'cp1', '2020-01-07', NULL)`,
      ).run(),
    ).toThrow(/FOREIGN KEY/);

    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-e1', 't1', 'explicit', NULL, NULL, '2020-01-08', NULL)`,
      ).run(),
    ).not.toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO task_file_captures (id, task_id, trigger, git_commit_sha, checkpoint_id, created_at, synced_at)
         VALUES ('cap-e2', 't1', 'explicit', NULL, NULL, '2020-01-09', NULL)`,
      ).run(),
    ).not.toThrow();

    expect(() =>
      db.prepare(
        `INSERT INTO task_file_capture_entries (capture_id, path, content, unified_diff, byte_length, content_sha256)
         VALUES ('cap-e1', 'src/index.ts', 'content', '@@ -0,0 +1 @@', 7, 'sha256')`,
      ).run(),
    ).not.toThrow();
    expect(
      db.prepare(`SELECT path, content_sha256 FROM task_file_capture_entries WHERE capture_id = 'cap-e1'`).get(),
    ).toEqual({ path: 'src/index.ts', content_sha256: 'sha256' });

    db.close();
  });
});
