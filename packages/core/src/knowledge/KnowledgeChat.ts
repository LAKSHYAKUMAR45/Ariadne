import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import {
  buildKnowledgeSearchContext,
  searchKnowledge,
  type KnowledgeSearchCitation,
  type KnowledgeSearchContext,
  type KnowledgeSearchMode,
} from './KnowledgeSearch.js';
import {
  redactKnowledgeProviderPayload,
  type KnowledgeProviderExecutionContext,
  type KnowledgeProviderRegistry,
  type KnowledgeRedactionHook,
} from './KnowledgeProviders.js';
import { createPageVersion, type CreatePageVersionInput, type KnowledgePageVersion } from './KnowledgePageStore.js';
import type { KnowledgePageType, KnowledgeProvenanceRef } from './KnowledgeTypes.js';
import type { TaskStore } from '../TaskStore.js';
import { assertNoSymlinkComponents, isPathWithinRoot } from './KnowledgePathSecurity.js';

export type KnowledgeChatRole = 'user' | 'assistant';

export interface KnowledgeConversationRecord {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChatMessageRecord {
  id: string;
  projectId: string;
  conversationId: string;
  role: KnowledgeChatRole;
  content: string;
  citations: KnowledgeSearchCitation[];
  retrievalMode: KnowledgeSearchMode | null;
  createdAt: string;
}

export interface CreateKnowledgeConversationInput {
  projectId: string;
  title?: string | null;
  createdAt?: string;
}

export interface ListKnowledgeConversationsOptions {
  limit?: number;
}

export interface ListKnowledgeMessagesOptions {
  limit?: number;
}

export interface KnowledgeChatProviderMessage {
  role: KnowledgeChatRole;
  content: string;
}

export interface KnowledgeChatProviderRequest {
  conversationId: string;
  query: string;
  mode: KnowledgeSearchMode;
  history: KnowledgeChatProviderMessage[];
  searchContext: KnowledgeSearchContext;
}

export type KnowledgeChatProvider = (
  request: KnowledgeChatProviderRequest,
  context: KnowledgeProviderExecutionContext,
) => AsyncIterable<string>;

export interface StreamKnowledgeChatInput {
  conversationId: string;
  query: string;
  mode?: KnowledgeSearchMode;
  taskStore?: TaskStore;
  limit?: number;
  maxGraphExpansions?: number;
  tokenBudget?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RegenerateKnowledgeChatInput {
  messageId: string;
  taskStore?: TaskStore;
  limit?: number;
  maxGraphExpansions?: number;
  tokenBudget?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SaveKnowledgeChatMessageToPageInput {
  messageId: string;
  type: KnowledgePageType;
  title: string;
  slug: string;
  summary?: string | null;
  generatorVersion?: string | null;
}

export type KnowledgeChatEvent =
  | {
      type: 'meta';
      conversationId: string;
      messageId: string;
      retrievalMode: KnowledgeSearchMode;
      providerId: string;
      resultCount: number;
      citationCount: number;
    }
  | { type: 'delta'; messageId: string; text: string }
  | { type: 'citation'; messageId: string; citation: KnowledgeSearchCitation }
  | { type: 'done'; messageId: string; message: KnowledgeChatMessageRecord }
  | { type: 'cancelled'; messageId: string }
  | { type: 'error'; messageId: string; message: string };

export interface KnowledgeChatServiceOptions {
  historyLimit?: number;
  now?: () => string;
  redact?: KnowledgeRedactionHook;
}

interface ConversationRow {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  project_id: string;
  conversation_id: string;
  role: KnowledgeChatRole;
  content_path: string;
  created_at: string;
}

interface MessagePayload {
  content: string;
  citations: KnowledgeSearchCitation[];
  retrievalMode: KnowledgeSearchMode | null;
}

interface ProjectRow {
  workspace_root: string;
}

const DEFAULT_HISTORY_LIMIT = 50;

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Knowledge chat ${label} must not be empty`);
  }
}

function requirePositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error(`Knowledge chat ${label} must be a positive integer`);
  }
}

function rowToConversation(row: ConversationRow): KnowledgeConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversationRelativePath(conversationId: string, messageId: string): string {
  return `conversations/${conversationId}/${messageId}.json`;
}

/**
 * Knowledge chat conversations and messages are project-scoped, versionless
 * records. Message bodies (which may be large and are never queried by SQL)
 * are stored as JSON files under the project workspace root, mirroring how
 * generated pages keep rendered content on disk while SQLite indexes
 * metadata only.
 */
export class KnowledgeChatService {
  private readonly historyLimit: number;
  private readonly now: () => string;
  private readonly redact: (value: string) => string;
  private readonly activeStreams = new Map<string, AbortController>();

  public constructor(
    private readonly db: Database.Database,
    private readonly providers: KnowledgeProviderRegistry,
    private readonly chatProvider: KnowledgeChatProvider,
    options: KnowledgeChatServiceOptions = {},
  ) {
    requirePositiveInteger(options.historyLimit, 'history limit');
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    this.now = options.now ?? nowIso;
    this.redact = (value: string) => redactKnowledgeProviderPayload(value, options.redact);
  }

  public createConversation(input: CreateKnowledgeConversationInput): KnowledgeConversationRecord {
    requireNonEmpty(input.projectId, 'project ID');
    if (input.title !== undefined && input.title !== null) requireNonEmpty(input.title, 'title');

    const record = {
      id: createKnowledgeId('conversation'),
      projectId: input.projectId,
      title: input.title ?? null,
      createdAt: input.createdAt ?? this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO knowledge_conversations (id, project_id, title, created_at, updated_at)
         VALUES (@id, @projectId, @title, @createdAt, @createdAt)`,
      )
      .run(record);
    return this.requireConversation(record.id);
  }

  public getConversation(conversationId: string): KnowledgeConversationRecord {
    requireNonEmpty(conversationId, 'conversation ID');
    return this.requireConversation(conversationId);
  }

  public listConversations(
    projectId: string,
    options: ListKnowledgeConversationsOptions = {},
  ): KnowledgeConversationRecord[] {
    requireNonEmpty(projectId, 'project ID');
    requirePositiveInteger(options.limit, 'list limit');
    const limitClause = options.limit === undefined ? '' : ' LIMIT @limit';
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_conversations
         WHERE project_id = @projectId
         ORDER BY updated_at DESC, id ASC${limitClause}`,
      )
      .all({ projectId, limit: options.limit }) as ConversationRow[];
    return rows.map(rowToConversation);
  }

  public renameConversation(conversationId: string, title: string | null): KnowledgeConversationRecord {
    requireNonEmpty(conversationId, 'conversation ID');
    if (title !== null) requireNonEmpty(title, 'title');
    this.requireConversation(conversationId);
    this.db
      .prepare(
        `UPDATE knowledge_conversations SET title = @title, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({ id: conversationId, title, updatedAt: this.now() });
    return this.requireConversation(conversationId);
  }

  public deleteConversation(conversationId: string): void {
    requireNonEmpty(conversationId, 'conversation ID');
    const conversation = this.requireConversation(conversationId);
    const workspaceRoot = this.workspaceRoot(conversation.projectId);
    this.db.prepare('DELETE FROM knowledge_conversations WHERE id = ?').run(conversationId);
    rmSync(path.join(workspaceRoot, 'conversations', conversationId), { recursive: true, force: true });
  }

  public listMessages(
    conversationId: string,
    options: ListKnowledgeMessagesOptions = {},
  ): KnowledgeChatMessageRecord[] {
    requireNonEmpty(conversationId, 'conversation ID');
    requirePositiveInteger(options.limit, 'list limit');
    const conversation = this.requireConversation(conversationId);
    const workspaceRoot = this.workspaceRoot(conversation.projectId);
    const rows = this.messageRows(conversationId);
    const ordered = options.limit === undefined ? rows : rows.slice(-options.limit);
    return ordered.map((row) => this.readMessage(workspaceRoot, row));
  }

  public getMessage(messageId: string): KnowledgeChatMessageRecord {
    requireNonEmpty(messageId, 'message ID');
    const row = this.messageRow(messageId);
    const workspaceRoot = this.workspaceRoot(row.project_id);
    return this.readMessage(workspaceRoot, row);
  }

  public cancel(messageId: string): boolean {
    requireNonEmpty(messageId, 'message ID');
    const controller = this.activeStreams.get(messageId);
    if (controller === undefined) return false;
    controller.abort();
    return true;
  }

  public streamKnowledgeChat(input: StreamKnowledgeChatInput): AsyncIterable<KnowledgeChatEvent> {
    requireNonEmpty(input.conversationId, 'conversation ID');
    requireNonEmpty(input.query, 'query');
    const conversation = this.requireConversation(input.conversationId);
    return this.runStream({
      conversation,
      query: input.query,
      mode: input.mode ?? 'hybrid',
      persistUserMessage: true,
      taskStore: input.taskStore,
      limit: input.limit,
      maxGraphExpansions: input.maxGraphExpansions,
      tokenBudget: input.tokenBudget,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  public regenerateKnowledgeChat(input: RegenerateKnowledgeChatInput): AsyncIterable<KnowledgeChatEvent> {
    requireNonEmpty(input.messageId, 'message ID');
    const targetRow = this.messageRow(input.messageId);
    if (targetRow.role !== 'assistant') {
      throw new Error('Knowledge chat regeneration requires an assistant message');
    }
    const conversation = this.requireConversation(targetRow.conversation_id);
    const workspaceRoot = this.workspaceRoot(conversation.projectId);
    const priorUser = this.messageRows(conversation.id)
      .filter((row) => row.role === 'user' && row.created_at <= targetRow.created_at)
      .pop();
    if (priorUser === undefined) {
      throw new Error(`Knowledge chat message has no prior user turn: ${input.messageId}`);
    }
    const userPayload = this.readPayload(workspaceRoot, priorUser.content_path);

    this.deleteMessageRow(workspaceRoot, targetRow);

    return this.runStream({
      conversation,
      query: userPayload.content,
      mode: userPayload.retrievalMode ?? 'hybrid',
      persistUserMessage: false,
      taskStore: input.taskStore,
      limit: input.limit,
      maxGraphExpansions: input.maxGraphExpansions,
      tokenBudget: input.tokenBudget,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
  }

  public saveMessageToPage(input: SaveKnowledgeChatMessageToPageInput): KnowledgePageVersion {
    requireNonEmpty(input.messageId, 'message ID');
    requireNonEmpty(input.title, 'title');
    requireNonEmpty(input.slug, 'slug');
    const message = this.getMessage(input.messageId);
    const workspaceRoot = this.workspaceRoot(message.projectId);

    const provenance: KnowledgeProvenanceRef[] = message.citations
      .filter((citation) => citation.sourceId !== null)
      .map((citation) => ({
        kind: 'source',
        id: citation.sourceId as string,
        path: citation.path ?? undefined,
      }));

    const contentPath = pageContentPath(input.type, input.slug);
    const outputRoot = this.knowledgeOutputRoot(workspaceRoot);
    const outputPath = path.resolve(outputRoot, contentPath);
    if (!isPathWithinRoot(outputRoot, outputPath)) {
      throw new Error('Knowledge chat page path must stay within the knowledge output root');
    }
    assertNoSymlinkComponents(outputRoot, outputPath, 'Knowledge chat page path');
    const versionInput: CreatePageVersionInput = {
      projectId: message.projectId,
      type: input.type,
      title: input.title,
      slug: input.slug,
      content: message.content,
      contentPath,
      summary: input.summary,
      provenance,
      generatorVersion: input.generatorVersion ?? 'knowledge-chat',
    };
    const version = createPageVersion(this.db, versionInput);
    writeKnowledgePageFile(outputPath, message.content);
    return version;
  }

  private knowledgeOutputRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.ariadne', 'knowledge');
  }

  private async *runStream(params: {
    conversation: KnowledgeConversationRecord;
    query: string;
    mode: KnowledgeSearchMode;
    persistUserMessage: boolean;
    taskStore?: TaskStore;
    limit?: number;
    maxGraphExpansions?: number;
    tokenBudget?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<KnowledgeChatEvent> {
    const { conversation } = params;
    const workspaceRoot = this.workspaceRoot(conversation.projectId);

    if (params.persistUserMessage) {
      this.writeMessage(workspaceRoot, {
        id: createKnowledgeId('message'),
        projectId: conversation.projectId,
        conversationId: conversation.id,
        role: 'user',
        content: this.redact(params.query),
        citations: [],
        retrievalMode: params.mode,
        createdAt: this.now(),
      });
      this.touchConversation(conversation.id);
    }

    const assistantMessageId = createKnowledgeId('message');
    const controller = new AbortController();
    if (params.signal !== undefined) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    this.activeStreams.set(assistantMessageId, controller);

    try {
      let searchResults;
      try {
        searchResults = searchKnowledge(params.query, {
          db: this.db,
          projectId: conversation.projectId,
          mode: params.mode,
          taskStore: params.taskStore,
          limit: params.limit,
          maxGraphExpansions: params.maxGraphExpansions,
        });
      } catch (error) {
        yield { type: 'error', messageId: assistantMessageId, message: this.errorMessage(error) };
        return;
      }

      const searchContext = buildKnowledgeSearchContext(searchResults, { tokenBudget: params.tokenBudget });
      const citations = dedupeCitations(searchContext.results.flatMap((result) => result.citations));

      let providerId: string;
      try {
        providerId = this.providers.require('chat').id;
      } catch (error) {
        yield { type: 'error', messageId: assistantMessageId, message: this.errorMessage(error) };
        return;
      }

      yield {
        type: 'meta',
        conversationId: conversation.id,
        messageId: assistantMessageId,
        retrievalMode: params.mode,
        providerId,
        resultCount: searchContext.results.length,
        citationCount: citations.length,
      };

      for (const citation of citations) {
        yield { type: 'citation', messageId: assistantMessageId, citation };
      }

      const history = this.messageRows(conversation.id)
        .slice(-this.historyLimit)
        .map((row) => this.readMessage(workspaceRoot, row))
        .map((message) => ({ role: message.role, content: message.content }));

      let iterable: AsyncIterable<string>;
      try {
        iterable = await this.providers.execute(
          'chat',
          (context) =>
            this.chatProvider(
              {
                conversationId: conversation.id,
                query: params.query,
                mode: params.mode,
                history,
                searchContext,
              },
              context,
            ),
          { timeoutMs: params.timeoutMs, redact: this.redact },
        );
      } catch (error) {
        yield { type: 'error', messageId: assistantMessageId, message: this.errorMessage(error) };
        return;
      }

      let assembled = '';
      try {
        for await (const delta of iterable) {
          if (controller.signal.aborted) break;
          assembled += delta;
          yield { type: 'delta', messageId: assistantMessageId, text: delta };
        }
      } catch (error) {
        yield { type: 'error', messageId: assistantMessageId, message: this.errorMessage(error) };
        return;
      }

      if (controller.signal.aborted) {
        yield { type: 'cancelled', messageId: assistantMessageId };
        return;
      }

      const record = this.writeMessage(workspaceRoot, {
        id: assistantMessageId,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        role: 'assistant',
        content: this.redact(assembled),
        citations,
        retrievalMode: params.mode,
        createdAt: this.now(),
      });
      this.touchConversation(conversation.id);
      this.trimHistory(workspaceRoot, conversation.id);

      yield { type: 'done', messageId: assistantMessageId, message: record };
    } finally {
      this.activeStreams.delete(assistantMessageId);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? this.redact(error.message) : 'Knowledge chat provider failed';
  }

  private requireConversation(conversationId: string): KnowledgeConversationRecord {
    const row = this.db
      .prepare('SELECT * FROM knowledge_conversations WHERE id = ?')
      .get(conversationId) as ConversationRow | undefined;
    if (row === undefined) {
      throw new Error(`Knowledge conversation not found: ${conversationId}`);
    }
    return rowToConversation(row);
  }

  private touchConversation(conversationId: string): void {
    this.db
      .prepare('UPDATE knowledge_conversations SET updated_at = @updatedAt WHERE id = @id')
      .run({ id: conversationId, updatedAt: this.now() });
  }

  private messageRow(messageId: string): MessageRow {
    const row = this.db
      .prepare('SELECT * FROM knowledge_messages WHERE id = ?')
      .get(messageId) as MessageRow | undefined;
    if (row === undefined) {
      throw new Error(`Knowledge chat message not found: ${messageId}`);
    }
    return row;
  }

  private messageRows(conversationId: string): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM knowledge_messages
         WHERE conversation_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(conversationId) as MessageRow[];
  }

  private workspaceRoot(projectId: string): string {
    const row = this.db
      .prepare('SELECT workspace_root FROM knowledge_projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    if (row === undefined) {
      throw new Error(`Knowledge project not found: ${projectId}`);
    }
    return row.workspace_root;
  }

  private writeMessage(
    workspaceRoot: string,
    input: {
      id: string;
      projectId: string;
      conversationId: string;
      role: KnowledgeChatRole;
      content: string;
      citations: KnowledgeSearchCitation[];
      retrievalMode: KnowledgeSearchMode | null;
      createdAt: string;
    },
  ): KnowledgeChatMessageRecord {
    const relativePath = conversationRelativePath(input.conversationId, input.id);
    this.writePayload(workspaceRoot, relativePath, {
      content: input.content,
      citations: input.citations,
      retrievalMode: input.retrievalMode,
    });
    this.db
      .prepare(
        `INSERT INTO knowledge_messages (id, project_id, conversation_id, role, content_path, created_at)
         VALUES (@id, @projectId, @conversationId, @role, @contentPath, @createdAt)`,
      )
      .run({
        id: input.id,
        projectId: input.projectId,
        conversationId: input.conversationId,
        role: input.role,
        contentPath: relativePath,
        createdAt: input.createdAt,
      });
    return {
      id: input.id,
      projectId: input.projectId,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      citations: input.citations,
      retrievalMode: input.retrievalMode,
      createdAt: input.createdAt,
    };
  }

  private readMessage(workspaceRoot: string, row: MessageRow): KnowledgeChatMessageRecord {
    const payload = this.readPayload(workspaceRoot, row.content_path);
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      role: row.role,
      content: payload.content,
      citations: payload.citations,
      retrievalMode: payload.retrievalMode,
      createdAt: row.created_at,
    };
  }

  private writePayload(workspaceRoot: string, relativePath: string, payload: MessagePayload): void {
    const absolutePath = path.join(workspaceRoot, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(payload), { encoding: 'utf8', flag: 'w' });
  }

  private readPayload(workspaceRoot: string, relativePath: string): MessagePayload {
    const raw = readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
    return JSON.parse(raw) as MessagePayload;
  }

  private deleteMessageRow(workspaceRoot: string, row: MessageRow): void {
    this.db.prepare('DELETE FROM knowledge_messages WHERE id = ?').run(row.id);
    rmSync(path.join(workspaceRoot, row.content_path), { force: true });
  }

  private trimHistory(workspaceRoot: string, conversationId: string): void {
    const rows = this.messageRows(conversationId);
    const overflow = rows.length - this.historyLimit;
    if (overflow <= 0) return;
    for (const row of rows.slice(0, overflow)) {
      this.deleteMessageRow(workspaceRoot, row);
    }
  }
}

function pageContentPath(type: string, slug: string): string {
  const normalizedType = type.trim();
  const normalizedSlug = slug.trim().replace(/\\/g, '/');
  if (
    !/^[a-z0-9_-]+$/i.test(normalizedType) ||
    !normalizedSlug ||
    normalizedSlug.split('/').some((part) => !/^[a-z0-9._-]+$/i.test(part) || part === '.' || part === '..')
  ) {
    throw new Error('Knowledge chat page type and slug must be safe path components');
  }
  return `pages/${normalizedType}/${normalizedSlug}.md`;
}

function writeKnowledgePageFile(absolutePath: string, content: string): void {
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'w' });
}

function dedupeCitations(citations: KnowledgeSearchCitation[]): KnowledgeSearchCitation[] {
  const seen = new Set<string>();
  const deduped: KnowledgeSearchCitation[] = [];
  for (const citation of citations) {
    const key = [
      citation.pageId ?? '',
      citation.sourceId ?? '',
      citation.path ?? '',
      citation.url ?? '',
      citation.span?.id ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(citation);
  }
  return deduped;
}
