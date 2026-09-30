import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { KnowledgeAnswerSynthesizer } from '../../src/knowledge/KnowledgeAnswerSynthesis.js';
import {
  KnowledgeChatService,
  type KnowledgeChatEvent,
  type KnowledgeChatProvider,
} from '../../src/knowledge/KnowledgeChat.js';
import { KnowledgeProviderRegistry } from '../../src/knowledge/KnowledgeProviders.js';
import type { KnowledgeSynthesisProviderRequest } from '../../src/knowledge/KnowledgeSynthesisTypes.js';
import { FIXTURE_PROJECT_ID, seedAuthCorpus } from './knowledgeSynthesisFixtures.js';
import {
  ProviderFixture,
  completionResponse,
  createProviderHarness,
  openHarnessDatabase,
  type ProviderHarness,
} from './knowledgeProviderTestHarness.js';

const QUERY = 'authenticate user session';

async function collect(stream: AsyncIterable<KnowledgeChatEvent>): Promise<KnowledgeChatEvent[]> {
  const events: KnowledgeChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const failingChatProvider: KnowledgeChatProvider = () => {
  throw new Error('the chat provider must not be used for synthesized answers');
};

function providerRequestOf(fixture: ProviderFixture): KnowledgeSynthesisProviderRequest {
  const body = JSON.parse(fixture.requests[fixture.requests.length - 1].body) as { messages: Array<{ content: string }> };
  return JSON.parse(body.messages[1].content) as KnowledgeSynthesisProviderRequest;
}

describe('KnowledgeChatService synthesis opt-in', () => {
  const fixture = new ProviderFixture();
  let workspaceRoot: string;
  let db: Database.Database;
  let harness: ProviderHarness;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'ariadne-synth-chat-'));
    db = openHarnessDatabase(workspaceRoot);
    harness = createProviderHarness(db);
    seedAuthCorpus(db);
  });

  afterEach(async () => {
    await fixture.stop();
    fixture.requests.length = 0;
    db.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function service(options: { synthesis?: 'gateway' } = {}) {
    const synthesisService = new KnowledgeAnswerSynthesizer({
      db,
      gateway: options.synthesis === 'gateway' ? harness.gateway : undefined,
    });
    const chat = new KnowledgeChatService(db, new KnowledgeProviderRegistry(), failingChatProvider, { synthesisService });
    return { chat, conversationId: chat.createConversation({ projectId: FIXTURE_PROJECT_ID }).id };
  }

  function stream(chat: KnowledgeChatService, conversationId: string, synthesis: Record<string, unknown> = {}) {
    return collect(
      chat.streamKnowledgeChat({
        projectId: FIXTURE_PROJECT_ID,
        conversationId,
        query: QUERY,
        mode: 'sources',
        synthesis,
      }),
    );
  }

  function payloadFiles(): string[] {
    const root = join(workspaceRoot, 'conversations');
    return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((entry) => entry.endsWith('.json'));
  }

  it('streams the validated deterministic answer without a chat provider and persists reference-only synthesis', async () => {
    const { chat, conversationId } = service();

    const events = await stream(chat, conversationId);

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['meta', 'citation', 'delta', 'done']));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const meta = events.find((event) => event.type === 'meta');
    expect(meta).toMatchObject({ providerId: 'synthesis:deterministic', retrievalMode: 'sources' });
    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');
    const streamed = events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');
    expect(streamed).toBe(done.message.content);
    expect(done.message.synthesis).toMatchObject({ synthesisVersion: 1, strategy: 'deterministic' });
    expect(done.message.citations.map((citation) => citation.path).sort()).toEqual(['src/auth/login.ts', 'src/auth/session.ts']);

    const stored = chat.getMessage(FIXTURE_PROJECT_ID, done.messageId);
    expect(stored.synthesis).toEqual(done.message.synthesis);
    const raw = readFileSync(join(workspaceRoot, 'conversations', conversationId, `${done.messageId}.json`), 'utf8');
    expect(raw).not.toContain('ephemeralSnippet');
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 2, synthesis: { synthesisVersion: 1 } });
  });

  it('keeps non-opt-in chat behaviour unchanged and free of a synthesis block', async () => {
    async function* answer() {
      yield 'plain answer';
    }
    const registry = new KnowledgeProviderRegistry();
    registry.register({ id: 'chat-provider', capabilities: ['chat'] });
    const chat = new KnowledgeChatService(db, registry, () => answer());
    const conversationId = chat.createConversation({ projectId: FIXTURE_PROJECT_ID }).id;

    const events = await collect(
      chat.streamKnowledgeChat({ projectId: FIXTURE_PROJECT_ID, conversationId, query: QUERY, mode: 'sources' }),
    );

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');
    expect(done.message.content).toBe('plain answer');
    expect(done.message).not.toHaveProperty('synthesis');
    expect(events.find((event) => event.type === 'meta')).toMatchObject({ providerId: 'chat-provider' });
  });

  it('carries exact claim citations into saved page provenance', async () => {
    const { chat, conversationId } = service();
    const events = await stream(chat, conversationId);
    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');
    const spanIds = new Set(
      (done.message.synthesis?.sections ?? []).flatMap((section) => section.claims.flatMap((claim) => claim.citations.map((citation) => citation.span?.id))),
    );

    const page = chat.saveMessageToPage({
      projectId: FIXTURE_PROJECT_ID,
      messageId: done.messageId,
      type: 'concept',
      title: 'Auth flow',
      slug: 'auth-flow',
    });

    const rows = db
      .prepare('SELECT source_span_id FROM knowledge_page_provenance WHERE page_version_id = ?')
      .all(page.id) as Array<{ source_span_id: string | null }>;
    expect(rows.length).toBe(2);
    for (const row of rows) expect(spanIds.has(row.source_span_id ?? '')).toBe(true);
  });

  it('adds a provider-assisted answer and persists no prompt, response body, or snippet', async () => {
    const endpoint = await fixture.start((request, response) => {
      const ids = providerRequestOf(fixture).evidence.map((entry) => entry.id);
      completionResponse({
        sections: [{ heading: 'Answer', claims: [{ text: 'Login and session code cooperate.', evidenceIds: ids }] }],
      })(request, response);
    });
    harness.createProfile({ name: 'gen', endpoint });
    const { chat, conversationId } = service({ synthesis: 'gateway' });

    const events = await stream(chat, conversationId, { providerStrategy: 'if-available', providerProfileName: 'gen' });

    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');
    expect(fixture.requests).toHaveLength(1);
    expect(events.find((event) => event.type === 'meta')).toMatchObject({ providerId: 'synthesis:provider-assisted' });
    expect(done.message.synthesis?.strategy).toBe('provider-assisted');
    expect(done.message.content).toContain('Login and session code cooperate.');
    const disk = payloadFiles()
      .map((file) => readFileSync(join(workspaceRoot, 'conversations', file), 'utf8'))
      .join('\n');
    expect(disk).not.toContain('You rewrite a grounded');
    expect(disk).not.toContain('response_format');
    expect(disk).not.toContain('ephemeralSnippet');
    expect(disk).not.toContain('against the directory');
    const dbDump = JSON.stringify(db.prepare('SELECT * FROM knowledge_messages').all());
    expect(dbDump).not.toContain('Login and session code cooperate.');
  });

  it('falls back with a persisted warning and no error event when the provider fails', async () => {
    const endpoint = await fixture.start((_request, response) => {
      response.writeHead(500);
      response.end('boom');
    });
    harness.createProfile({ name: 'bad', endpoint });
    const { chat, conversationId } = service({ synthesis: 'gateway' });

    const events = await stream(chat, conversationId, { providerStrategy: 'if-available', providerProfileName: 'bad' });

    expect(events.some((event) => event.type === 'error')).toBe(false);
    const done = events.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');
    expect(done.message.synthesis?.strategy).toBe('deterministic');
    expect(done.message.synthesis?.warnings).toEqual([
      expect.objectContaining({ code: 'provider_unavailable', reason: 'provider_error' }),
    ]);
  });

  it('regenerates a synthesized answer with the supplied synthesis options', async () => {
    const { chat, conversationId } = service();
    const first = await stream(chat, conversationId);
    const done = first.find((event) => event.type === 'done');
    if (done?.type !== 'done') throw new Error('Expected done');

    const events = await collect(
      chat.regenerateKnowledgeChat({ projectId: FIXTURE_PROJECT_ID, messageId: done.messageId, synthesis: {} }),
    );

    const regenerated = events.find((event) => event.type === 'done');
    if (regenerated?.type !== 'done') throw new Error('Expected done');
    expect(regenerated.message.synthesis?.strategy).toBe('deterministic');
    expect(chat.listMessages(FIXTURE_PROJECT_ID, conversationId)).toHaveLength(2);
  });

  it('persists nothing when a synthesized stream is cancelled', async () => {
    const { chat, conversationId } = service();
    const events: KnowledgeChatEvent[] = [];

    for await (const event of chat.streamKnowledgeChat({
      projectId: FIXTURE_PROJECT_ID,
      conversationId,
      query: QUERY,
      mode: 'sources',
      synthesis: {},
    })) {
      events.push(event);
      if (event.type === 'delta') chat.cancel(event.messageId);
    }

    expect(events.at(-1)?.type).toBe('cancelled');
    expect(chat.listMessages(FIXTURE_PROJECT_ID, conversationId).map((message) => message.role)).toEqual(['user']);
    expect(payloadFiles()).toHaveLength(1);
  });

  it('reports a persistence failure as an error event and leaves no orphan payload', async () => {
    const { chat, conversationId } = service();
    const events: KnowledgeChatEvent[] = [];

    for await (const event of chat.streamKnowledgeChat({
      projectId: FIXTURE_PROJECT_ID,
      conversationId,
      query: QUERY,
      mode: 'sources',
      synthesis: {},
    })) {
      events.push(event);
      if (event.type === 'meta') db.pragma('foreign_keys = ON');
      if (event.type === 'meta') db.prepare('DELETE FROM knowledge_conversations WHERE id = ?').run(conversationId);
    }

    expect(events.at(-1)?.type).toBe('error');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    expect(payloadFiles()).toHaveLength(1);
  });
});
