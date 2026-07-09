import { describe, it, expect, vi, afterEach } from 'vitest';
import { PluginRegistry } from '@ariadne-dev/core';
import type { Checkpoint, Task } from '@ariadne-dev/core';
import { consoleLoggerPlugin } from '../src/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Sample task',
    goal: null,
    status: 'active',
    parentTaskId: null,
    branch: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'cp-1',
    taskId: 'task-1',
    parentCheckpointId: null,
    level: 'micro',
    summary: 'Did a thing',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('consoleLoggerPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers under the name "console-logger" and subscribes to checkpoint.created', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(consoleLoggerPlugin);

    expect(registry.listPlugins()).toEqual(['console-logger']);

    const task = makeTask();
    const checkpoint = makeCheckpoint();
    const results = await registry.emit('checkpoint.created', { task, checkpoint });

    expect(results).toEqual([{ pluginName: 'console-logger', error: undefined }]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Did a thing'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Sample task'));
  });

  it('logs task.statusChanged with both the previous and new status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(consoleLoggerPlugin);

    await registry.emit('task.statusChanged', {
      task: makeTask({ status: 'done' }),
      previousStatus: 'active',
      status: 'done',
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('active -> done'));
  });

  it('logs todo.added, decision.added, error.added, and question.added', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(consoleLoggerPlugin);
    const task = makeTask();

    await registry.emit('todo.added', {
      task,
      todo: { id: 't1', taskId: task.id, text: 'Write docs', status: 'pending', createdAt: new Date().toISOString() },
    });
    await registry.emit('decision.added', {
      task,
      decision: { id: 'd1', taskId: task.id, text: 'Use SQLite', rationale: null, createdAt: new Date().toISOString() },
    });
    await registry.emit('error.added', {
      task,
      error: {
        id: 'e1',
        taskId: task.id,
        message: 'Build failed',
        resolved: false,
        resolution: null,
        createdAt: new Date().toISOString(),
      },
    });
    await registry.emit('question.added', {
      task,
      question: { id: 'q1', taskId: task.id, text: 'Which DB?', resolved: false, createdAt: new Date().toISOString() },
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Write docs'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Use SQLite'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Build failed'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Which DB?'));
  });
});
