import { describe, it, expect } from 'vitest';
import { PluginRegistry, type AriadnePlugin } from '../src/PluginRegistry.js';
import type { Checkpoint, Task } from '../src/types.js';

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

describe('PluginRegistry', () => {
  it('registers a plugin and dispatches subscribed events to it', async () => {
    const seen: unknown[] = [];
    const plugin: AriadnePlugin = {
      name: 'test-plugin',
      activate: () => ({
        'checkpoint.created': (payload) => {
          seen.push(payload);
        },
      }),
    };

    const registry = new PluginRegistry({ workspaceRoot: '/tmp/example' });
    registry.register(plugin);
    expect(registry.listPlugins()).toEqual(['test-plugin']);

    const task = makeTask();
    const checkpoint = makeCheckpoint();
    const results = await registry.emit('checkpoint.created', { task, checkpoint });

    expect(seen).toEqual([{ task, checkpoint }]);
    expect(results).toEqual([{ pluginName: 'test-plugin', error: undefined }]);
  });

  it('does not notify a plugin of an event it did not subscribe to', async () => {
    const calls: string[] = [];
    const plugin: AriadnePlugin = {
      name: 'todo-only-plugin',
      activate: () => ({
        'todo.added': () => {
          calls.push('todo.added');
        },
      }),
    };

    const registry = new PluginRegistry({ workspaceRoot: '/tmp/example' });
    registry.register(plugin);
    await registry.emit('checkpoint.created', { task: makeTask(), checkpoint: makeCheckpoint() });

    expect(calls).toEqual([]);
  });

  it('passes the AriadnePluginContext into activate()', () => {
    let receivedRoot: string | undefined;
    const plugin: AriadnePlugin = {
      name: 'context-check-plugin',
      activate: (context) => {
        receivedRoot = context.workspaceRoot;
      },
    };

    const registry = new PluginRegistry({ workspaceRoot: '/my/workspace' });
    registry.register(plugin);

    expect(receivedRoot).toBe('/my/workspace');
  });

  it('rejects registering two plugins with the same name', () => {
    const plugin: AriadnePlugin = { name: 'dup', activate: () => ({}) };
    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(plugin);
    expect(() => registry.register(plugin)).toThrow(/already registered/i);
  });

  it('isolates a throwing plugin hook: other plugins still run and the error is reported, not thrown', async () => {
    const goodPluginCalls: string[] = [];
    const throwingPlugin: AriadnePlugin = {
      name: 'throwing-plugin',
      activate: () => ({
        'checkpoint.created': () => {
          throw new Error('boom');
        },
      }),
    };
    const goodPlugin: AriadnePlugin = {
      name: 'good-plugin',
      activate: () => ({
        'checkpoint.created': () => {
          goodPluginCalls.push('ran');
        },
      }),
    };

    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(throwingPlugin);
    registry.register(goodPlugin);

    const results = await registry.emit('checkpoint.created', { task: makeTask(), checkpoint: makeCheckpoint() });

    expect(goodPluginCalls).toEqual(['ran']);
    const throwingResult = results.find((r) => r.pluginName === 'throwing-plugin');
    expect(throwingResult?.error).toBeInstanceOf(Error);
    expect((throwingResult?.error as Error).message).toBe('boom');
    const goodResult = results.find((r) => r.pluginName === 'good-plugin');
    expect(goodResult?.error).toBeUndefined();
  });

  it('isolates a rejecting async plugin hook the same way as a throwing sync one', async () => {
    const plugin: AriadnePlugin = {
      name: 'async-throwing-plugin',
      activate: () => ({
        'task.statusChanged': async () => {
          throw new Error('async boom');
        },
      }),
    };

    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    registry.register(plugin);

    const results = await registry.emit('task.statusChanged', {
      task: makeTask({ status: 'done' }),
      previousStatus: 'active',
      status: 'done',
    });

    expect(results).toEqual([{ pluginName: 'async-throwing-plugin', error: expect.any(Error) }]);
  });

  it('returns an empty results array for an event with no subscribers', async () => {
    const registry = new PluginRegistry({ workspaceRoot: '/tmp' });
    const results = await registry.emit('decision.added', {
      task: makeTask(),
      decision: {
        id: 'dec-1',
        taskId: 'task-1',
        text: 'Use SQLite',
        rationale: null,
        createdAt: new Date().toISOString(),
      },
    });
    expect(results).toEqual([]);
  });
});
