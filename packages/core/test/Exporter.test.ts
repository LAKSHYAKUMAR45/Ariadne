import { describe, it, expect } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';
import { exportTaskMarkdown } from '../src/Exporter.js';

describe('exportTaskMarkdown', () => {
  it('throws for an unknown task', () => {
    const store = new TaskStore(':memory:');
    expect(() => exportTaskMarkdown(store, 'nope')).toThrow(/not found/);
    store.close();
  });

  it('renders a minimal task with no history', () => {
    const store = new TaskStore(':memory:');
    const task = store.createTask({ title: 'Fix login bug', goal: 'Users cannot log in' });
    const md = exportTaskMarkdown(store, task.id);
    expect(md).toContain('# Fix login bug');
    expect(md).toContain('Users cannot log in');
    expect(md).toContain('_No checkpoints recorded._');
    expect(md).toContain('_No todos recorded._');
    store.close();
  });

  it('renders full task history across all sections', () => {
    const store = new TaskStore(':memory:');
    const task = store.createTask({ title: 'Add feature X' });
    store.createCheckpoint({ taskId: task.id, level: 'session', summary: 'started work' });
    const todo = store.createTodo({ taskId: task.id, text: 'write tests' });
    store.updateTodoStatus(todo.id, 'done');
    store.recordDecision({ taskId: task.id, text: 'use SQLite', rationale: 'queryable' });
    store.recordError({ taskId: task.id, message: 'build failed' });
    store.touchFile({ taskId: task.id, path: 'src/index.ts', role: 'edited' });
    store.recordCommit({ taskId: task.id, sha: 'abc123456789', message: 'Initial commit' });
    store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', exitCode: 0 });
    store.recordOpenQuestion({ taskId: task.id, text: 'should we support multi-repo?' });

    const md = exportTaskMarkdown(store, task.id);
    expect(md).toContain('# Add feature X');
    expect(md).toContain('started work');
    expect(md).toContain('- [x] write tests');
    expect(md).toContain('use SQLite');
    expect(md).toContain('Rationale: queryable');
    expect(md).toContain('build failed');
    expect(md).toContain('`src/index.ts` (edited)');
    expect(md).toContain('`abc1234` Initial commit');
    expect(md).toContain('`npm test` (exit 0)');
    expect(md).toContain('should we support multi-repo?');
    store.close();
  });
});
