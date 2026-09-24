import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    expect(service.getConversation(conversation.id)).toMatchObject({ id: conversation.id });
    expect(service.listConversations('project_1')).toHaveLength(1);

    const renamed = service.renameConversation(conversation.id, 'Renamed');
    expect(renamed.title).toBe('Renamed');

    service.deleteConversation(conversation.id);
    expect(() => service.getConversation(conversation.id)).toThrow(/not found/);
    expect(existsSync(join(workspaceRoot, 'conversations', conversation.id))).toBe(false);
  });

  it('persists user and assistant messages and emits meta, delta, and done events in order', async () => {
    const { db } = createDatabase();
    seedSource(db);
    const service = new KnowledgeChatService(db, registryWithChatProvider(), chunkProvider(['Hello', ' world']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({
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

    const messages = service.listMessages(conversation.id);
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
      service.streamKnowledgeChat({ conversationId: conversation.id, query: 'setup guide', mode: 'read-sources-only' }),
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
        service.streamKnowledgeChat({ conversationId: conversation.id, query: `question ${index}`, mode: 'knowledge' }),
      );
    }

    const messages = service.listMessages(conversation.id);
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
      .streamKnowledgeChat({ conversationId: conversation.id, query: 'cancel me', mode: 'knowledge' })
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
    const messages = service.listMessages(conversation.id);
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
      service.streamKnowledgeChat({ conversationId: conversation.id, query: 'question', mode: 'knowledge' }),
    );
    const firstDone = firstEvents.find((event) => event.type === 'done') as Extract<
      KnowledgeChatEvent,
      { type: 'done' }
    >;

    const secondEvents = await collect(service.regenerateKnowledgeChat({ messageId: firstDone.messageId }));
    const secondDone = secondEvents.find((event) => event.type === 'done') as Extract<
      KnowledgeChatEvent,
      { type: 'done' }
    >;

    expect(secondDone.message.content).toBe('second answer');
    expect(secondDone.messageId).not.toBe(firstDone.messageId);

    const messages = service.listMessages(conversation.id);
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
      service.streamKnowledgeChat({ conversationId: conversation.id, query: 'setup guide', mode: 'sources' }),
    );
    const done = events.find((event) => event.type === 'done') as Extract<KnowledgeChatEvent, { type: 'done' }>;

    const page = service.saveMessageToPage({
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

  it('emits an error event when no chat-capable provider is registered', async () => {
    const { db } = createDatabase();
    const emptyRegistry = new KnowledgeProviderRegistry();
    const service = new KnowledgeChatService(db, emptyRegistry, chunkProvider(['unused']));
    const conversation = service.createConversation({ projectId: 'project_1' });

    const events = await collect(
      service.streamKnowledgeChat({ conversationId: conversation.id, query: 'anything', mode: 'knowledge' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as any).message).toMatch(/chat/);

    const messages = service.listMessages(conversation.id);
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
      service.streamKnowledgeChat({ conversationId: conversation.id, query: 'anything', mode: 'knowledge' }),
    );

    expect(events.some((event) => event.type === 'delta')).toBe(true);
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent).toMatchObject({ type: 'error', message: 'provider exploded' });

    const messages = service.listMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });
});
