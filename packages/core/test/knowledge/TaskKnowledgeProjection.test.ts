import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TaskStore } from '../../src/TaskStore.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  createOrResumeTaskFromKnowledgeInsight,
  projectTaskKnowledge,
} from '../../src/knowledge/TaskKnowledgeProjection.js';
import { SCHEMA_SQL } from '../../src/schema.js';

const PROJECT_ID = 'project-1';
const CREATED_AT = '2026-09-24T00:00:00.000Z';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES (?, '/workspace', 'Workspace', ?, ?)`,
  ).run(PROJECT_ID, CREATED_AT, CREATED_AT);
  return db;
}

function taskSnapshot(store: TaskStore, taskId: string): unknown {
  return {
    task: store.getTask(taskId),
    checkpoints: store.listCheckpoints(taskId),
    decisions: store.listDecisions(taskId),
    files: store.listFiles(taskId),
    commits: store.listCommits(taskId),
  };
}

describe('TaskKnowledgeProjection', () => {
  const databases: Database.Database[] = [];
  const stores: TaskStore[] = [];

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const db of databases.splice(0)) db.close();
  });

  it('projects task history into source and provenance records idempotently without mutating the task', () => {
    const db = createDatabase();
    const store = new TaskStore(':memory:');
    databases.push(db);
    stores.push(store);
    const task = store.createTask({ title: 'Implement cache', goal: 'Speed up search' });
    const checkpoint = store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Wired cache' });
    const decision = store.recordDecision({ taskId: task.id, text: 'Use SQLite cache', rationale: 'Local and deterministic' });
    store.touchFile({ taskId: task.id, path: 'src/cache.ts', role: 'created' });
    const commit = store.recordCommit({ taskId: task.id, sha: 'abc123', message: 'Add cache' });
    const before = taskSnapshot(store, task.id);

    const first = projectTaskKnowledge(db, store, {
      projectId: PROJECT_ID,
      taskId: task.id,
      trigger: 'explicit',
      createdAt: CREATED_AT,
    });
    const second = projectTaskKnowledge(db, store, {
      projectId: PROJECT_ID,
      taskId: task.id,
      trigger: 'explicit',
      createdAt: CREATED_AT,
    });

    expect(second).toEqual(first);
    expect(taskSnapshot(store, task.id)).toEqual(before);
    expect(first.provenance).toEqual(
      expect.arrayContaining([
        { kind: 'task', id: task.id, confidence: 1 },
        { kind: 'checkpoint', id: checkpoint.id, confidence: 1 },
        { kind: 'decision', id: decision.id, confidence: 1 },
        { kind: 'file', id: 'src/cache.ts', confidence: 1 },
        { kind: 'commit', id: commit.sha, confidence: 1 },
      ]),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_versions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_provenance').get()).toEqual({
      count: first.provenance.length,
    });
  });

  it('creates a new projection version only when task history changes through an explicit trigger', () => {
    const db = createDatabase();
    const store = new TaskStore(':memory:');
    databases.push(db);
    stores.push(store);
    const task = store.createTask({ title: 'Investigate queue' });

    const first = projectTaskKnowledge(db, store, { projectId: PROJECT_ID, taskId: task.id, trigger: 'checkpoint' });
    store.createCheckpoint({ taskId: task.id, level: 'micro', summary: 'Found retry issue' });
    const second = projectTaskKnowledge(db, store, { projectId: PROJECT_ID, taskId: task.id, trigger: 'checkpoint' });

    expect(second.sourceId).toBe(first.sourceId);
    expect(second.sourceVersionId).not.toBe(first.sourceVersionId);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_versions').get()).toEqual({ count: 2 });
  });

  it('redacts task metadata persisted in projection records and rejects foreign workspace projects', () => {
    const db = createDatabase();
    const store = new TaskStore(':memory:');
    databases.push(db);
    stores.push(store);
    const secret = 'sk-abcdefghijklmnop1234567890';
    const task = store.createTask({
      title: `Investigate ${secret}`,
      goal: `Do not leak token=${secret}`,
    });

    projectTaskKnowledge(db, store, {
      projectId: PROJECT_ID,
      taskId: task.id,
      trigger: 'explicit',
      workspaceRoot: '/workspace',
    });

    const page = db.prepare('SELECT title FROM knowledge_pages').get() as { title: string };
    const version = db.prepare('SELECT summary FROM knowledge_page_versions').get() as { summary: string };
    expect(page.title).not.toContain(secret);
    expect(version.summary).not.toContain(secret);
    expect(() =>
      projectTaskKnowledge(db, store, {
        projectId: PROJECT_ID,
        taskId: task.id,
        trigger: 'explicit',
        workspaceRoot: '/other-workspace',
      }),
    ).toThrow(/does not belong to workspace/);
  });

  it('creates an Ariadne task from an insight and resumes that task on repeat calls', () => {
    const db = createDatabase();
    const store = new TaskStore(':memory:');
    databases.push(db);
    stores.push(store);
    db.prepare(
      `INSERT INTO knowledge_insights
       (id, project_id, graph_snapshot_id, insight_type, content_path, confidence, created_at)
       VALUES ('insight-1', ?, NULL, 'sparse', 'knowledge-insights.json#abc', 0.82, ?)`,
    ).run(PROJECT_ID, CREATED_AT);

    const created = createOrResumeTaskFromKnowledgeInsight(db, store, {
      projectId: PROJECT_ID,
      insightId: 'insight-1',
    });
    store.updateTaskStatus(created.task.id, 'paused');
    const resumed = createOrResumeTaskFromKnowledgeInsight(db, store, {
      projectId: PROJECT_ID,
      insightId: 'insight-1',
    });

    expect(created.action).toBe('created');
    expect(created.task.title).toBe('Investigate sparse knowledge insight');
    expect(created.task.goal).toContain('insight-1');
    expect(resumed.action).toBe('resumed');
    expect(resumed.task.id).toBe(created.task.id);
    expect(resumed.task.status).toBe('active');
    expect(store.listTasks().filter((task) => task.title === created.task.title)).toHaveLength(1);
  });
});
