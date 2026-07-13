import type { TaskStore, TaskStatus } from '@ariadne-dev/core';
import { readSyncConfig, writeSyncConfig, requireSyncConfig, setCurrentSyncProfile, listSyncProfiles, DEFAULT_SYNC_PROFILE } from './syncConfig.js';
import * as syncClient from './syncClient.js';
import { getWorkspaceLabel } from './workspaceLabel.js';

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
  const config = requireSyncConfig(profileName);
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

  // Decisions, errors, open questions, commands — create-once sync,
  // mirroring checkpoints above: an edit/resolve made after the initial
  // push is not automatically re-detected/re-pushed in this phase (see
  // docs/07-CLOUD-SYNC-API-CONTRACT.md §4.6).
  let decisionsPushed = 0;
  for (const id of taskIdsToCheck) {
    const task = store.getTask(id);
    const remoteTaskId = task?.remoteId ?? undefined;
    if (!remoteTaskId) continue;
    const pending = store.listDecisionsNeedingPush(id);
    if (pending.length === 0) continue;
    const { results } = await syncClient.pushDecisions(
      config.serverUrl,
      config.token,
      pending.map((d) => ({ localId: d.id, remoteTaskId, text: d.text, rationale: d.rationale, workspaceLabel, createdAt: d.createdAt })),
    );
    const now = new Date().toISOString();
    for (const r of results) store.setDecisionRemoteSync(r.localId, r.remoteId, now);
    decisionsPushed += results.length;
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
        remoteTaskId,
        message: e.message,
        resolved: e.resolved,
        resolution: e.resolution,
        workspaceLabel,
        createdAt: e.createdAt,
      })),
    );
    const now = new Date().toISOString();
    for (const r of results) store.setErrorRemoteSync(r.localId, r.remoteId, now);
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
      pending.map((q) => ({ localId: q.id, remoteTaskId, text: q.text, resolved: q.resolved, workspaceLabel, createdAt: q.createdAt })),
    );
    const now = new Date().toISOString();
    for (const r of results) store.setOpenQuestionRemoteSync(r.localId, r.remoteId, now);
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
        remoteTaskId,
        cmdRedacted: c.cmdRedacted,
        exitCode: c.exitCode,
        summary: c.summary,
        workspaceLabel,
        createdAt: c.createdAt,
      })),
    );
    const now = new Date().toISOString();
    for (const r of results) store.setCommandRemoteSync(r.localId, r.remoteId, now);
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
  const config = requireSyncConfig(options.profileName);
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

  // Decisions, errors, open questions, commands — create-once sync
  // (insert-only if not already known locally; never re-applies changes
  // to an existing row, mirroring checkpoints above).
  const decisionsPullAt = { ...(config.decisionsPullAt ?? {}) };
  let decisionsInserted = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = decisionsPullAt[remoteTaskId];
    const { decisions, serverTime: decisionServerTime } = await syncClient.pullDecisions(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteDecision of decisions) {
      if (store.getDecisionByRemoteId(remoteDecision.remoteId)) continue;
      store.insertPulledDecision({
        taskId: task.id,
        remoteId: remoteDecision.remoteId,
        text: remoteDecision.text,
        rationale: remoteDecision.rationale,
        createdAt: remoteDecision.createdAt,
        syncedAt: decisionServerTime,
      });
      decisionsInserted++;
    }
    decisionsPullAt[remoteTaskId] = decisionServerTime;
  }
  if (decisionsInserted > 0) console.log(`Pulled ${decisionsInserted} new decision(s).`);

  const errorsPullAt = { ...(config.errorsPullAt ?? {}) };
  let errorsInserted = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = errorsPullAt[remoteTaskId];
    const { errors, serverTime: errorServerTime } = await syncClient.pullErrors(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteError of errors) {
      if (store.getErrorByRemoteId(remoteError.remoteId)) continue;
      store.insertPulledError({
        taskId: task.id,
        remoteId: remoteError.remoteId,
        message: remoteError.message,
        resolved: remoteError.resolved,
        resolution: remoteError.resolution,
        createdAt: remoteError.createdAt,
        syncedAt: errorServerTime,
      });
      errorsInserted++;
    }
    errorsPullAt[remoteTaskId] = errorServerTime;
  }
  if (errorsInserted > 0) console.log(`Pulled ${errorsInserted} new error(s).`);

  const openQuestionsPullAt = { ...(config.openQuestionsPullAt ?? {}) };
  let openQuestionsInserted = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = openQuestionsPullAt[remoteTaskId];
    const { openQuestions, serverTime: questionServerTime } = await syncClient.pullOpenQuestions(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteQuestion of openQuestions) {
      if (store.getOpenQuestionByRemoteId(remoteQuestion.remoteId)) continue;
      store.insertPulledOpenQuestion({
        taskId: task.id,
        remoteId: remoteQuestion.remoteId,
        text: remoteQuestion.text,
        resolved: remoteQuestion.resolved,
        createdAt: remoteQuestion.createdAt,
        syncedAt: questionServerTime,
      });
      openQuestionsInserted++;
    }
    openQuestionsPullAt[remoteTaskId] = questionServerTime;
  }
  if (openQuestionsInserted > 0) console.log(`Pulled ${openQuestionsInserted} new open question(s).`);

  const commandsPullAt = { ...(config.commandsPullAt ?? {}) };
  let commandsInserted = 0;
  for (const task of linkedTasks) {
    const remoteTaskId = task.remoteId!;
    const since = commandsPullAt[remoteTaskId];
    const { commands, serverTime: commandServerTime } = await syncClient.pullCommands(config.serverUrl, config.token, remoteTaskId, since);
    for (const remoteCommand of commands) {
      if (store.getCommandByRemoteId(remoteCommand.remoteId)) continue;
      store.insertPulledCommand({
        taskId: task.id,
        remoteId: remoteCommand.remoteId,
        cmdRedacted: remoteCommand.cmdRedacted,
        exitCode: remoteCommand.exitCode,
        summary: remoteCommand.summary,
        createdAt: remoteCommand.createdAt,
        syncedAt: commandServerTime,
      });
      commandsInserted++;
    }
    commandsPullAt[remoteTaskId] = commandServerTime;
  }
  if (commandsInserted > 0) console.log(`Pulled ${commandsInserted} new command(s).`);

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
  const config = requireSyncConfig(profileName);
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
