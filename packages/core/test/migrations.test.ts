import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/schema.js';
import { runMigrations, type Migration } from '../src/migrations.js';

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
