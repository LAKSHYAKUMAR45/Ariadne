import type { Task } from '../types.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgePage } from './KnowledgePageStore.js';
import { KnowledgePageStore } from './KnowledgePageStore.js';
import { KnowledgeQueue } from './KnowledgeQueue.js';
import { KnowledgeSourceStore } from './KnowledgeSourceStore.js';
import type { KnowledgeSourceRecord } from './KnowledgeTypes.js';
import type { TaskStore } from '../TaskStore.js';
import type { ResearchProvider, ResearchResult } from './research/ResearchProviders.js';

export type ResearchRequestStatus = 'pending_confirmation' | 'confirmed' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface CreateResearchRequestInput {
  projectId: string;
  query: string;
  parentTaskId?: string;
  createChildTask?: boolean;
}

export interface ResearchRequest {
  id: string;
  projectId: string;
  query: string;
  parentTaskId: string | null;
  createChildTask: boolean;
  status: ResearchRequestStatus;
  createdAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  completedAt: string | null;
}

export interface ResearchSynthesisPage extends KnowledgePage {
  content: string;
}

export interface ResearchRunResult {
  request: ResearchRequest;
  sources: KnowledgeSourceRecord[];
  synthesisPage: ResearchSynthesisPage;
  childTask: Task | null;
}

export interface KnowledgeResearchServiceOptions {
  provider?: ResearchProvider;
  sourceStore: KnowledgeSourceStore;
  pageStore: KnowledgePageStore;
  queue: KnowledgeQueue;
  taskStore?: TaskStore;
  timeoutMs?: number;
}

export class ResearchConfirmationRequiredError extends Error {
  constructor(readonly requestId: string) {
    super(`Research request requires confirmation: ${requestId}`);
    this.name = 'ResearchConfirmationRequiredError';
  }
}

export class ResearchRequestCancelledError extends Error {
  constructor(readonly requestId: string) {
    super(`Research request was cancelled: ${requestId}`);
    this.name = 'ResearchRequestCancelledError';
  }
}

export class ResearchProviderRequiredError extends Error {
  constructor() {
    super('A research provider must be configured before research can run.');
    this.name = 'ResearchProviderRequiredError';
  }
}

export class ResearchProviderTimeoutError extends Error {
  constructor(readonly providerId: string, readonly timeoutMs: number) {
    super(`Research provider "${providerId}" timed out after ${timeoutMs}ms.`);
    this.name = 'ResearchProviderTimeoutError';
  }
}

export class ResearchRateLimitError extends Error {
  constructor(readonly providerId: string, readonly retryAfterMs?: number) {
    super(`Research provider "${providerId}" is rate limited.`);
    this.name = 'ResearchRateLimitError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`Research request ${label} must not be empty`);
  return normalized;
}

function validateTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new Error('Research timeout must be a positive integer');
  }
}

function requestCopy(request: ResearchRequest): ResearchRequest {
  return { ...request };
}

function researchSlug(query: string): string {
  const slug = query
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? `research-${slug}` : 'research-query';
}

function sourceContent(result: ResearchResult): string {
  return `# ${escapeMarkdownText(result.title)}\n\n${escapeMarkdownText(result.snippet)}`;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+!|])/g, '\\$1');
}

function rateLimitDetails(error: unknown): { limited: boolean; retryAfterMs?: number } {
  if (typeof error !== 'object' || error === null) return { limited: false };
  const value = error as Record<string, unknown>;
  if (value.status !== 429 && value.statusCode !== 429) return { limited: false };
  return {
    limited: true,
    retryAfterMs: typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0
      ? value.retryAfterMs
      : undefined,
  };
}

function synthesisContent(query: string, results: readonly ResearchResult[]): string {
  return [
    `# Research: ${escapeMarkdownText(query)}`,
    '',
    ...results.map((result) =>
      `- [${escapeMarkdownText(result.title)}](${result.url})${result.snippet ? `: ${escapeMarkdownText(result.snippet)}` : ''}`,
    ),
  ].join('\n');
}

/**
 * Coordinates explicit-consent research with provider-neutral adapters and
 * ordinary source/page persistence. No provider is configured by default.
 */
export class KnowledgeResearchService {
  private readonly requests = new Map<string, ResearchRequest>();
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly options: KnowledgeResearchServiceOptions) {
    validateTimeout(options.timeoutMs);
  }

  public createResearchRequest(input: CreateResearchRequestInput): ResearchRequest {
    const request: ResearchRequest = {
      id: createKnowledgeId('research'),
      projectId: requireNonEmpty(input.projectId, 'project ID'),
      query: requireNonEmpty(input.query, 'query'),
      parentTaskId: input.parentTaskId === undefined ? null : requireNonEmpty(input.parentTaskId, 'parent task ID'),
      createChildTask: input.createChildTask ?? false,
      status: 'pending_confirmation',
      createdAt: now(),
      confirmedAt: null,
      cancelledAt: null,
      completedAt: null,
    };
    this.requests.set(request.id, request);
    return requestCopy(request);
  }

  public confirmResearchRequest(requestId: string): ResearchRequest {
    const request = this.requireRequest(requestId);
    if (request.status !== 'pending_confirmation') {
      throw new Error(`Cannot confirm research request from ${request.status} state`);
    }
    request.status = 'confirmed';
    request.confirmedAt = now();
    return requestCopy(request);
  }

  public cancelResearchRequest(requestId: string): ResearchRequest {
    const request = this.requireRequest(requestId);
    if (request.status !== 'pending_confirmation' && request.status !== 'confirmed' && request.status !== 'running') {
      throw new Error(`Cannot cancel research request from ${request.status} state`);
    }
    request.status = 'cancelled';
    request.cancelledAt = now();
    this.controllers.get(requestId)?.abort();
    return requestCopy(request);
  }

  public async runResearchRequest(requestId: string): Promise<ResearchRunResult> {
    const request = this.requireRequest(requestId);
    if (request.status === 'pending_confirmation') throw new ResearchConfirmationRequiredError(requestId);
    if (request.status === 'cancelled') throw new ResearchRequestCancelledError(requestId);
    if (request.status !== 'confirmed') throw new Error(`Cannot run research request from ${request.status} state`);
    if (this.options.provider === undefined) throw new ResearchProviderRequiredError();

    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    request.status = 'running';

    try {
      const results = await this.searchWithTimeout(this.options.provider, request.query, controller);
      this.throwIfCancelled(request);
      const sources = this.ingestResults(request, results);
      this.throwIfCancelled(request);
      const synthesisPage = this.createSynthesisPage(request, results, sources);
      const childTask = this.createChildTask(request);
      request.status = 'completed';
      request.completedAt = now();
      return { request: requestCopy(request), sources, synthesisPage, childTask };
    } catch (error: unknown) {
      if (this.isCancelled(requestId) || controller.signal.aborted && !(error instanceof ResearchProviderTimeoutError)) {
        throw new ResearchRequestCancelledError(requestId);
      }
      request.status = 'failed';
      request.completedAt = now();
      const rateLimit = rateLimitDetails(error);
      if (rateLimit.limited) {
        throw new ResearchRateLimitError(this.options.provider.id, rateLimit.retryAfterMs);
      }
      throw error;
    } finally {
      this.controllers.delete(requestId);
    }
  }

  private async searchWithTimeout(
    provider: ResearchProvider,
    query: string,
    controller: AbortController,
  ): Promise<ResearchResult[]> {
    const search = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Research search was cancelled before provider invocation');
      return provider.search(query, controller.signal);
    });
    if (this.options.timeoutMs === undefined) return search;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new ResearchProviderTimeoutError(provider.id, this.options.timeoutMs!));
      }, this.options.timeoutMs);
    });
    try {
      return await Promise.race([search, elapsed]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private ingestResults(request: ResearchRequest, results: readonly ResearchResult[]): KnowledgeSourceRecord[] {
    const sources: KnowledgeSourceRecord[] = [];
    for (const result of results) {
      this.throwIfCancelled(request);
      const source = this.options.sourceStore.register({
        projectId: request.projectId,
        kind: 'url',
        url: result.url,
        content: sourceContent(result),
        format: 'markdown',
        mimeType: 'text/markdown',
      });
      const version = this.options.sourceStore.currentVersion(request.projectId, source.id);
      if (version === null) throw new Error(`Research source version was not created: ${source.id}`);
      this.options.queue.enqueue({
        projectId: request.projectId,
        jobKind: 'research-source',
        sourceVersionId: version.id,
        payload: { researchRequestId: request.id, url: result.url },
      });
      sources.push(source);
    }
    return sources;
  }

  private createSynthesisPage(
    request: ResearchRequest,
    results: readonly ResearchResult[],
    sources: readonly KnowledgeSourceRecord[],
  ): ResearchSynthesisPage {
    const sourceVersionIds = sources.flatMap((source) => {
      const version = this.options.sourceStore.currentVersion(request.projectId, source.id);
      return version === null ? [] : [version.id];
    });
    const content = synthesisContent(request.query, results);
    const version = this.options.pageStore.createPageVersion({
      projectId: request.projectId,
      type: 'synthesis',
      title: `Research: ${request.query}`,
      slug: researchSlug(request.query),
      content,
      summary: `Research synthesis for ${request.query}`,
      sourceVersionIds,
      provenance: sources.map((source) => ({ kind: 'source', id: source.id, confidence: 1 })),
    });
    const page = this.options.pageStore.getCurrentPage(request.projectId, version.pageId);
    if (page === null) throw new Error(`Research synthesis page was not created: ${version.pageId}`);
    return { ...page, content };
  }

  private createChildTask(request: ResearchRequest): Task | null {
    if (!request.createChildTask || this.options.taskStore === undefined) return null;
    return this.options.taskStore.createTask({
      title: `Research: ${request.query}`,
      goal: `Research findings for knowledge project ${request.projectId}`,
      parentTaskId: request.parentTaskId,
    });
  }

  private throwIfCancelled(request: ResearchRequest): void {
    if (request.status === 'cancelled') throw new ResearchRequestCancelledError(request.id);
  }

  private requireRequest(requestId: string): ResearchRequest {
    const request = this.requests.get(requestId);
    if (request === undefined) throw new Error(`Research request not found: ${requestId}`);
    return request;
  }

  private isCancelled(requestId: string): boolean {
    return this.requests.get(requestId)?.status === 'cancelled';
  }
}

export function createResearchRequest(
  service: KnowledgeResearchService,
  input: CreateResearchRequestInput,
): ResearchRequest {
  return service.createResearchRequest(input);
}

export function confirmResearchRequest(service: KnowledgeResearchService, requestId: string): ResearchRequest {
  return service.confirmResearchRequest(requestId);
}

export function cancelResearchRequest(service: KnowledgeResearchService, requestId: string): ResearchRequest {
  return service.cancelResearchRequest(requestId);
}

export function runResearchRequest(service: KnowledgeResearchService, requestId: string): Promise<ResearchRunResult> {
  return service.runResearchRequest(requestId);
}
