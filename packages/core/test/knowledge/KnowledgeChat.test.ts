import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import {
  KnowledgeChatService,
  type KnowledgeChatEvent,
  type KnowledgeChatProvider,
} from '../../src/knowledge/KnowledgeChat.js';
import { KnowledgeProviderRegistry } from '../../src/knowledge/KnowledgeProviders.js';

const CREATED_AT = '2026-09-24T00:00:00.000Z';

async function collect(stream: AsyncIterable<KnowledgeChatEvent>): Promise<KnowledgeChatEvent[]> {
  const events: KnowledgeChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function chunkProvider(chunks: string[]): KnowledgeChatProvider {
  return async function* provider() {
    for (const chunk of chunks) yield chunk;
  };
}

function throwingProvider(chunks: string[], error: Error): KnowledgeChatProvider {
  return async function* provider() {
    for (const chunk of chunks) yield chunk;
    throw error;
  };
}

describe('KnowledgeChatService', () => {
  const databases: Array<{ close: () => void }> = [];
  const directories: string[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function createDatabase(): { db: ReturnType<typeof openDatabase>; workspaceRoot: string } {
    const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-chat-test-'));
    directories.push(workspaceRoot);
    const db = openDatabase(':memory:');
    databases.push(db);
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', ?, 'Wiki', 'active', ?, ?)`,
    ).run(workspaceRoot, CREATED_AT, CREATED_AT);
    return { db, workspaceRoot };
  }

  function seedSource(db: ReturnType<typeof openDatabase>): void {
    db.prepare(
      `INSERT INTO knowledge_sources
       (id, project_id, source_kind, source_path, current_hash, status, created_at, updated_at)
       VALUES ('source_1', 'project_1', 'file', 'docs/setup-guide.md', 'hash1', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_source_versions
       (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('source_version_1', 'project_1', 'source_1', 1, 'hash1', 'sources/setup-guide.md', 100, ?)`,
    ).run(CREATED_AT);
  }

  function registryWithChatProvider(): KnowledgeProviderRegistry {
    const registry = new KnowledgeProviderRegistry();
    registry.register({ id: 'test-provider', capabilities: ['chat'] });
    return registry;
  }

  it('creates, lists, renames, and deletes conversations', () => {
    const { db, workspaceRoot } = createDatabase();
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['ok']));

    const conversation = service.createConversation({ projectId: 'project_1', title: 'Setup questions' });
    expect(conversation).toMatchObject({ projectId: 'project_1', title: 'Setup questions' });
    expect(service.getConversation('project_1', conversation.id)).toMatchObject({ id: conversation.id });
    expect(service.listConversations('project_1')).toHaveLength(1);

    const renamed = service.renameConversation('project_1', conversation.id, 'Renamed');
    expect(renamed.title).toBe('Renamed');

    service.deleteConversation('project_1', conversation.id);
    expect(() => service.getConversation('project_1', conversation.id)).toThrow(/not found/);
    expect(existsSync(join(workspaceRoot, 'conversations', conversation.id))).toBe(false);
  });

  it('requires the caller project to match conversation and message ownership', async () => {
    const { db } = createDatabase();
    seedSource(db);
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_2', ?, 'Other Wiki', 'active', ?, ?)`,
    ).run(mkdtempSync(join(process.cwd(), '.knowledge-chat-other-')), CREATED_AT, CREATED_AT);
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
    const conversation = service.createConversation({ projectId: 'project_1' });
    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'setup guide' }),
    );
    const assistantMessage = events.find((event) => event.type === 'done');
    if (assistantMessage?.type !== 'done') throw new Error('Expected an assistant message');

    expect(() => service.getConversation('project_2', conversation.id)).toThrow(/not found/);
    expect(() => service.listMessages('project_2', conversation.id)).toThrow(/not found/);
    expect(() => service.getMessage('project_2', assistantMessage.messageId)).toThrow(/not found/);
    expect(() => service.renameConversation('project_2', conversation.id, 'Cross-project')).toThrow(/not found/);
    expect(() => service.deleteConversation('project_2', conversation.id)).toThrow(/not found/);
    expect(() =>
      service.saveMessageToPage({
        projectId: 'project_2',
        messageId: assistantMessage.messageId,
        type: 'source',
        title: 'Cross-project',
        slug: 'cross-project',
      }),
    ).toThrow(/not found/);
    expect(() =>
      service.regenerateKnowledgeChat({
        projectId: 'project_2',
        messageId: assistantMessage.messageId,
      }),
    ).toThrow(/not found/);
  });

  it('persists user and assistant messages and emits meta, delta, and done events in order', async () => {
    const { db } = createDatabase();
    seedSource(db);
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['Hello', ' world']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({
        projectId: 'project_1',
        conversationId: conversation.id,
        query: 'setup guide',
        mode: 'sources',
      }),
    );

    expect(events[0]).toMatchObject({ type: 'meta', retrievalMode: 'sources', providerId: 'test-provider' });
    expect(events.filter((event) => event.type === 'citation')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'delta').map((event: any) => event.text)).toEqual([
      'Hello',
      ' world',
    ]);
    const done = events[events.length - 1];
    expect(done).toMatchObject({ type: 'done' });
    expect((done as any).message.content).toBe('Hello world');
    expect((done as any).message.citations).toHaveLength(1);

    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'setup guide' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Hello world' });
  });

  it('threads retrieval mode through to the underlying search and citations', async () => {
    const { db } = createDatabase();
    seedSource(db);
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'setup guide', mode: 'read-sources-only' }),
    );
    const meta = events.find((event) => event.type === 'meta');
    expect(meta).toMatchObject({ retrievalMode: 'read-sources-only', resultCount: 1, citationCount: 1 });
  });

  it('enforces history limits by pruning the oldest messages', async () => {
    const { db } = createDatabase();
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['a']), {
      historyLimit: 2,
    });
    const conversation = service.createConversation({ projectId: 'project_1' });

    for (let index = 0; index < 3; index += 1) {
      await collect(
        service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: `question ${index}`, mode: 'knowledge' }),
      );
    }

    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[messages.length - 1].content).toBe('a');
  });

  it('cancels an in-flight stream and persists no assistant message', async () => {
    const { db } = createDatabase();
    let releaseSecondChunk: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const provider: KnowledgeChatProvider = async function* cancellable() {
      yield 'first';
      await gate;
      yield 'second';
    };
    const service = new KnowledgeChatService(db, registryWithChatProvider(), provider);
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events: KnowledgeChatEvent[] = [];
    const iterator = service
      .streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'cancel me', mode: 'knowledge' })
      [Symbol.asyncIterator]();

    let messageId = '';
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) break;
      events.push(value);
      if (value.type === 'meta') messageId = value.messageId;
      if (value.type === 'delta' && value.text === 'first') {
        service.cancel(messageId);
        releaseSecondChunk?.();
      }
    }

    expect(events.some((event) => event.type === 'cancelled')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('regenerates the last assistant response without duplicating the user turn', async () => {
    const { db } = createDatabase();
    let callCount = 0;
    const provider: KnowledgeChatProvider = async function* dynamic() {
      callCount += 1;
      yield callCount === 1 ? 'first answer' : 'second answer';
    };
    const service = new KnowledgeChatService(db, registryWithChatProvider(), provider);
    const conversation = service.createConversation({ projectId: 'project_1' });

    const firstEvents = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'question', mode: 'knowledge' }),
    );
    const firstDone = firstEvents.find((event) => event.type === 'done') as Extract<
      KnowledgeChatEvent,
      { type: 'done' }
    >;

    const secondEvents = await collect(service.regenerateKnowledgeChat({ projectId: 'project_1', messageId: firstDone.messageId }));
    const secondDone = secondEvents.find((event) => event.type === 'done') as Extract<
      KnowledgeChatEvent,
      { type: 'done' }
    >;

    expect(secondDone.message.content).toBe('second answer');
    expect(secondDone.messageId).not.toBe(firstDone.messageId);

    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'question' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'second answer' });
  });

  it('saves an assistant message to a page with citation provenance', async () => {
    const { db, workspaceRoot } = createDatabase();
    seedSource(db);
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['Setup instructions']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'setup guide', mode: 'sources' }),
    );
    const done = events.find((event) => event.type === 'done') as Extract<KnowledgeChatEvent, { type: 'done' }>;

    const page = service.saveMessageToPage({
      projectId: 'project_1',
      messageId: done.messageId,
      type: 'synthesis',
      title: 'Setup Instructions',
      slug: 'setup-instructions',
    });

    expect(page.contentPath).toBe('pages/synthesis/setup-instructions.md');
    expect(
      readFileSync(join(workspaceRoot, '.ariadne', 'knowledge', page.contentPath), 'utf8'),
    ).toBe('Setup instructions');
    expect(page.provenance).toEqual([{ kind: 'source', id: 'source_1', confidence: 1 }]);
  });

  describe('citation context and payload versions', () => {
    const SPAN = { id: 'span_1', startOffset: 0, endOffset: 12, startLine: 1, startColumn: 1, endLine: 2, endColumn: 5, label: 'Setup' };
    const CITATION = { pageId: null, sourceId: 'source_1', path: 'docs/setup-guide.md', url: null, span: SPAN };

    function seedSpan(db: ReturnType<typeof openDatabase>): void {
      db.prepare(
        `INSERT INTO knowledge_source_spans
         (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
         VALUES ('span_1', 'project_1', 'source_version_1', 0, 12, 1, 1, 2, 5, 'Setup', ?)`,
      ).run(CREATED_AT);
    }

    function insertMessage(
      db: ReturnType<typeof openDatabase>,
      workspaceRoot: string,
      payload: Record<string, unknown>,
      role: 'user' | 'assistant' = 'assistant',
      id = 'message_1',
    ): string {
      db.prepare(
        `INSERT OR IGNORE INTO knowledge_conversations (id, project_id, title, created_at, updated_at)
         VALUES ('conversation_1', 'project_1', 'Seeded', ?, ?)`,
      ).run(CREATED_AT, CREATED_AT);
      const relative = `conversations/conversation_1/${id}.json`;
      mkdirSync(join(workspaceRoot, 'conversations', 'conversation_1'), { recursive: true });
      writeFileSync(join(workspaceRoot, relative), JSON.stringify(payload), 'utf8');
      db.prepare(
        `INSERT INTO knowledge_messages (id, project_id, conversation_id, role, content_path, created_at)
         VALUES (?, 'project_1', 'conversation_1', ?, ?, ?)`,
      ).run(id, role, relative, CREATED_AT);
      return id;
    }

    function savedSpanIds(db: ReturnType<typeof openDatabase>): Array<string | null> {
      return (
        db.prepare('SELECT source_span_id FROM knowledge_page_provenance ORDER BY rowid').all() as Array<{ source_span_id: string | null }>
      ).map((row) => row.source_span_id);
    }

    it('writes V2 payloads with reference-only context and no synthesis slot', async () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
      const conversation = service.createConversation({ projectId: 'project_1' });
      const events = await collect(
        service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'setup guide', mode: 'sources' }),
      );
      const done = events.find((event) => event.type === 'done') as Extract<KnowledgeChatEvent, { type: 'done' }>;
      const citationEvent = events.find((event) => event.type === 'citation') as Extract<KnowledgeChatEvent, { type: 'citation' }>;

      const raw = readFileSync(join(workspaceRoot, 'conversations', conversation.id, `${done.messageId}.json`), 'utf8');
      const payload = JSON.parse(raw) as { schemaVersion: number; citations: Array<{ context: Record<string, unknown> }>; synthesis?: unknown };
      expect(payload.schemaVersion).toBe(2);
      expect(payload).not.toHaveProperty('synthesis');
      expect(payload.citations[0]?.context).toMatchObject({
        sourceSpanId: null,
        matchKind: 'metadata_only',
        snippetPolicy: 'reference_only',
        legacyState: 'current',
      });
      expect(citationEvent.citation.context).toEqual(payload.citations[0]?.context);
      expect(done.message.citations[0]?.context?.legacyState).toBe('current');

      const userPayload = JSON.parse(
        readFileSync(join(workspaceRoot, 'conversations', conversation.id, `${service.listMessages('project_1', conversation.id)[0]!.id}.json`), 'utf8'),
      ) as { schemaVersion: number };
      expect(userPayload.schemaVersion).toBe(2);
    });

    it('persists span-backed citations with the verified source version and never raw excerpts', async () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      const spanCitation = { ...CITATION, excerpt: 'SECRET SOURCE TEXT' };
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
      const conversation = service.createConversation({ projectId: 'project_1' });
      // Provider search results are internal; exercise the persistence boundary directly.
      const written = (service as unknown as {
        writeMessage: (root: string, input: Record<string, unknown>) => { citations: Array<{ context?: Record<string, unknown> }> };
      }).writeMessage(workspaceRoot, {
        id: 'message_direct',
        projectId: 'project_1',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'answer',
        citations: [spanCitation],
        retrievalMode: 'sources',
        createdAt: CREATED_AT,
      });
      const raw = readFileSync(join(workspaceRoot, 'conversations', conversation.id, 'message_direct.json'), 'utf8');
      expect(raw).not.toContain('SECRET SOURCE TEXT');
      expect(written.citations[0]?.context).toMatchObject({
        sourceVersionId: 'source_version_1',
        sourceSpanId: 'span_1',
        matchKind: 'exact_span',
        snippetPolicy: 'reference_only',
        startLineWindow: 1,
        endLineWindow: 2,
      });
    });

    it('coerces an ephemeral snippet policy to reference_only when persisting', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
      const conversation = service.createConversation({ projectId: 'project_1' });
      (service as unknown as { writeMessage: (root: string, input: Record<string, unknown>) => unknown }).writeMessage(workspaceRoot, {
        id: 'message_eph',
        projectId: 'project_1',
        conversationId: conversation.id,
        role: 'assistant',
        content: 'answer',
        citations: [
          {
            ...CITATION,
            context: {
              sourceVersionId: 'source_version_1',
              sourceSpanId: 'span_1',
              fieldKind: 'section',
              fieldLabel: 'Setup',
              matchKind: 'exact_span',
              snippetPolicy: 'ephemeral_redacted',
              startLineWindow: 1,
              endLineWindow: 2,
              legacyState: 'current',
            },
          },
        ],
        retrievalMode: null,
        createdAt: CREATED_AT,
      });
      const payload = JSON.parse(readFileSync(join(workspaceRoot, 'conversations', conversation.id, 'message_eph.json'), 'utf8')) as {
        citations: Array<{ context: { snippetPolicy: string } }>;
      };
      expect(payload.citations[0]?.context.snippetPolicy).toBe('reference_only');
    });

    it('reads legacy payloads without schemaVersion as legacy_payload and does not rewrite them', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      const legacy = { content: 'old answer', citations: [CITATION], retrievalMode: 'sources' };
      insertMessage(db, workspaceRoot, legacy);

      const message = service.getMessage('project_1', 'message_1');
      expect(message.citations[0]?.context).toMatchObject({
        legacyState: 'legacy_payload',
        matchKind: 'legacy_unknown',
        sourceSpanId: 'span_1',
        sourceVersionId: null,
      });
      expect(JSON.parse(readFileSync(join(workspaceRoot, 'conversations', 'conversation_1', 'message_1.json'), 'utf8'))).toEqual(legacy);
    });

    it('marks malformed context in a V2 payload as legacy_unknown instead of failing the read', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      insertMessage(db, workspaceRoot, {
        schemaVersion: 2,
        content: 'answer',
        citations: [{ ...CITATION, context: { matchKind: 'bogus', excerpt: 'leak' } }],
        retrievalMode: null,
      });
      const [message] = [service.getMessage('project_1', 'message_1')];
      expect(message.citations[0]?.context).toMatchObject({ legacyState: 'legacy_unknown', matchKind: 'legacy_unknown' });
      expect(JSON.stringify(message)).not.toContain('leak');
    });

    it('regenerates from a legacy user payload', async () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['fresh']));
      insertMessage(db, workspaceRoot, { content: 'setup guide', citations: [], retrievalMode: 'sources' }, 'user', 'message_user');
      insertMessage(db, workspaceRoot, { content: 'old', citations: [], retrievalMode: 'sources' }, 'assistant', 'message_assistant');
      const events = await collect(service.regenerateKnowledgeChat({ projectId: 'project_1', messageId: 'message_assistant' }));
      expect(events[0]).toMatchObject({ type: 'meta', retrievalMode: 'sources' });
      expect(events[events.length - 1]).toMatchObject({ type: 'done' });
    });

    it('reuses context.sourceSpanId when saving a message to a page', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      insertMessage(db, workspaceRoot, {
        schemaVersion: 2,
        content: 'Setup instructions',
        citations: [
          {
            ...CITATION,
            span: { ...SPAN, startOffset: 999, endOffset: 1000 },
            context: {
              sourceVersionId: 'source_version_1',
              sourceSpanId: 'span_1',
              fieldKind: 'section',
              fieldLabel: 'Setup',
              matchKind: 'exact_span',
              snippetPolicy: 'reference_only',
              startLineWindow: 1,
              endLineWindow: 2,
              legacyState: 'current',
            },
          },
        ],
        retrievalMode: 'sources',
      });

      const page = service.saveMessageToPage({ projectId: 'project_1', messageId: 'message_1', type: 'synthesis', title: 'Setup', slug: 'setup' });
      expect(savedSpanIds(db)).toEqual(['span_1']);
      expect(page.provenance).toEqual([
        expect.objectContaining({ kind: 'source', id: 'source_1', sourceVersionId: 'source_version_1', startOffset: 0, endOffset: 12 }),
      ]);
    });

    it('falls back to source version plus coordinates, then to source-only provenance', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      const coordinateContext = {
        sourceVersionId: 'source_version_1',
        sourceSpanId: null,
        fieldKind: 'section',
        fieldLabel: 'Setup',
        matchKind: 'exact_span',
        snippetPolicy: 'reference_only',
        startLineWindow: 1,
        endLineWindow: 2,
        legacyState: 'current',
      };
      insertMessage(db, workspaceRoot, {
        schemaVersion: 2,
        content: 'By coordinates',
        citations: [{ ...CITATION, context: coordinateContext }],
        retrievalMode: null,
      });
      service.saveMessageToPage({ projectId: 'project_1', messageId: 'message_1', type: 'synthesis', title: 'Coords', slug: 'coords' });
      expect(savedSpanIds(db)).toEqual(['span_1']);

      insertMessage(db, workspaceRoot, { content: 'Legacy only', citations: [{ ...CITATION, span: null }], retrievalMode: null }, 'assistant', 'message_2');
      service.saveMessageToPage({ projectId: 'project_1', messageId: 'message_2', type: 'synthesis', title: 'Legacy', slug: 'legacy' });
      expect(savedSpanIds(db)).toEqual(['span_1', null]);
    });

    it('does not reuse a span id that belongs to another source or project', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      insertMessage(db, workspaceRoot, {
        schemaVersion: 2,
        content: 'Mismatched',
        citations: [
          {
            ...CITATION,
            sourceId: 'source_other',
            span: null,
            context: {
              sourceVersionId: null,
              sourceSpanId: 'span_1',
              fieldKind: 'section',
              fieldLabel: null,
              matchKind: 'exact_span',
              snippetPolicy: 'reference_only',
              startLineWindow: null,
              endLineWindow: null,
              legacyState: 'current',
            },
          },
        ],
        retrievalMode: null,
      });
      service.saveMessageToPage({ projectId: 'project_1', messageId: 'message_1', type: 'synthesis', title: 'Mismatch', slug: 'mismatch' });
      expect(savedSpanIds(db)).toEqual([null]);
    });

    it('keeps distinct spans of the same source as separate provenance rows', () => {
      const { db, workspaceRoot } = createDatabase();
      seedSource(db);
      seedSpan(db);
      db.prepare(
        `INSERT INTO knowledge_source_spans (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
         VALUES ('span_2', 'project_1', 'source_version_1', 20, 30, 4, 1, 5, 1, 'Install', ?)`,
      ).run(CREATED_AT);
      const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));
      const context = (spanId: string) => ({
        sourceVersionId: 'source_version_1',
        sourceSpanId: spanId,
        fieldKind: 'section',
        fieldLabel: null,
        matchKind: 'exact_span',
        snippetPolicy: 'reference_only',
        startLineWindow: null,
        endLineWindow: null,
        legacyState: 'current',
      });
      insertMessage(db, workspaceRoot, {
        schemaVersion: 2,
        content: 'Two spans',
        citations: [
          { ...CITATION, context: context('span_1') },
          { ...CITATION, span: { ...SPAN, id: 'span_2', startOffset: 20, endOffset: 30 }, context: context('span_2') },
          { ...CITATION, context: context('span_1') },
        ],
        retrievalMode: null,
      });
      service.saveMessageToPage({ projectId: 'project_1', messageId: 'message_1', type: 'synthesis', title: 'Two', slug: 'two' });
      expect(savedSpanIds(db)).toEqual(['span_1', 'span_2']);
    });
  });

  it('rejects unsafe page paths when saving chat output', async () => {
    const { db } = createDatabase();
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['answer']));
    const conversation = service.createConversation({ projectId: 'project_1' });
    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'question', mode: 'knowledge' }),
    );
    const done = events.find((event) => event.type === 'done') as Extract<KnowledgeChatEvent, { type: 'done' }>;

    expect(() =>
      service.saveMessageToPage({
        projectId: 'project_1',
        messageId: done.messageId,
        type: 'synthesis',
        title: 'Unsafe',
        slug: '../../outside',
      }),
    ).toThrow(/safe path components/i);
  });

  it('rejects reading or deleting chat payloads through a symlinked conversations directory', () => {
    const { db, workspaceRoot } = createDatabase();
    const outsideRoot = mkdtempSync(join(process.cwd(), '.knowledge-chat-outside-'));
    directories.push(outsideRoot);
    mkdirSync(join(outsideRoot, 'conversation_1'), { recursive: true });
    writeFileSync(
      join(outsideRoot, 'conversation_1', 'message_1.json'),
      JSON.stringify({ content: 'outside', citations: [], retrievalMode: 'knowledge' }),
      'utf8',
    );
    symlinkSync(outsideRoot, join(workspaceRoot, 'conversations'));
    db.prepare(
      `INSERT INTO knowledge_conversations (id, project_id, title, created_at, updated_at)
       VALUES ('conversation_1', 'project_1', 'Unsafe', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_messages (id, project_id, conversation_id, role, content_path, created_at)
       VALUES ('message_1', 'project_1', 'conversation_1', 'assistant', 'conversations/conversation_1/message_1.json', ?)`,
    ).run(CREATED_AT);

    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['unused']));

    expect(() => service.listMessages('project_1', 'conversation_1')).toThrow(/symbolic links/i);
    expect(() => service.deleteConversation('project_1', 'conversation_1')).toThrow(/symbolic links/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_messages WHERE id = ?').get('message_1')).toEqual({
      count: 1,
    });
    expect(existsSync(join(outsideRoot, 'conversation_1', 'message_1.json'))).toBe(true);
  });

  it('emits an error event when no chat-capable provider is registered', async () => {
    const { db } = createDatabase();
    const emptyRegistry = new KnowledgeProviderRegistry();
    const service = new KnowledgeChatService(db, emptyRegistry, chunkProvider(['unused']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'anything', mode: 'knowledge' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as any).message).toMatch(/chat/);

    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('emits an error event and no done event when the provider fails mid-stream', async () => {
    const { db } = createDatabase();
    const service = new KnowledgeChatService(
      db,
      registryWithChatProvider(),
      throwingProvider(['partial '], new Error('provider exploded')),
    );
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({ projectId: 'project_1', conversationId: conversation.id, query: 'anything', mode: 'knowledge' }),
    );

    expect(events.some((event) => event.type === 'delta')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({ type: 'error', message: 'provider exploded' });

    const messages = service.listMessages('project_1', conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });
});
