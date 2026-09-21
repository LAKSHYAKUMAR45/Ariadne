import type { TaskStore, TaskStatus } from '@ariadne-dev/core';
import { readSyncConfig, writeSyncConfig, requireSyncConfig, setCurrentSyncProfile, listSyncProfiles, DEFAULT_SYNC_PROFILE } from './syncConfig.js';
import * as syncClient from './syncClient.js';
import { getWorkspaceLabel } from './workspaceLabel.js';
import {
  bootstrapSshAccess,
  ensureConfiguredSyncTunnel,
  ensureSshTunnel,
  promptHidden,
  readProjectSyncConnection,
} from './syncTunnel.js';

/**
 * Compares two flat field maps and returns every key whose value differs,
 * used to report *which* fields actually conflict between a local and
 * remote version of a row (rather than just "something changed"). Keys
 * present in one object but not the other are not expected here (both
 * sides are built from the same fixed field list at each call site).
 */
function diffFields(local: Record<string, unknown>, remote: Record<string, unknown>): { field: string; local: unknown; remote: unknown }[] {
  const diffs: { field: string; local: unknown; remote: unknown }[] = [];
  for (const key of Object.keys(local)) {
    if (local[key] !== remote[key]) {
      diffs.push({ field: key, local: local[key], remote: remote[key] });
    }
  }
  return diffs;
}

/** `ariadne sync register <username> <password>` — creates an account, then logs in immediately for convenience. */
export async function runSyncRegister(username: string, password: string, serverUrl: string, profileName?: string): Promise<void> {
  await syncClient.register(serverUrl, username, password);
  console.log(`Registered account "${username}" on ${serverUrl}.`);
  await runSyncLogin(username, password, serverUrl, profileName);
}

/**
 * `ariadne sync login <username> <password> [--profile <name>]` —
 * authenticates and persists the token to `~/.ariadne/sync-config.json`
 * under the given profile (default: `"default"`), making that profile
 * current. Multiple profiles let one machine stay logged into more than
 * one sync server/team at once (see `syncConfig.ts`).
 */
export async function runSyncLogin(username: string, password: string, serverUrl: string, profileName?: string): Promise<void> {
  const name = profileName ?? DEFAULT_SYNC_PROFILE;
  const { token } = await syncClient.login(serverUrl, username, password);
  const existing = readSyncConfig(name);
  writeSyncConfig({ ...existing, serverUrl, token, username }, name);
  setCurrentSyncProfile(name);
  console.log(`Logged in to ${serverUrl} as ${username} (profile "${name}").`);
}

/**
 * `ariadne sync setup [username] [--register]` — bootstraps key-based SSH
 * access and a local tunnel from the project connection file, then stores
 * an authenticated sync profile carrying enough tunnel metadata for future
 * push/pull commands to reconnect automatically.
 */
export async function runSyncSetup(
  workspaceRoot: string,
  username: string,
  options: { register?: boolean } = {},
): Promise<void> {
  const connection = readProjectSyncConnection(workspaceRoot);
  await bootstrapSshAccess(connection.tunnel);
  await ensureSshTunnel(connection.tunnel);
  const password = await promptHidden('Ariadne password: ');
  if (!password) throw new Error('Ariadne password cannot be empty.');

  if (options.register) {
    await syncClient.register(connection.serverUrl, username, password);
    console.log(`Registered account "${username}" through the ${connection.profile} tunnel.`);
  }
  const { token } = await syncClient.login(connection.serverUrl, username, password);
  const existing = readSyncConfig(connection.profile);
  writeSyncConfig(
    {
      ...existing,
      serverUrl: connection.serverUrl,
      token,
      username,
      tunnel: connection.tunnel,
    },
    connection.profile,
  );
  setCurrentSyncProfile(connection.profile);
  console.log(`Cloud sync ready through ${connection.tunnel.sshHost} (profile "${connection.profile}").`);
}

/** `ariadne sync logout [--profile <name>]` — forgets the locally-stored token for that profile (does not affect the account on the server). */
export function runSyncLogout(profileName?: string): void {
  const config = readSyncConfig(profileName);
  if (!config) {
    console.log('Already logged out.');
    return;
  }
  writeSyncConfig({ ...config, token: '' }, profileName);
  console.log('Logged out (local token cleared).');
}

/**
 * `ariadne sync profile list` — shows every configured sync profile
 * (server + username), flagging which one is current.
 */
export function runSyncProfileList(): void {
  const profiles = listSyncProfiles();
  if (profiles.length === 0) {
    console.log('No sync profiles configured yet. Run "ariadne sync login <username> <password> --server <url>" first.');
    return;
  }
  for (const { name, config, current } of profiles) {
    const marker = current ? '*' : ' ';
    console.log(`${marker} ${name}  ${config.serverUrl}  (${config.username})`);
  }
}

/** `ariadne sync profile use <name>` — switches which profile is current, without logging in again. */
export function runSyncProfileUse(name: string): void {
  setCurrentSyncProfile(name);
  console.log(`Current sync profile is now "${name}".`);
}

/**
 * `ariadne sync push [--task <id>]` — pushes every task (or just `taskId`,
 * if given) that's new or changed since its last sync, then pushes any
 * not-yet-synced checkpoints belonging to those tasks. Checkpoints are
 * pushed after their parent task, since the server requires the task to
 * already exist (`remoteTaskId` must resolve) before accepting checkpoints
 * for it.
 */
export async function runSyncPush(store: TaskStore, workspaceRoot: string, taskId?: string, profileName?: string): Promise<void> {
  const config = await ensureConfiguredSyncTunnel(requireSyncConfig(profileName));
  const workspaceLabel = getWorkspaceLabel(workspaceRoot);
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
        workspaceLabel,
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
        workspaceLabel,
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

  // Todos: the one sub-entity with bidirectional sync, so pending items
  // may already carry a remoteId (an edit made after the first push).
  let todosPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;

    const pending = store.listTodosNeedingPush(id);
    if (pending.length === 0) continue;

    const { results } = await syncClient.pushTodos(
      config.serverUrl,
      config.token,
      pending.map((t) => ({
        localId: t.id,
        remoteId: t.remoteId,
        remoteTaskId,
        text: t.text,
        status: t.status,
        workspaceLabel,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    );
    for (const r of results) {
      store.setTodoRemoteSync(r.localId, r.remoteId, r.updatedAt);
    }
    todosPushed += results.length;
  }
  if (todosPushed > 0) {
    console.log(`Pushed ${todosPushed} todo(s).`);
  }

  let decisionsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;
    const pending = store.listDecisionsNeedingPush(id);
    if (pending.length === 0) continue;
    for (const d of pending) {
      const { results } = await syncClient.pushDecisions(config.serverUrl, config.token, [
        {
          localId: d.id,
          remoteId: d.remoteId,
          remoteTaskId,
          text: d.text,
          rationale: d.rationale,
          supersedesId: d.supersedesId ? (store.getDecision(d.supersedesId)?.remoteId ?? null) : null,
          workspaceLabel,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        },
      ]);
      for (const r of results) store.setDecisionRemoteSync(r.localId, r.remoteId, r.updatedAt);
      decisionsPushed += results.length;
    }
  }
  if (decisionsPushed > 0) console.log(`Pushed ${decisionsPushed} decision(s).`);

  let errorsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;
    const pending = store.listErrorsNeedingPush(id);
    if (pending.length === 0) continue;
    const { results } = await syncClient.pushErrors(
      config.serverUrl,
      config.token,
      pending.map((e) => ({
        localId: e.id,
        remoteId: e.remoteId,
        remoteTaskId,
        message: e.message,
        resolved: e.resolved,
        resolution: e.resolution,
        workspaceLabel,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    );
    for (const r of results) store.setErrorRemoteSync(r.localId, r.remoteId, r.updatedAt);
    errorsPushed += results.length;
  }
  if (errorsPushed > 0) console.log(`Pushed ${errorsPushed} error(s).`);

  let openQuestionsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;
    const pending = store.listOpenQuestionsNeedingPush(id);
    if (pending.length === 0) continue;
    const { results } = await syncClient.pushOpenQuestions(
      config.serverUrl,
      config.token,
      pending.map((q) => ({
        localId: q.id,
        remoteId: q.remoteId,
        remoteTaskId,
        text: q.text,
        resolved: q.resolved,
        workspaceLabel,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      })),
    );
    for (const r of results) store.setOpenQuestionRemoteSync(r.localId, r.remoteId, r.updatedAt);
    openQuestionsPushed += results.length;
  }
  if (openQuestionsPushed > 0) console.log(`Pushed ${openQuestionsPushed} open question(s).`);

  let commandsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;
    const pending = store.listCommandsNeedingPush(id);
    if (pending.length === 0) continue;
    const { results } = await syncClient.pushCommands(
      config.serverUrl,
      config.token,
      pending.map((c) => ({
        localId: c.id,
        remoteId: c.remoteId,
        remoteTaskId,
        cmdRedacted: c.cmdRedacted,
        exitCode: c.exitCode,
        summary: c.summary,
        workspaceLabel,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    );
    for (const r of results) store.setCommandRemoteSync(r.localId, r.remoteId, r.updatedAt);
    commandsPushed += results.length;
  }
  if (commandsPushed > 0) console.log(`Pushed ${commandsPushed} command(s).`);

  if (
    tasksToPush.length === 0 &&
    checkpointsPushed === 0 &&
    todosPushed === 0 &&
    decisionsPushed === 0 &&
    errorsPushed === 0 &&
    openQuestionsPushed === 0 &&
    commandsPushed === 0 &&
    !taskId
  ) {
    console.log('Nothing to push — everything is already synced.');
  }
}

/**
 * `ariadne sync pull [--task <id>] [--import-new] [--on-conflict <remote-wins|local-wins>]`
 * — pulls tasks changed on the server since the last pull and applies them
 * to any local task already linked via `remoteId`. By default, tasks never
 * pushed from this workspace are skipped (pull only updates rows this
 * workspace already knows about); pass `--import-new` to also create a new
 * local task for every remote task this workspace has never linked,
 * however old (see `TaskStore.insertPulledTask`). That import pass
 * deliberately does NOT reuse the incremental `since` cursor below — that
 * cursor only guarantees "tasks changed since X", so a task skipped once
 * would otherwise never resurface for import unless it changed again
 * remotely. Instead it does a full browse via GET /tasks/all (the same
 * endpoint `sync list-remote` uses) and imports anything still unlinked.
 * Then pulls new checkpoints/todos/decisions/errors/open questions/commands
 * for every task this workspace has synced, including any just imported.
 *
 * **Conflict handling** (per docs/06-CLOUD-SYNC-DESIGN.md §4's "last-write-
 * wins with a visible warning" requirement): a conflict is a task (or,
 * for todos, an individual todo) that changed *both* locally (it has
 * unpushed changes — `updatedAt > syncedAt`) and remotely (it showed up in
 * this pull's changed set) since the last sync. Rather than silently
 * overwriting one side, every such conflict is printed with both versions'
 * differing fields. `--on-conflict remote-wins` (the default, unchanged
 * behavior) still applies the remote version; `--on-conflict local-wins`
 * instead keeps the local version untouched (so the next `sync push`
 * overwrites the server with it). Full per-field merging is out of scope —
 * this is still a whole-row pick, just an informed and explicit one
 * instead of a silent one.
 */
export async function runSyncPull(
  store: TaskStore,
  taskId?: string,
  options: { importNew?: boolean; profileName?: string; onConflict?: 'remote-wins' | 'local-wins' } = {},
): Promise<void> {
  const config = await ensureConfiguredSyncTunnel(requireSyncConfig(options.profileName));
  const onConflict = options.onConflict ?? 'remote-wins';

  // Page through GET /tasks (§4.5) rather than assuming the whole
  // incremental feed fits in one response — a team with many tasks or a
  // first-ever pull (no `since`) could otherwise return an unbounded
  // result. The final page's `serverTime` becomes the next `since` cursor,
  // same as a single-page pull would have used.
  const tasks: syncClient.RemoteTask[] = [];
  let serverTime = new Date().toISOString();
  let offset = 0;
  for (;;) {
    const page = await syncClient.pullTasks(config.serverUrl, config.token, { since: config.lastTasksPullAt, offset });
    tasks.push(...page.tasks);
    serverTime = page.serverTime;
    if (!page.hasMore || page.nextOffset === null) break;
    offset = page.nextOffset;
  }

  let updated = 0;
  let conflicts = 0;
  const unknownLabels = new Set<string>();
  for (const remoteTask of tasks) {
    const local = store.getTaskByRemoteId(remoteTask.remoteId);
    if (!local) {
      unknownLabels.add(remoteTask.workspaceLabel ?? 'unknown workspace');
      continue;
    }
    if (taskId && local.id !== taskId) continue;

    // A conflict is a local change made since the last sync (this task
    // would show up in listTasksNeedingPush) landing at the same time as
    // a remote change (it's in this pull's page). Report it with the
    // differing fields instead of silently picking a side.
    const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
    if (hasUnpushedLocalChange) {
      const diffs = diffFields(
        { title: local.title, goal: local.goal, status: local.status, branch: local.branch },
        { title: remoteTask.title, goal: remoteTask.goal, status: remoteTask.status, branch: remoteTask.branch },
      );
      if (diffs.length > 0) {
        conflicts++;
        console.log(
          `⚠ Conflict on task ${local.id} ("${local.title}") — changed both locally and remotely since last sync. Differing field(s): ${diffs
            .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
            .join(', ')}. Resolving via ${onConflict}.`,
        );
        if (onConflict === 'local-wins') {
          continue; // Keep the local version; next push will overwrite the server with it.
        }
      }
    }

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
  writeSyncConfig({ ...config, lastTasksPullAt: serverTime }, options.profileName);

  let imported = 0;
  if (options.importNew) {
    const allRemoteTasks = await listAllRemoteTasksPaged(config.serverUrl, config.token);
    const importedAt = new Date().toISOString();
    for (const remoteTask of allRemoteTasks) {
      if (store.getTaskByRemoteId(remoteTask.remoteId)) continue; // already linked (possibly just above, in this same run)
      store.insertPulledTask({
        remoteId: remoteTask.remoteId,
        title: remoteTask.title,
        goal: remoteTask.goal,
        status: remoteTask.status as TaskStatus,
        branch: remoteTask.branch,
        createdAt: remoteTask.createdAt,
        updatedAt: remoteTask.updatedAt,
        syncedAt: importedAt,
      });
      imported++;
    }
  }

  const importedNote = imported > 0 ? ` (${imported} new task(s) imported)` : '';
  const skippedNote =
    !options.importNew && unknownLabels.size > 0
      ? ` (tasks from other workspaces skipped: ${[...unknownLabels].join(', ')})`
      : '';
  const conflictNote = conflicts > 0 ? ` (${conflicts} conflict(s), resolved via ${onConflict})` : '';
  console.log(`Pulled ${updated} task update(s)${importedNote}${skippedNote}${conflictNote}.`);

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
  writeSyncConfig({ ...config, lastTasksPullAt: serverTime, checkpointsPullAt }, options.profileName);
  if (checkpointsInserted > 0) {
    console.log(`Pulled ${checkpointsInserted} new checkpoint(s).`);
  }

  // Todos: bidirectional — an already-linked local todo gets updated in
  // place (applyPulledTodo), one this workspace has never seen gets
  // created fresh (insertPulledTodo), same split as the tasks loop above.
  // Same conflict detection/reporting as tasks above: a todo edited
  // locally since its last sync *and* changed remotely is a conflict.
  const todosPullAt = { ...(config.todosPullAt ?? {}) };
  let todosInserted = 0;
  let todosUpdated = 0;
  let todoConflicts = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = todosPullAt[remoteTaskId];
    const { todos, serverTime: todoServerTime } = await syncClient.pullTodos(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteTodo of todos) {
      const local = store.getTodoByRemoteId(remoteTodo.remoteId);
      if (local) {
        const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
        if (hasUnpushedLocalChange) {
          const diffs = diffFields({ text: local.text, status: local.status }, { text: remoteTodo.text, status: remoteTodo.status });
          if (diffs.length > 0) {
            todoConflicts++;
            console.log(
              `⚠ Conflict on todo ${local.id} — changed both locally and remotely since last sync. Differing field(s): ${diffs
                .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
                .join(', ')}. Resolving via ${onConflict}.`,
            );
            if (onConflict === 'local-wins') continue; // Keep the local version; next push will overwrite the server with it.
          }
        }
        store.applyPulledTodo(local.id, {
          text: remoteTodo.text,
          status: remoteTodo.status,
          updatedAt: remoteTodo.updatedAt,
          syncedAt: todoServerTime,
        });
        todosUpdated++;
      } else {
        store.insertPulledTodo({
          taskId: task.id,
          remoteId: remoteTodo.remoteId,
          text: remoteTodo.text,
          status: remoteTodo.status,
          createdAt: remoteTodo.createdAt,
          updatedAt: remoteTodo.updatedAt,
          syncedAt: todoServerTime,
        });
        todosInserted++;
      }
    }
    todosPullAt[remoteTaskId] = todoServerTime;
  }
  writeSyncConfig({ ...config, lastTasksPullAt: serverTime, checkpointsPullAt, todosPullAt }, options.profileName);
  if (todosInserted > 0 || todosUpdated > 0) {
    const todoConflictNote = todoConflicts > 0 ? ` (${todoConflicts} conflict(s), resolved via ${onConflict})` : '';
    console.log(`Pulled ${todosInserted} new todo(s), updated ${todosUpdated} existing todo(s)${todoConflictNote}.`);
  }

  const decisionsPullAt = { ...(config.decisionsPullAt ?? {}) };
  let decisionsInserted = 0;
  let decisionsUpdated = 0;
  let decisionConflicts = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = decisionsPullAt[remoteTaskId];
    const { decisions, serverTime: decisionServerTime } = await syncClient.pullDecisions(config.serverUrl, config.token, remoteTaskId, since);
    const newlyInsertedDecisionRemoteIds = new Set<string>();
    for (const remoteDecision of decisions) {
      const existing = store.getDecisionByRemoteId(remoteDecision.remoteId);
      if (existing) continue;
      store.insertPulledDecision({
        taskId: task.id,
        remoteId: remoteDecision.remoteId,
        text: remoteDecision.text,
        rationale: remoteDecision.rationale,
        supersedesId: null,
        createdAt: remoteDecision.createdAt,
        updatedAt: remoteDecision.updatedAt,
        syncedAt: decisionServerTime,
      });
      newlyInsertedDecisionRemoteIds.add(remoteDecision.remoteId);
      decisionsInserted++;
    }
    for (const remoteDecision of decisions) {
      const local = store.getDecisionByRemoteId(remoteDecision.remoteId);
      if (!local) continue;
      const mappedSupersedesId = remoteDecision.supersedesId
        ? (store.getDecisionByRemoteId(remoteDecision.supersedesId)?.id ?? null)
        : null;
      if (!newlyInsertedDecisionRemoteIds.has(remoteDecision.remoteId)) {
        const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
        if (hasUnpushedLocalChange) {
          const diffs = diffFields(
            { text: local.text, rationale: local.rationale, supersedesId: local.supersedesId },
            { text: remoteDecision.text, rationale: remoteDecision.rationale, supersedesId: mappedSupersedesId },
          );
          if (diffs.length > 0) {
            decisionConflicts++;
            console.log(
              `⚠ Conflict on decision ${local.id} — changed both locally and remotely since last sync. Differing field(s): ${diffs
                .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
                .join(', ')}. Resolving via ${onConflict}.`,
            );
            if (onConflict === 'local-wins') continue;
          }
        }
        decisionsUpdated++;
      }
      store.applyPulledDecision(local.id, {
        text: remoteDecision.text,
        rationale: remoteDecision.rationale,
        supersedesId: mappedSupersedesId,
        updatedAt: remoteDecision.updatedAt,
        syncedAt: decisionServerTime,
      });
    }
    decisionsPullAt[remoteTaskId] = decisionServerTime;
  }
  if (decisionsInserted > 0 || decisionsUpdated > 0) {
    const decisionConflictNote = decisionConflicts > 0 ? ` (${decisionConflicts} conflict(s), resolved via ${onConflict})` : '';
    console.log(`Pulled ${decisionsInserted} new decision(s), updated ${decisionsUpdated} existing decision(s)${decisionConflictNote}.`);
  }

  const errorsPullAt = { ...(config.errorsPullAt ?? {}) };
  let errorsInserted = 0;
  let errorsUpdated = 0;
  let errorConflicts = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = errorsPullAt[remoteTaskId];
    const { errors, serverTime: errorServerTime } = await syncClient.pullErrors(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteError of errors) {
      const local = store.getErrorByRemoteId(remoteError.remoteId);
      if (local) {
        const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
        if (hasUnpushedLocalChange) {
          const diffs = diffFields(
            { message: local.message, resolved: local.resolved, resolution: local.resolution },
            { message: remoteError.message, resolved: remoteError.resolved, resolution: remoteError.resolution },
          );
          if (diffs.length > 0) {
            errorConflicts++;
            console.log(
              `⚠ Conflict on error ${local.id} — changed both locally and remotely since last sync. Differing field(s): ${diffs
                .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
                .join(', ')}. Resolving via ${onConflict}.`,
            );
            if (onConflict === 'local-wins') continue;
          }
        }
        store.applyPulledError(local.id, {
          message: remoteError.message,
          resolved: remoteError.resolved,
          resolution: remoteError.resolution,
          updatedAt: remoteError.updatedAt,
          syncedAt: errorServerTime,
        });
        errorsUpdated++;
      } else {
        store.insertPulledError({
          taskId: task.id,
          remoteId: remoteError.remoteId,
          message: remoteError.message,
          resolved: remoteError.resolved,
          resolution: remoteError.resolution,
          createdAt: remoteError.createdAt,
          updatedAt: remoteError.updatedAt,
          syncedAt: errorServerTime,
        });
        errorsInserted++;
      }
    }
    errorsPullAt[remoteTaskId] = errorServerTime;
  }
  if (errorsInserted > 0 || errorsUpdated > 0) {
    const errorConflictNote = errorConflicts > 0 ? ` (${errorConflicts} conflict(s), resolved via ${onConflict})` : '';
    console.log(`Pulled ${errorsInserted} new error(s), updated ${errorsUpdated} existing error(s)${errorConflictNote}.`);
  }

  const openQuestionsPullAt = { ...(config.openQuestionsPullAt ?? {}) };
  let openQuestionsInserted = 0;
  let openQuestionsUpdated = 0;
  let openQuestionConflicts = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = openQuestionsPullAt[remoteTaskId];
    const { openQuestions, serverTime: questionServerTime } = await syncClient.pullOpenQuestions(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteQuestion of openQuestions) {
      const local = store.getOpenQuestionByRemoteId(remoteQuestion.remoteId);
      if (local) {
        const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
        if (hasUnpushedLocalChange) {
          const diffs = diffFields(
            { text: local.text, resolved: local.resolved },
            { text: remoteQuestion.text, resolved: remoteQuestion.resolved },
          );
          if (diffs.length > 0) {
            openQuestionConflicts++;
            console.log(
              `⚠ Conflict on open question ${local.id} — changed both locally and remotely since last sync. Differing field(s): ${diffs
                .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
                .join(', ')}. Resolving via ${onConflict}.`,
            );
            if (onConflict === 'local-wins') continue;
          }
        }
        store.applyPulledOpenQuestion(local.id, {
          text: remoteQuestion.text,
          resolved: remoteQuestion.resolved,
          updatedAt: remoteQuestion.updatedAt,
          syncedAt: questionServerTime,
        });
        openQuestionsUpdated++;
      } else {
        store.insertPulledOpenQuestion({
          taskId: task.id,
          remoteId: remoteQuestion.remoteId,
          text: remoteQuestion.text,
          resolved: remoteQuestion.resolved,
          createdAt: remoteQuestion.createdAt,
          updatedAt: remoteQuestion.updatedAt,
          syncedAt: questionServerTime,
        });
        openQuestionsInserted++;
      }
    }
    openQuestionsPullAt[remoteTaskId] = questionServerTime;
  }
  if (openQuestionsInserted > 0 || openQuestionsUpdated > 0) {
    const openQuestionConflictNote =
      openQuestionConflicts > 0 ? ` (${openQuestionConflicts} conflict(s), resolved via ${onConflict})` : '';
    console.log(
      `Pulled ${openQuestionsInserted} new open question(s), updated ${openQuestionsUpdated} existing open question(s)${openQuestionConflictNote}.`,
    );
  }

  const commandsPullAt = { ...(config.commandsPullAt ?? {}) };
  let commandsInserted = 0;
  let commandsUpdated = 0;
  let commandConflicts = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = commandsPullAt[remoteTaskId];
    const { commands, serverTime: commandServerTime } = await syncClient.pullCommands(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteCommand of commands) {
      const local = store.getCommandByRemoteId(remoteCommand.remoteId);
      if (local) {
        const hasUnpushedLocalChange = !local.syncedAt || local.updatedAt > local.syncedAt;
        if (hasUnpushedLocalChange) {
          const diffs = diffFields(
            { cmdRedacted: local.cmdRedacted, exitCode: local.exitCode, summary: local.summary },
            { cmdRedacted: remoteCommand.cmdRedacted, exitCode: remoteCommand.exitCode, summary: remoteCommand.summary },
          );
          if (diffs.length > 0) {
            commandConflicts++;
            console.log(
              `⚠ Conflict on command ${local.id} — changed both locally and remotely since last sync. Differing field(s): ${diffs
                .map((d) => `${d.field} (local: ${JSON.stringify(d.local)}, remote: ${JSON.stringify(d.remote)})`)
                .join(', ')}. Resolving via ${onConflict}.`,
            );
            if (onConflict === 'local-wins') continue;
          }
        }
        store.applyPulledCommand(local.id, {
          cmdRedacted: remoteCommand.cmdRedacted,
          exitCode: remoteCommand.exitCode,
          summary: remoteCommand.summary,
          updatedAt: remoteCommand.updatedAt,
          syncedAt: commandServerTime,
        });
        commandsUpdated++;
      } else {
        store.insertPulledCommand({
          taskId: task.id,
          remoteId: remoteCommand.remoteId,
          cmdRedacted: remoteCommand.cmdRedacted,
          exitCode: remoteCommand.exitCode,
          summary: remoteCommand.summary,
          createdAt: remoteCommand.createdAt,
          updatedAt: remoteCommand.updatedAt,
          syncedAt: commandServerTime,
        });
        commandsInserted++;
      }
    }
    commandsPullAt[remoteTaskId] = commandServerTime;
  }
  if (commandsInserted > 0 || commandsUpdated > 0) {
    const commandConflictNote = commandConflicts > 0 ? ` (${commandConflicts} conflict(s), resolved via ${onConflict})` : '';
    console.log(`Pulled ${commandsInserted} new command(s), updated ${commandsUpdated} existing command(s)${commandConflictNote}.`);
  }

  writeSyncConfig(
    { ...config, lastTasksPullAt: serverTime, checkpointsPullAt, todosPullAt, decisionsPullAt, errorsPullAt, openQuestionsPullAt, commandsPullAt },
    options.profileName,
  );
}

/**
 * Pages through `GET /tasks/all` (§4.5) until exhausted, returning the full
 * combined list. Shared by `--import-new` and `sync list-remote` so
 * neither assumes the server's whole task set fits in one response.
 */
async function listAllRemoteTasksPaged(serverUrl: string, token: string): Promise<syncClient.RemoteTaskWithOwner[]> {
  const all: syncClient.RemoteTaskWithOwner[] = [];
  let offset = 0;
  for (;;) {
    const page = await syncClient.listAllRemoteTasks(serverUrl, token, { offset });
    all.push(...page.tasks);
    if (!page.hasMore || page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return all;
}

/**
 * `ariadne sync list-remote` — browse-only listing of every task on the
 * server (including ones this workspace has never linked/pulled), showing
 * who pushed it and from which workspace/repo. Complements `sync pull`
 * (which only updates already-linked tasks): this is how you answer "what
 * has my team pushed?" without importing anything locally. Pages through
 * the server's `limit`/`offset`-paginated response internally (§4.5), so
 * this always shows everything regardless of team size.
 */
export async function runSyncListRemote(profileName?: string): Promise<void> {
  const config = await ensureConfiguredSyncTunnel(requireSyncConfig(profileName));
  const tasks = await listAllRemoteTasksPaged(config.serverUrl, config.token);
  if (tasks.length === 0) {
    console.log('No tasks on the server yet.');
    return;
  }
  for (const t of tasks) {
    const workspace = t.workspaceLabel ?? 'unknown workspace';
    console.log(`[${t.status}] ${t.remoteId}  ${t.title}  (owner: ${t.owner}, workspace: ${workspace})`);
  }
  console.log(`${tasks.length} task(s) total on the server.`);
}

/**
 * `ariadne sync unlink <taskId>` — clears a local task's link to the sync
 * server (`remote_id`/`synced_at`) without contacting the server or
 * touching the task's content. The server-side row (if any) is left
 * exactly as-is — this is a local-only operation, not a delete. Useful
 * when a task got linked in error (e.g. `--import-new` pulled in something
 * unwanted, or a task was accidentally pushed) and you want a clean local
 * copy that no longer participates in sync. A later `sync push` will treat
 * the task as brand-new and create a fresh remote row for it.
 */
export function runSyncUnlink(store: TaskStore, taskId: string): void {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`No task with id ${taskId}.`);
  }
  if (!task.remoteId) {
    console.log(`Task ${taskId} is not linked to a sync server; nothing to do.`);
    return;
  }
  store.unlinkTaskFromRemote(taskId);
  console.log(`Unlinked task ${taskId} from the sync server (was remote id ${task.remoteId}). The server-side task is unaffected.`);
}
