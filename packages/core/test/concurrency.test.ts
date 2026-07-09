import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskStore } from '../src/TaskStore.js';

/**
 * Simulates two separate processes (e.g. the CLI and the VS Code extension)
 * holding independent TaskStore connections open against the *same* on-disk
 * `.ariadne/state.db` file concurrently. WAL mode (enabled in db.ts) is what
 * makes this safe: SQLite arbitrates writes across connections/processes via
 * its own file locking, regardless of how long each connection stays open.
 */
describe('concurrent TaskStore access to the same db file', () => {
  let tmpDir: string;
  let dbPath: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('interleaves writes from two connections without data loss or corruption', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-concurrency-test-'));
    dbPath = path.join(tmpDir, 'state.db');

    const connA = new TaskStore(dbPath);
    const connB = new TaskStore(dbPath);

    try {
      const task = connA.createTask({ title: 'Shared task' });

      // Interleave writes from both connections as if two processes were
      // racing to record todos against the same task.
      const created: string[] = [];
      for (let i = 0; i < 20; i++) {
        const conn = i % 2 === 0 ? connA : connB;
        const todo = conn.createTodo({ taskId: task.id, text: `todo ${i}` });
        created.push(todo.id);
      }

      // Both connections should see every write, regardless of which one made it.
      const viaA = connA.listTodos(task.id);
      const viaB = connB.listTodos(task.id);
      expect(viaA).toHaveLength(20);
      expect(viaB).toHaveLength(20);
      expect(new Set(viaA.map((t) => t.id))).toEqual(new Set(created));
      expect(new Set(viaB.map((t) => t.id))).toEqual(new Set(created));
    } finally {
      connA.close();
      connB.close();
    }
  });

  it('reopening a fresh connection after another closes sees all committed writes', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-concurrency-test-'));
    dbPath = path.join(tmpDir, 'state.db');

    const first = new TaskStore(dbPath);
    const task = first.createTask({ title: 'Persisted across connections' });
    first.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'first pass' });
    first.close();

    const second = new TaskStore(dbPath);
    try {
      expect(second.getTask(task.id)?.title).toBe('Persisted across connections');
      expect(second.latestCheckpoint(task.id)?.summary).toBe('first pass');
    } finally {
      second.close();
    }
  });
});
