import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KnowledgeQueue, openDatabase, TaskStore } from '@ariadne-dev/core';
import { createAriadneMcpServer } from '../src/server.js';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function setup() {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.knowledge-mcp-test-'));
  const db = openDatabase(path.join(root, 'state.db'));
  const store = new TaskStore(':memory:');
  const server = createAriadneMcpServer({ workspaceRoot: root, store, knowledgeDb: db });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown) => Promise<ToolResult> }> })._registeredTools;
  return { root, db, store, tools };
}

function cleanup(state: ReturnType<typeof setup>): void {
  state.store.close();
  state.db.close();
  fs.rmSync(state.root, { recursive: true, force: true });
}

describe('knowledge MCP tools', () => {
  it('reports bounded project-scoped worker status without mutating the queue or exposing watch mode', async () => {
    const state = setup();
    try {
      const projectId = JSON.parse(
        (await state.tools.knowledge_project_create.handler({ name: 'Wiki', confirm: true })).content[0].text,
      ).data.id as string;
      const queue = new KnowledgeQueue(state.db, { now: () => '2026-09-28T12:00:00.000Z' });
      queue.enqueue({ projectId, jobKind: 'unsupported', payload: {} });
      const changesBeforeStatus = state.db.prepare('SELECT total_changes() AS total').get() as { total: number };

      const status = await state.tools.knowledge_worker_status.handler({ projectId });

      expect(status.isError).toBeUndefined();
      expect(JSON.parse(status.content[0].text)).toEqual({
        data: {
          queued: 1,
          running: 0,
          failed: 0,
          oldestQueuedAt: '2026-09-28T12:00:00.000Z',
          activeWorkerCount: 0,
          deterministicCompleted: 0,
          enrichedCompleted: 0,
          coverage: {
            supported: 0,
            partial: 0,
            unsupported: 0,
            failed: 0,
            legacyUnknown: 0,
            deferredRelationships: 0,
          },
          graph: { nodeCount: 0, edgeCount: 0 },
          synthesis: { summaryCount: 0, deterministic: 0, providerRefined: 0, fallbackWarning: 0 },
          analytics: { enabled: false },
        },
        citations: [{ kind: 'project', id: projectId }],
      });
      expect(state.db.prepare('SELECT total_changes() AS total').get()).toEqual(changesBeforeStatus);
      expect(state.tools.knowledge_worker_watch).toBeUndefined();
    } finally {
      cleanup(state);
    }
  });

  it('requires confirmation and runs knowledge work only for the requested project', async () => {
    const state = setup();
    try {
      const projectA = JSON.parse(
        (await state.tools.knowledge_project_create.handler({ name: 'Project A', confirm: true })).content[0].text,
      ).data.id as string;
      const projectB = 'project-b';
      const createdAt = new Date().toISOString();
      state.db.prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectB, '/workspace-b', 'Project B', createdAt, createdAt);
      const queue = new KnowledgeQueue(state.db);
      const jobA = queue.enqueue({ projectId: projectA, jobKind: 'unsupported', payload: {} });
      const jobB = queue.enqueue({ projectId: projectB, jobKind: 'unsupported', payload: {} });

      const rejected = await state.tools.knowledge_worker_run_once.handler({ projectId: projectA });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/confirm=true/);
      expect(queue.get(jobA.id)?.status).toBe('queued');

      const completed = await state.tools.knowledge_worker_run_once.handler({ projectId: projectA, confirm: true });
      expect(completed.isError).toBeUndefined();
      expect(JSON.parse(completed.content[0].text).data).toEqual(expect.objectContaining({
        projectId: projectA,
        claimed: 1,
        failed: 1,
      }));
      expect(queue.get(jobA.id)?.status).toBe('failed');
      expect(queue.get(jobB.id)?.status).toBe('queued');
    } finally {
      cleanup(state);
    }
  });

  it('redacts secrets from worker tool errors', async () => {
    const state = setup();
    try {
      const secretProjectId = 'sk-proj-abcdefghijklmnopqrstuvwxyz';
      const result = await state.tools.knowledge_worker_status.handler({ projectId: secretProjectId });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain(secretProjectId);
      expect(result.content[0].text).toMatch(/\*{3}|\[REDACTED\]/);
    } finally {
      cleanup(state);
    }
  });

  it('rejects worker operations for projects bound to another workspace', async () => {
    const state = setup();
    try {
      const projectId = 'project-foreign-workspace';
      const createdAt = new Date().toISOString();
      state.db.prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, path.join(state.root, 'other-workspace'), 'Foreign project', createdAt, createdAt);

      const status = await state.tools.knowledge_worker_status.handler({ projectId });
      const run = await state.tools.knowledge_worker_run_once.handler({ projectId, confirm: true });

      expect(status.isError).toBe(true);
      expect(status.content[0].text).toMatch(/workspace/i);
      expect(run.isError).toBe(true);
      expect(run.content[0].text).toMatch(/workspace/i);
    } finally {
      cleanup(state);
    }
  });

  it('requires explicit authorization for mutations and returns typed citations', async () => {
    const state = setup();
    try {
      const rejected = await state.tools.knowledge_project_create.handler({ name: 'Wiki' });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/confirm=true/);

      const created = await state.tools.knowledge_project_create.handler({ name: 'Wiki', confirm: true });
      expect(created.isError).toBeUndefined();
      const payload = JSON.parse(created.content[0].text) as { data: { id: string }; citations: Array<{ kind: string; id: string }> };
      expect(payload.data.name).toBe('Wiki');
      expect(payload.citations).toEqual([{ kind: 'project', id: payload.data.id }]);
    } finally {
      cleanup(state);
    }
  });

  it('round-trips a page and returns citations from search', async () => {
    const state = setup();
    try {
      const projectResult = await state.tools.knowledge_project_create.handler({ name: 'Wiki', confirm: true });
      const projectId = JSON.parse(projectResult.content[0].text).data.id as string;
      const pageResult = await state.tools.knowledge_page_create.handler({
        projectId,
        type: 'concept',
        title: 'SQLite',
        slug: 'sqlite',
        content: 'SQLite is the authoritative local store.',
        confirm: true,
      });
      expect(pageResult.isError).toBeUndefined();

      const source = await state.tools.knowledge_source_register.handler({
        projectId,
        kind: 'file',
        path: 'docs/sqlite.md',
        contentHash: 'sha256:sqlite',
        contentPath: 'sources/sqlite.md',
        confirm: true,
      });
      expect(source.isError).toBeUndefined();
      const searchResult = await state.tools.knowledge_search.handler({
        projectId,
        query: 'sqlite',
        mode: 'sources',
        limit: 1,
      });
      const search = JSON.parse(searchResult.content[0].text) as {
        data: { results: Array<{ title: string; searchConfidence?: string; citations: Array<{ path: string | null }> }> };
      };
      expect(search.data.results[0].title).toContain('sqlite');
      expect(search.data.results[0].searchConfidence).toBe('clear');
      expect(search.data.results[0].citations[0]?.path).toBe('docs/sqlite.md');

      const pageId = JSON.parse(pageResult.content[0].text).data.pageId as string;
      const page = await state.tools.knowledge_page_get.handler({ projectId, pageId });
      expect(JSON.parse(page.content[0].text).data.title).toBe('SQLite');
    } finally {
      cleanup(state);
    }
  });

  it('bounds list results and rejects missing project identifiers', async () => {
    const state = setup();
    try {
      const missing = await state.tools.knowledge_page_list.handler({ projectId: 'missing' });
      expect(missing.isError).toBe(true);
      expect(missing.content[0].text).toMatch(/project not found/i);

      const invalidLimit = await state.tools.knowledge_project_list.handler({});
      expect(invalidLimit.isError).toBeUndefined();
      const bounded = await state.tools.knowledge_source_list.handler({ projectId: 'missing', limit: 101 });
      expect(bounded.isError).toBe(true);
    } finally {
      cleanup(state);
    }
  });

  it('does not let one project cancel another project’s queued job', async () => {
    const state = setup();
    try {
      const projectA = JSON.parse((await state.tools.knowledge_project_create.handler({ name: 'Project A', confirm: true })).content[0].text).data.id as string;
      const projectB = 'project-b';
      const createdAt = new Date().toISOString();
      state.db.prepare(
        `INSERT INTO knowledge_projects
         (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectB, '/workspace-b', 'Project B', createdAt, createdAt);

      const enqueued = await state.tools.knowledge_queue_enqueue.handler({
        projectId: projectA,
        jobKind: 'extract',
        payload: { path: 'a.md' },
        confirm: true,
      });
      const jobId = JSON.parse(enqueued.content[0].text).data.id as string;

      const rejected = await state.tools.knowledge_queue_cancel.handler({
        projectId: projectB,
        jobId,
        confirm: true,
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/not found for project/i);

      const listed = await state.tools.knowledge_queue_list.handler({ projectId: projectA });
      const jobs = JSON.parse(listed.content[0].text).data as Array<{ id: string; status: string }>;
      expect(jobs).toEqual([expect.objectContaining({ id: jobId, status: 'queued' })]);
    } finally {
      cleanup(state);
    }
  });
});
