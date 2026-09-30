import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { TaskStore } from '../../src/TaskStore.js';
import { openDatabase } from '../../src/db.js';
import {
  KnowledgeResearchService,
  ResearchConfirmationRequiredError,
  ResearchRequestCancelledError,
  ResearchProviderTimeoutError,
  ResearchRateLimitError,
} from '../../src/knowledge/KnowledgeResearch.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  createGenericResearchProvider,
  createSearXNGResearchProvider,
  createSerpApiResearchProvider,
  createTavilyResearchProvider,
} from '../../src/knowledge/research/ResearchProviders.js';

const PROJECT_ID = 'project_1';
const CREATED_AT = '2026-09-24T00:00:00.000Z';

function createKnowledgeDatabase(): Database.Database {
  const db = openDatabase(':memory:');
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects
     (id, workspace_root, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(PROJECT_ID, '/workspace', 'Test', CREATED_AT, CREATED_AT);
  return db;
}

describe('KnowledgeResearchService', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let sourceStore: KnowledgeSourceStore;
  let pageStore: KnowledgePageStore;
  let queue: KnowledgeQueue;

  beforeEach(() => {
    db = createKnowledgeDatabase();
    taskStore = new TaskStore(':memory:');
    sourceStore = new KnowledgeSourceStore(db);
    pageStore = new KnowledgePageStore(db);
    queue = new KnowledgeQueue(db);
  });

  afterEach(() => {
    taskStore.close();
    db.close();
  });

  it('requires confirmation before provider calls, then ingests cited sources and optionally creates a child task', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        url: 'https://example.com/oauth',
        title: 'OAuth 2.1',
        snippet: 'OAuth guidance',
      },
    ]);
    const parent = taskStore.createTask({ title: 'Research parent' });
    const service = new KnowledgeResearchService({
      provider: createGenericResearchProvider({ id: 'generic', search }),
      sourceStore,
      pageStore,
      queue,
      taskStore,
    });
    const request = service.createResearchRequest({
      projectId: PROJECT_ID,
      query: 'OAuth 2.1 guidance',
      parentTaskId: parent.id,
      createChildTask: true,
    });

    await expect(service.runResearchRequest(request.id)).rejects.toBeInstanceOf(ResearchConfirmationRequiredError);
    expect(search).not.toHaveBeenCalled();

    service.confirmResearchRequest(request.id);
    const result = await service.runResearchRequest(request.id);

    expect(result.sources).toHaveLength(1);
    expect(result.synthesisPage.title).toBe('Research: OAuth 2.1 guidance');
    expect(result.synthesisPage.sourceVersionIds).toHaveLength(1);
    expect(result.synthesisPage.content).toContain('[OAuth 2.1](https://example.com/oauth)');
    expect(queue.list(PROJECT_ID)).toMatchObject([{ jobKind: 'research-source' }]);
    expect(result.childTask).toMatchObject({ parentTaskId: parent.id, title: 'Research: OAuth 2.1 guidance' });
  });

  it('binds research ingestion to the reused current version after an A→B→A content revert', async () => {
    const snippets = ['snippet A', 'snippet B', 'snippet A'];
    const search = vi.fn().mockImplementation(async () => [
      { url: 'https://example.com/flip', title: 'Flip', snippet: snippets.shift() ?? 'snippet A' },
    ]);
    const service = new KnowledgeResearchService({
      provider: createGenericResearchProvider({ id: 'generic', search }),
      sourceStore,
      pageStore,
      queue,
    });
    const enqueue = vi.spyOn(queue, 'enqueue');
    let runNumber = 0;
    const run = async (projectId: string) => {
      const request = service.createResearchRequest({ projectId, query: `flip ${(runNumber += 1)}` });
      service.confirmResearchRequest(request.id);
      return service.runResearchRequest(request.id);
    };

    const first = await run(PROJECT_ID);
    const versionA = sourceStore.listVersions(PROJECT_ID, first.sources[0]!.id)[0]!;
    await run(PROJECT_ID);
    const third = await run(PROJECT_ID);

    const versions = sourceStore.listVersions(PROJECT_ID, third.sources[0]!.id);
    expect(versions).toHaveLength(2);
    expect(sourceStore.currentVersion(PROJECT_ID, third.sources[0]!.id)?.id).toBe(versionA.id);
    expect(third.synthesisPage.sourceVersionIds).toEqual([versionA.id]);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[2]![0].sourceVersionId).toBe(versionA.id);
  });

  it('binds research ingestion to the newest version and keeps projects isolated', async () => {
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_2', '/other', 'Other', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    const snippets = ['old', 'new'];
    const service = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'generic',
        search: async () => [{ url: 'https://example.com/n', title: 'N', snippet: snippets.shift() ?? 'new' }],
      }),
      sourceStore,
      pageStore,
      queue,
    });
    const run = async (projectId: string) => {
      const request = service.createResearchRequest({ projectId, query: 'n' });
      service.confirmResearchRequest(request.id);
      return service.runResearchRequest(request.id);
    };

    await run(PROJECT_ID);
    const newest = await run(PROJECT_ID);
    const versions = sourceStore.listVersions(PROJECT_ID, newest.sources[0]!.id);

    expect(newest.synthesisPage.sourceVersionIds).toEqual([versions[1]!.id]);
    expect(queue.list('project_2')).toEqual([]);
  });

  it('cancels confirmed requests and translates aborted provider work into a typed cancellation error', async () => {
    const service = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'generic',
        search: async (_query, signal) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      }),
      sourceStore,
      pageStore,
      queue,
    });
    const request = service.createResearchRequest({ projectId: PROJECT_ID, query: 'cancel me' });
    service.confirmResearchRequest(request.id);
    const pending = service.runResearchRequest(request.id);

    service.cancelResearchRequest(request.id);

    await expect(pending).rejects.toBeInstanceOf(ResearchRequestCancelledError);
  });

  it('enforces provider deadlines and preserves typed rate-limit failures', async () => {
    const slowService = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'slow',
        search: async () => new Promise(() => undefined),
      }),
      sourceStore,
      pageStore,
      queue,
      timeoutMs: 1,
    });
    const slowRequest = slowService.createResearchRequest({ projectId: PROJECT_ID, query: 'slow' });
    slowService.confirmResearchRequest(slowRequest.id);
    await expect(slowService.runResearchRequest(slowRequest.id)).rejects.toBeInstanceOf(ResearchProviderTimeoutError);

    const rateLimitedService = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'limited',
        search: async () => {
          throw new ResearchRateLimitError('limited', 30_000);
        },
      }),
      sourceStore,
      pageStore,
      queue,
    });
    const limitedRequest = rateLimitedService.createResearchRequest({ projectId: PROJECT_ID, query: 'limited' });
    rateLimitedService.confirmResearchRequest(limitedRequest.id);
    await expect(rateLimitedService.runResearchRequest(limitedRequest.id)).rejects.toMatchObject({
      providerId: 'limited',
      retryAfterMs: 30_000,
    });

    const httpLimitedService = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'http-limited',
        search: async () => {
          throw { status: 429, retryAfterMs: 15_000 };
        },
      }),
      sourceStore,
      pageStore,
      queue,
    });
    const httpLimitedRequest = httpLimitedService.createResearchRequest({ projectId: PROJECT_ID, query: 'http limited' });
    httpLimitedService.confirmResearchRequest(httpLimitedRequest.id);
    await expect(httpLimitedService.runResearchRequest(httpLimitedRequest.id)).rejects.toMatchObject({
      providerId: 'http-limited',
      retryAfterMs: 15_000,
    });
  });
});

describe('research provider adapters', () => {
  it('normalizes Tavily, SerpApi, SearXNG, and generic results and rejects unsafe URLs', async () => {
    const tavily = createTavilyResearchProvider({
      search: async () => ({ results: [{ url: 'https://example.com/t', title: 'T', content: 'T snippet' }] }),
    });
    const serpApi = createSerpApiResearchProvider({
      search: async () => ({ organic_results: [{ link: 'https://example.com/s', title: 'S', snippet: 'S snippet' }] }),
    });
    const searxng = createSearXNGResearchProvider({
      search: async () => ({ results: [{ url: 'https://example.com/x', title: 'X', content: 'X snippet' }] }),
    });
    const generic = createGenericResearchProvider({
      id: 'generic',
      search: async () => [
        { url: 'javascript:alert(1)', title: 'unsafe' },
        { url: 'http://127.0.0.1/admin', title: 'private' },
        { url: 'https://example.com/g', title: 'G' },
      ],
    });

    await expect(tavily.search('query', new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.com/t', title: 'T', snippet: 'T snippet' }),
    ]);
    await expect(serpApi.search('query', new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.com/s', title: 'S', snippet: 'S snippet' }),
    ]);
    await expect(searxng.search('query', new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.com/x', title: 'X', snippet: 'X snippet' }),
    ]);
    await expect(generic.search('query', new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.com/g', title: 'G' }),
    ]);
  });

  it('escapes provider-supplied Markdown before it is persisted in a synthesis page', async () => {
    const db = createKnowledgeDatabase();
    const sourceStore = new KnowledgeSourceStore(db);
    const pageStore = new KnowledgePageStore(db);
    const service = new KnowledgeResearchService({
      provider: createGenericResearchProvider({
        id: 'generic',
        search: async () => [{ url: 'https://example.com/unsafe', title: '<script>', snippet: '[link](javascript:alert(1))' }],
      }),
      sourceStore,
      pageStore,
      queue: new KnowledgeQueue(db),
    });
    const request = service.createResearchRequest({ projectId: PROJECT_ID, query: 'unsafe' });
    service.confirmResearchRequest(request.id);

    const result = await service.runResearchRequest(request.id);

    expect(result.synthesisPage.content).not.toContain('<script>');
    expect(result.synthesisPage.content).toContain('&lt;script&gt;');
    expect(result.synthesisPage.content).toContain('\\[link\\]');
    db.close();
  });
});
