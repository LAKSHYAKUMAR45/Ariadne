import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskStore } from '../src/TaskStore.js';

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('creates and retrieves a task', () => {
    const task = store.createTask({ title: 'Implement auth', goal: 'JWT login' });
    expect(task.id).toBeTruthy();
    expect(task.title).toBe('Implement auth');
    expect(task.status).toBe('active');

    const fetched = store.getTask(task.id);
    expect(fetched).toEqual(task);
  });

  it('lists tasks filtered by status, most recently updated first', () => {
    const a = store.createTask({ title: 'A' });
    const b = store.createTask({ title: 'B' });
    store.updateTaskStatus(b.id, 'done');

    expect(store.listTasks({ status: 'active' }).map((t) => t.id)).toEqual([a.id]);
    expect(store.listTasks({ status: 'done' }).map((t) => t.id)).toEqual([b.id]);
  });

  it('creates checkpoints and finds the latest one', () => {
    const task = store.createTask({ title: 'Task with checkpoints' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'first' });
    const second = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'second' });

    const latest = store.latestCheckpoint(task.id);
    expect(latest?.id).toBe(second.id);
    expect(store.listCheckpoints(task.id)).toHaveLength(2);
  });

  it('upserts file touches and keeps the latest role', () => {
    const task = store.createTask({ title: 'Task with files' });
    store.touchFile({ taskId: task.id, path: 'src/index.ts', role: 'read' });
    store.touchFile({ taskId: task.id, path: 'src/index.ts', role: 'edited' });

    const files = store.listFiles(task.id);
    expect(files).toHaveLength(1);
    expect(files[0].role).toBe('edited');
  });

  it('records commits, decisions, todos, commands, errors, and open questions', () => {
    const task = store.createTask({ title: 'Full lifecycle task' });

    const commit = store.recordCommit({ taskId: task.id, sha: 'abc123', message: 'init' });
    expect(store.listCommits(task.id)).toEqual([commit]);

    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite' });
    expect(store.listDecisions(task.id)).toEqual([decision]);

    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });
    expect(store.listTodos(task.id, { status: 'pending' })).toEqual([todo]);
    store.updateTodoStatus(todo.id, 'done');
    expect(store.listTodos(task.id, { status: 'done' })[0].id).toBe(todo.id);

    const command = store.recordCommand({ taskId: task.id, cmdRedacted: 'npm test', exitCode: 0 });
    expect(store.listCommands(task.id)).toEqual([command]);

    const error = store.recordError({ taskId: task.id, message: 'TypeError: x is undefined' });
    expect(store.listErrors(task.id, { resolved: false })).toEqual([error]);
    store.resolveError(error.id, 'Added null check');
    expect(store.listErrors(task.id, { resolved: true })[0].resolution).toBe('Added null check');

    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Unix socket or TCP?' });
    expect(store.listOpenQuestions(task.id, { resolved: false })).toEqual([question]);
    store.resolveOpenQuestion(question.id);
    expect(store.listOpenQuestions(task.id, { resolved: true })[0].id).toBe(question.id);
  });

  it('tracks the current task id in the DB (schema_meta), not a separate file', () => {
    expect(store.getCurrentTaskId()).toBeUndefined();
    const task = store.createTask({ title: 'A' });
    store.setCurrentTaskId(task.id);
    expect(store.getCurrentTaskId()).toBe(task.id);

    const task2 = store.createTask({ title: 'B' });
    store.setCurrentTaskId(task2.id);
    expect(store.getCurrentTaskId()).toBe(task2.id);
  });

  it('supports editing and deleting a task title/goal (curation)', () => {
    const task = store.createTask({ title: 'Original title', goal: 'Original goal' });
    store.updateTaskTitle(task.id, 'Fixed title');
    store.updateTaskGoal(task.id, 'Fixed goal');
    const updated = store.getTask(task.id);
    expect(updated?.title).toBe('Fixed title');
    expect(updated?.goal).toBe('Fixed goal');

    store.updateTaskGoal(task.id, null);
    expect(store.getTask(task.id)?.goal).toBeNull();
  });

  it('supports editing and deleting a decision (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite', rationale: 'simple' });

    store.updateDecision(decision.id, { text: 'Use SQLite (WAL mode)' });
    expect(store.getDecision(decision.id)?.text).toBe('Use SQLite (WAL mode)');
    expect(store.getDecision(decision.id)?.rationale).toBe('simple');

    store.updateDecision(decision.id, { rationale: null });
    expect(store.getDecision(decision.id)?.rationale).toBeNull();

    store.deleteDecision(decision.id);
    expect(store.getDecision(decision.id)).toBeUndefined();
    expect(store.listDecisions(task.id)).toEqual([]);
  });

  it('supports editing and deleting a todo, and reopening a done todo (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const todo = store.createTodo({ taskId: task.id, text: 'Write tests' });

    store.updateTodoText(todo.id, 'Write more tests');
    expect(store.getTodo(todo.id)?.text).toBe('Write more tests');

    store.updateTodoStatus(todo.id, 'done');
    expect(store.getTodo(todo.id)?.status).toBe('done');
    // "Reopen" is just setting status back to pending — already supported by updateTodoStatus.
    store.updateTodoStatus(todo.id, 'pending');
    expect(store.getTodo(todo.id)?.status).toBe('pending');

    store.deleteTodo(todo.id);
    expect(store.getTodo(todo.id)).toBeUndefined();
  });

  it('supports editing, deleting, and reopening a resolved error (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const error = store.recordError({ taskId: task.id, message: 'boom' });

    store.updateError(error.id, 'boom (with stack trace)');
    expect(store.getError(error.id)?.message).toBe('boom (with stack trace)');

    store.resolveError(error.id, 'fixed');
    expect(store.getError(error.id)?.resolved).toBe(true);
    store.unresolveError(error.id);
    expect(store.getError(error.id)?.resolved).toBe(false);
    expect(store.getError(error.id)?.resolution).toBeNull();

    store.deleteError(error.id);
    expect(store.getError(error.id)).toBeUndefined();
  });

  it('supports editing, deleting, and reopening a resolved open question (curation)', () => {
    const task = store.createTask({ title: 'A' });
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'Unix socket or TCP?' });

    store.updateOpenQuestion(question.id, 'Unix socket, TCP, or named pipe?');
    expect(store.getOpenQuestion(question.id)?.text).toBe('Unix socket, TCP, or named pipe?');

    store.resolveOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(true);
    store.unresolveOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)?.resolved).toBe(false);

    store.deleteOpenQuestion(question.id);
    expect(store.getOpenQuestion(question.id)).toBeUndefined();
  });

  it('bumps the parent task updated_at when a todo/error/question is resolved or reopened', async () => {
    const task = store.createTask({ title: 'A' });
    const initialUpdatedAt = store.getTask(task.id)!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const todo = store.createTodo({ taskId: task.id, text: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.updateTodoStatus(todo.id, 'done');
    expect(store.getTask(task.id)!.updatedAt > initialUpdatedAt).toBe(true);

    const afterTodoDone = store.getTask(task.id)!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const error = store.recordError({ taskId: task.id, message: 'boom' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.resolveError(error.id);
    expect(store.getTask(task.id)!.updatedAt > afterTodoDone).toBe(true);

    const afterErrorResolve = store.getTask(task.id)!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const question = store.recordOpenQuestion({ taskId: task.id, text: 'y?' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.resolveOpenQuestion(question.id);
    expect(store.getTask(task.id)!.updatedAt > afterErrorResolve).toBe(true);
  });

  describe('cloud sync helpers', () => {
    it('a freshly created task/checkpoint has null remoteId/syncedAt and shows up as needing push', () => {
      const task = store.createTask({ title: 'A' });
      expect(task.remoteId).toBeNull();
      expect(task.syncedAt).toBeNull();
      expect(store.listTasksNeedingPush().map((t) => t.id)).toContain(task.id);

      const checkpoint = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'did a thing' });
      expect(checkpoint.remoteId).toBeNull();
      expect(checkpoint.syncedAt).toBeNull();
      expect(store.listCheckpointsNeedingPush(task.id).map((c) => c.id)).toContain(checkpoint.id);
    });

    it('setTaskRemoteSync records the remote id/timestamp and removes the task from the needing-push list until it changes again', async () => {
      const task = store.createTask({ title: 'A' });
      store.setTaskRemoteSync(task.id, 'remote-123', new Date().toISOString());

      const synced = store.getTask(task.id)!;
      expect(synced.remoteId).toBe('remote-123');
      expect(synced.syncedAt).toBeTruthy();
      expect(store.listTasksNeedingPush().map((t) => t.id)).not.toContain(task.id);

      await new Promise((resolve) => setTimeout(resolve, 5));
      store.updateTaskTitle(task.id, 'A (renamed)');
      expect(store.listTasksNeedingPush().map((t) => t.id)).toContain(task.id);
    });

    it('getTaskByRemoteId finds a task by its cloud-sync-server id', () => {
      const task = store.createTask({ title: 'A' });
      store.setTaskRemoteSync(task.id, 'remote-abc', new Date().toISOString());
      expect(store.getTaskByRemoteId('remote-abc')?.id).toBe(task.id);
      expect(store.getTaskByRemoteId('nonexistent')).toBeUndefined();
    });

    it('setCheckpointRemoteSync records the remote id/timestamp and removes the checkpoint from the needing-push list', () => {
      const task = store.createTask({ title: 'A' });
      const checkpoint = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'did a thing' });

      store.setCheckpointRemoteSync(checkpoint.id, 'remote-ckpt-1', new Date().toISOString());

      const synced = store.getCheckpoint(checkpoint.id)!;
      expect(synced.remoteId).toBe('remote-ckpt-1');
      expect(synced.syncedAt).toBeTruthy();
      expect(store.listCheckpointsNeedingPush(task.id)).toEqual([]);
    });

    it('listCheckpointsNeedingPush without a taskId scans across all tasks', () => {
      const taskA = store.createTask({ title: 'A' });
      const taskB = store.createTask({ title: 'B' });
      store.createCheckpoint({ taskId: taskA.id, level: 'micro', summary: 'a' });
      const ckptB = store.createCheckpoint({ taskId: taskB.id, level: 'micro', summary: 'b' });
      store.setCheckpointRemoteSync(ckptB.id, 'remote-b', new Date().toISOString());

      const needingPush = store.listCheckpointsNeedingPush();
      expect(needingPush.map((c) => c.taskId)).toEqual([taskA.id]);
    });

    it('applyPulledTask overwrites local fields and updatedAt/syncedAt from a pulled remote task', () => {
      const task = store.createTask({ title: 'Old title', goal: 'old goal' });
      store.setTaskRemoteSync(task.id, 'remote-1', new Date().toISOString());

      store.applyPulledTask(task.id, {
        title: 'New title from server',
        goal: 'new goal',
        status: 'done',
        branch: 'main',
        updatedAt: '2026-08-01T00:00:00.000Z',
        syncedAt: '2026-08-01T00:00:01.000Z',
      });

      const updated = store.getTask(task.id)!;
      expect(updated.title).toBe('New title from server');
      expect(updated.goal).toBe('new goal');
      expect(updated.status).toBe('done');
      expect(updated.branch).toBe('main');
      expect(updated.updatedAt).toBe('2026-08-01T00:00:00.000Z');
      expect(updated.syncedAt).toBe('2026-08-01T00:00:01.000Z');
      // Applying a pull shouldn't make the task look like it needs pushing again.
      expect(store.listTasksNeedingPush().map((t) => t.id)).not.toContain(task.id);
    });

    it('insertPulledTask creates a new local task from a remote task, already linked and using the server timestamps', () => {
      const task = store.insertPulledTask({
        remoteId: 'remote-imported-1',
        title: "Teammate's task",
        goal: 'goal from server',
        status: 'active',
        branch: 'feature/x',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
        syncedAt: '2026-06-02T00:00:05.000Z',
      });

      expect(task.title).toBe("Teammate's task");
      expect(task.goal).toBe('goal from server');
      expect(task.status).toBe('active');
      expect(task.branch).toBe('feature/x');
      expect(task.remoteId).toBe('remote-imported-1');
      expect(task.createdAt).toBe('2026-06-01T00:00:00.000Z');
      expect(task.updatedAt).toBe('2026-06-02T00:00:00.000Z');
      expect(task.syncedAt).toBe('2026-06-02T00:00:05.000Z');

      // Newly imported task is already fully synced — shouldn't need pushing.
      expect(store.listTasksNeedingPush().map((t) => t.id)).not.toContain(task.id);
      expect(store.getTaskByRemoteId('remote-imported-1')?.id).toBe(task.id);
    });

    it('insertPulledCheckpoint creates a locally-unknown checkpoint already marked synced, and getCheckpointByRemoteId finds it', () => {
      const task = store.createTask({ title: 'A' });

      const inserted = store.insertPulledCheckpoint({
        taskId: task.id,
        remoteId: 'remote-ckpt-9',
        level: 'milestone',
        summary: 'From another machine',
        createdAt: '2026-08-01T00:00:00.000Z',
        syncedAt: '2026-08-01T00:00:01.000Z',
      });

      expect(inserted.remoteId).toBe('remote-ckpt-9');
      expect(inserted.createdAt).toBe('2026-08-01T00:00:00.000Z');
      expect(store.getCheckpointByRemoteId('remote-ckpt-9')?.id).toBe(inserted.id);
      expect(store.listCheckpointsNeedingPush(task.id)).toEqual([]);
    });
  });
});

