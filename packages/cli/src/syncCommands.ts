import type { TaskStore, TaskStatus } from '@ariadne-dev/core';
import { readSyncConfig, writeSyncConfig, requireSyncConfig } from './syncConfig.js';
import * as syncClient from './syncClient.js';

/** `ariadne sync register <username> <password>` — creates an account, then logs in immediately for convenience. */
export async function runSyncRegister(username: string, password: string, serverUrl: string): Promise<void> {
  await syncClient.register(serverUrl, username, password);
  console.log(`Registered account "${username}" on ${serverUrl}.`);
  await runSyncLogin(username, password, serverUrl);
}

/** `ariadne sync login <username> <password>` — authenticates and persists the token to `~/.ariadne/sync-config.json`. */
export async function runSyncLogin(username: string, password: string, serverUrl: string): Promise<void> {
  const { token } = await syncClient.login(serverUrl, username, password);
  const existing = readSyncConfig();
  writeSyncConfig({ ...existing, serverUrl, token, username });
  console.log(`Logged in to ${serverUrl} as ${username}.`);
}

/** `ariadne sync logout` — forgets the locally-stored token (does not affect the account on the server). */
export function runSyncLogout(): void {
  const config = readSyncConfig();
  if (!config) {
    console.log('Already logged out.');
    return;
  }
  writeSyncConfig({ ...config, token: '' });
  console.log('Logged out (local token cleared).');
}

/**
 * `ariadne sync push [--task <id>]` — pushes every task (or just `taskId`,
 * if given) that's new or changed since its last sync, then pushes any
 * not-yet-synced checkpoints belonging to those tasks. Checkpoints are
 * pushed after their parent task, since the server requires the task to
 * already exist (`remoteTaskId` must resolve) before accepting checkpoints
 * for it.
 */
export async function runSyncPush(store: TaskStore, taskId?: string): Promise<void> {
  const config = requireSyncConfig();
  const tasksToPush = taskId
    ? store.listTasksNeedingPush().filter((t) => t.id === taskId)
    : store.listTasksNeedingPush();

  if (tasksToPush.length === 0 && taskId) {
    // The task may simply have nothing new to push — still push its checkpoints below.
    console.log(`Task ${taskId} has no pending task-level changes to push.`);
  }

  if (tasksToPush.length > 0) {
    const { results } = await syncClient.pushTasks(
      config.serverUrl,
      config.token,
      tasksToPush.map((t) => ({
        localId: t.id,
        remoteId: t.remoteId,
        title: t.title,
        goal: t.goal,
        status: t.status,
        branch: t.branch,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    );
    for (const r of results) {
      store.setTaskRemoteSync(r.localId, r.remoteId, r.updatedAt);
    }
    console.log(`Pushed ${results.length} task(s).`);
  }

  const taskIdsToCheck = taskId ? [taskId] : store.listTasks().map((t) => t.id);
  let checkpointsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    if (!task) continue;
    // A checkpoint can't be pushed until its parent task has a remoteId (server needs it to exist first).
    const remoteTaskId = task.remoteId ?? undefined;
    if (!remoteTaskId) continue;

    const pending = store.listCheckpointsNeedingPush(id);
    if (pending.length === 0) continue;

    const { results } = await syncClient.pushCheckpoints(
      config.serverUrl,
      config.token,
      pending.map((c) => ({
        localId: c.id,
        remoteTaskId,
        level: c.level,
        summary: c.summary,
        createdAt: c.createdAt,
      })),
    );
    const now = new Date().toISOString();
    for (const r of results) {
      store.setCheckpointRemoteSync(r.localId, r.remoteId, now);
    }
    checkpointsPushed += results.length;
  }
  if (checkpointsPushed > 0) {
    console.log(`Pushed ${checkpointsPushed} checkpoint(s).`);
  }
  if (tasksToPush.length === 0 && checkpointsPushed === 0 && !taskId) {
    console.log('Nothing to push — everything is already synced.');
  }
}

/**
 * `ariadne sync pull [--task <id>]` — pulls tasks changed on the server
 * since the last pull and applies them to any local task already linked
 * via `remoteId` (tasks never pushed from this workspace are skipped —
 * pull only updates rows this workspace already knows about, it does not
 * create brand-new local tasks for ones from other workspaces). Then pulls
 * new checkpoints for every task this workspace has synced.
 */
export async function runSyncPull(store: TaskStore, taskId?: string): Promise<void> {
  const config = requireSyncConfig();

  const { tasks, serverTime } = await syncClient.pullTasks(config.serverUrl, config.token, config.lastTasksPullAt);
  let updated = 0;
  let unknown = 0;
  for (const remoteTask of tasks) {
    const local = store.getTaskByRemoteId(remoteTask.remoteId);
    if (!local) {
      unknown++;
      continue;
    }
    if (taskId && local.id !== taskId) continue;
    store.applyPulledTask(local.id, {
      title: remoteTask.title,
      goal: remoteTask.goal,
      status: remoteTask.status as TaskStatus,
      branch: remoteTask.branch,
      updatedAt: remoteTask.updatedAt,
      syncedAt: serverTime,
    });
    updated++;
  }
  writeSyncConfig({ ...config, lastTasksPullAt: serverTime });
  console.log(`Pulled ${updated} task update(s)${unknown > 0 ? ` (${unknown} belong to workspaces not linked here, skipped)` : ''}.`);

  const checkpointsPullAt = { ...(config.checkpointsPullAt ?? {}) };
  let checkpointsInserted = 0;
  const linkedTasks = (taskId ? [store.getTask(taskId)].filter((t): t is NonNullable<typeof t> => !!t) : store.listTasks()).filter(
    (t) => t.remoteId,
  );
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = checkpointsPullAt[remoteTaskId];
    const { checkpoints, serverTime: checkpointServerTime } = await syncClient.pullCheckpoints(
      config.serverUrl,
      config.token,
      remoteTaskId,
      since,
    );
    for (const remoteCkpt of checkpoints) {
      if (store.getCheckpointByRemoteId(remoteCkpt.remoteId)) continue; // already have it locally
      store.insertPulledCheckpoint({
        taskId: task.id,
        remoteId: remoteCkpt.remoteId,
        level: remoteCkpt.level,
        summary: remoteCkpt.summary,
        createdAt: remoteCkpt.createdAt,
        syncedAt: checkpointServerTime,
      });
      checkpointsInserted++;
    }
    checkpointsPullAt[remoteTaskId] = checkpointServerTime;
  }
  writeSyncConfig({ ...config, lastTasksPullAt: serverTime, checkpointsPullAt });
  if (checkpointsInserted > 0) {
    console.log(`Pulled ${checkpointsInserted} new checkpoint(s).`);
  }
}
