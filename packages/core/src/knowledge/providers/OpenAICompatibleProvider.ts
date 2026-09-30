import type Database from 'better-sqlite3';
import {
  type KnowledgeAnalysis,
  type KnowledgeAnalysisSourceSpan,
  type KnowledgeGeneration,
  validateKnowledgeAnalysis,
  validateKnowledgeGeneration,
} from '../KnowledgeAnalysis.js';
import type { DeterministicExtraction, KnowledgeSourceSpan } from '../KnowledgeExtraction.js';
import type {
  KnowledgeProviderDiagnostic,
  KnowledgeProviderCredentialPolicy,
  KnowledgeProviderProfile,
  ResolveKnowledgeProviderApiKeyResult,
  KnowledgeProviderTestAdapter,
  KnowledgeProviderTestAdapterInput,
  KnowledgeProviderTestAdapterResult,
} from '../KnowledgeProviderProfiles.js';
import {
  KnowledgeProviderProfileStore,
  normalizeOpenAICompatibleEndpoint,
  resolveKnowledgeProviderApiKey,
} from '../KnowledgeProviderProfiles.js';
import {
  classifyProviderEndpointIp,
  parseCanonicalIpLiteral,
  tryParseCanonicalIpLiteral,
} from '../ProviderEndpointIpPolicy.js';
import type { KnowledgePageVersion } from '../KnowledgePageStore.js';
import { KnowledgePageStore } from '../KnowledgePageStore.js';
import type {
  KnowledgeEnrichmentInput,
  KnowledgeEnrichmentResult,
  KnowledgeEnrichmentReviewInput,
  KnowledgeEnrichmentService,
} from '../KnowledgeWorker.js';
import { KnowledgeProviderCallError } from '../KnowledgeProviderFallback.js';
import { redact, redactLines } from '../../Redactor.js';

const MAX_REQUEST_SYSTEM_PROMPT_LENGTH = 2_000;
const MAX_REQUEST_PROMPT_BYTES = 12_000;
const MAX_RESPONSE_BODY_BYTES = 80_000;
const MAX_RESPONSE_CONTENT_BYTES = 20_000;
const MAX_RESPONSE_DEPTH = 12;
const MAX_RESPONSE_ENTRIES = 512;
const MAX_RESPONSE_ARRAY_ITEMS = 256;
const MAX_EXCERPT_LENGTH = 280;
const MAX_SECTION_COUNT = 6;
const MAX_SECTION_TEXT_LENGTH = 240;
const MAX_SYMBOL_COUNT = 12;
const MAX_RELATIONSHIP_COUNT = 12;
const MAX_PAGE_COUNT = 4;
const MAX_PAGE_CONTENT_LENGTH = 480;
const MAX_ALLOWED_SOURCE_SPANS = 256;
const MAX_SOURCE_PATH_LENGTH = 512;
const TRUNCATION_SUFFIX = ' …[truncated]';

export interface OpenAICompatibleGroundingInput {
  sourceId: string;
  sourceVersionId: string;
  sourceSpans: readonly KnowledgeAnalysisSourceSpan[];
}

export interface OpenAICompatibleAnalyzeInput {
  profile: KnowledgeProviderProfile;
  environment: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt?: string;
  sourceId: string;
  sourceVersionId: string;
  sourceSpans: readonly KnowledgeAnalysisSourceSpan[];
  signal?: AbortSignal;
}

export interface OpenAICompatibleGenerateInput {
  profile: KnowledgeProviderProfile;
  environment: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt?: string;
  sourceId: string;
  sourceVersionId: string;
  sourceSpans: readonly KnowledgeAnalysisSourceSpan[];
  signal?: AbortSignal;
}

export interface OpenAICompatibleCompleteJsonInput {
  profile: KnowledgeProviderProfile;
  environment: NodeJS.ProcessEnv;
  prompt: string;
  systemPrompt: string;
  signal?: AbortSignal;
}

export interface OpenAICompatibleProviderResult<T> {
  value: T;
  warnings: KnowledgeProviderDiagnostic[];
}

export interface OpenAICompatibleProviderOptions {
  fetchImplementation?: typeof fetch;
  transport?: OpenAICompatibleTransport;
  credentialPolicy?: KnowledgeProviderCredentialPolicy;
  hostPolicy?: OpenAICompatibleHostPolicy;
}

export interface OpenAICompatibleEnrichmentServiceOptions {
  profileStore: KnowledgeProviderProfileStore;
  provider?: OpenAICompatibleProvider;
  environment?: NodeJS.ProcessEnv;
  credentialPolicy?: KnowledgeProviderCredentialPolicy;
  hostPolicy?: OpenAICompatibleHostPolicy;
  transport?: OpenAICompatibleTransport;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface OpenAICompatibleResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface OpenAICompatibleTransportRequest {
  url: string;
  method: string;
  redirect: RequestRedirect;
  signal: AbortSignal;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface OpenAICompatiblePinnedTransportRequest {
  origin: string;
  originalHostname: string;
  protocol: 'http:' | 'https:';
  port: number;
  path: string;
  signal: AbortSignal;
  tlsServername: string | null;
  buildValidatedRequest(input: {
    resolvedAddresses: readonly OpenAICompatibleResolvedAddress[];
    selectedAddress: OpenAICompatibleResolvedAddress;
  }): Promise<OpenAICompatibleValidatedPinnedTransportRequest>;
}

export interface OpenAICompatiblePinnedConnectionTarget {
  address: OpenAICompatibleResolvedAddress;
  protocol: 'http:' | 'https:';
  port: number;
  hostHeader: string;
  tlsServername: string | null;
}

export interface OpenAICompatiblePinnedRequestPayload {
  method: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
  path: string;
}

export interface OpenAICompatibleValidatedPinnedTransportRequest {
  approvedAddresses: readonly OpenAICompatibleResolvedAddress[];
  connectionTarget: OpenAICompatiblePinnedConnectionTarget;
  payload: OpenAICompatiblePinnedRequestPayload;
}

function hasMatchingResolvedAddress(
  selectedAddress: OpenAICompatibleResolvedAddress,
  resolvedAddresses: readonly OpenAICompatibleResolvedAddress[],
): boolean {
  return resolvedAddresses.some(
    (candidate) => candidate.address === selectedAddress.address && candidate.family === selectedAddress.family,
  );
}

function hostHeaderForUrl(url: URL): string {
  if (url.port === '') {
    return url.hostname;
  }
  return `${url.hostname}:${url.port}`;
}

function requestPathForUrl(url: URL): string {
  const path = `${url.pathname}${url.search}`;
  return path === '' ? '/' : path;
}

function toPinnedConnectionTarget(
  url: URL,
  protocol: 'http:' | 'https:',
  port: number,
  tlsServername: string | null,
  selectedAddress: OpenAICompatibleResolvedAddress,
): OpenAICompatiblePinnedConnectionTarget {
  return {
    address: selectedAddress,
    protocol,
    port,
    hostHeader: hostHeaderForUrl(url),
    tlsServername,
  };
}

export interface OpenAICompatibleTransport {
  request(input: OpenAICompatibleTransportRequest): Promise<Response>;
  requestPinned?(input: OpenAICompatiblePinnedTransportRequest): Promise<Response>;
}

export interface OpenAICompatibleHostPolicy {
  allowedOrigins?: ReadonlySet<string>;
  isOriginAllowed?: (input: {
    origin: string;
    profile: KnowledgeProviderProfile;
    hasCredentials: boolean;
  }) => boolean;
}

function sanitizeExcerpt(value: string, maxLength = MAX_EXCERPT_LENGTH): string {
  const redacted = redact(value)
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'Authorization: Bearer ***')
    .replace(/\bbearer\s+\S+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= maxLength) {
    return redacted;
  }
  return `${redacted.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function boundedText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function redactedPromptField(value: string, maxLength: number): { value: string; truncated: boolean } {
  const redacted = redactLines(value);
  const bounded = boundedText(redacted, maxLength);
  return { value: bounded, truncated: bounded !== redacted.trim() };
}

function redactedPromptText(value: string, maxLength: number): string {
  return redactedPromptField(value, maxLength).value;
}

function redactedPromptValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactLines(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactedPromptValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactedPromptValue(entry)]),
    );
  }
  return value;
}

function redactedPromptSpan(span: KnowledgeAnalysisSourceSpan): KnowledgeAnalysisSourceSpan {
  return {
    ...span,
    ...(span.label ? { label: redactLines(span.label) } : {}),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Request aborted'));
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Request aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function composeSignals(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  controller: AbortController;
  release(): void;
  timeoutReached(): boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;
  if (parent?.aborted) {
    controller.abort(parent.reason);
    return {
      signal: controller.signal,
      controller,
      release: () => {},
      timeoutReached: () => didTimeout,
    };
  }
  const onAbort = (): void => controller.abort(parent?.reason);
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    controller,
    release: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
    timeoutReached: () => didTimeout,
  };
}

function safeParseJson(text: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${sanitizeExcerpt(error instanceof Error ? error.message : String(error))}`);
  }
  return sanitizeParsedValue(parsed, 0);
}

function sanitizeParsedValue(value: unknown, depth: number): unknown {
  if (depth > MAX_RESPONSE_DEPTH) {
    throw new Error('Provider JSON exceeds the maximum nesting depth');
  }
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_RESPONSE_ARRAY_ITEMS) {
      throw new Error('Provider JSON array exceeds the maximum supported length');
    }
    return value.map((entry) => sanitizeParsedValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_RESPONSE_ENTRIES) {
      throw new Error('Provider JSON object exceeds the maximum supported size');
    }
    const sanitized: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of entries) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error(`Provider JSON contains unsafe key: ${key}`);
      }
      sanitized[key] = sanitizeParsedValue(entry, depth + 1);
    }
    return sanitized;
  }
  throw new Error('Provider JSON contains unsupported values');
}

function extractResponseContent(parsed: unknown): string {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Provider response must be an object');
  }
  const choices = (parsed as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Provider response choices must be a non-empty array');
  }
  const first = choices[0];
  if (first === null || typeof first !== 'object' || Array.isArray(first)) {
    throw new Error('Provider response choice must be an object');
  }
  const message = (first as Record<string, unknown>).message;
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Provider response message must be an object');
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Provider response message content must be a non-empty string');
  }
  if (utf8ByteLength(content) > MAX_RESPONSE_CONTENT_BYTES) {
    throw new Error('Provider response content exceeds the maximum supported size');
  }
  return content;
}

function validatePinnedResolvedAddress(address: OpenAICompatibleResolvedAddress): OpenAICompatibleResolvedAddress {
  const parsed = parseCanonicalIpLiteral(address.address);
  if (parsed.family !== address.family) {
    throw new Error(
      `Provider transport declared address family IPv${address.family} for pinned literal ${address.address}, but parsed IPv${parsed.family}`,
    );
  }
  if (parsed.isMappedIpv6) {
    throw new Error(`Provider transport must not use IPv4-mapped IPv6 pinned addresses (${address.address})`);
  }
  return {
    address: parsed.address,
    family: parsed.family,
  };
}

function sourceSpanFingerprint(span: KnowledgeAnalysisSourceSpan): string {
  return [
    span.sourceId,
    span.sourceVersionId ?? '',
    span.startOffset,
    span.endOffset,
    span.startLine,
    span.startColumn,
    span.endLine,
    span.endColumn,
    span.label ?? '',
  ].join('\0');
}

function groundingSpanFingerprint(span: KnowledgeAnalysisSourceSpan): string {
  return [
    span.sourceId,
    span.sourceVersionId ?? '',
    span.startOffset,
    span.endOffset,
    span.startLine,
    span.startColumn,
    span.endLine,
    span.endColumn,
  ].join('\0');
}

function ensureGroundedAnalysis(
  analysis: KnowledgeAnalysis,
  grounding: OpenAICompatibleGroundingInput,
): KnowledgeAnalysis {
  const allowedSourceIds = new Set([grounding.sourceId]);
  const allowedSpanFingerprints = new Set(grounding.sourceSpans.map(groundingSpanFingerprint));
  const validateSourceIds = (sourceIds: readonly string[], label: string): void => {
    for (const sourceId of sourceIds) {
      if (!allowedSourceIds.has(sourceId)) {
        throw new Error(`Provider ${label} references an unknown source ID`);
      }
    }
  };
  const validateRequiredSpans = (spans: readonly KnowledgeAnalysisSourceSpan[] | undefined, label: string): void => {
    if (!spans || spans.length === 0) {
      throw new Error(`Provider ${label} must include at least one grounded source span`);
    }
    for (const span of spans) {
      if (!allowedSpanFingerprints.has(groundingSpanFingerprint(span))) {
        throw new Error(`Provider ${label} must use exact source spans from the deterministic input`);
      }
      if (span.sourceId !== grounding.sourceId || span.sourceVersionId !== grounding.sourceVersionId) {
        throw new Error(`Provider ${label} must reference the current source version`);
      }
    }
  };

  analysis.entities.forEach((entity) => {
    validateSourceIds(entity.sourceIds, 'entity');
    validateRequiredSpans(entity.sourceSpans, 'entity');
  });
  analysis.claims.forEach((claim) => {
    validateSourceIds(claim.sourceIds, 'claim');
    validateRequiredSpans(claim.sourceSpans, 'claim');
  });
  analysis.relationships.forEach((relationship) => {
    validateSourceIds(relationship.sourceIds, 'relationship');
    validateRequiredSpans(relationship.sourceSpans, 'relationship');
  });
  analysis.contradictions.forEach((contradiction) => validateSourceIds(contradiction.sourceIds, 'contradiction'));
  analysis.contradictions.forEach((contradiction) => validateRequiredSpans(contradiction.sourceSpans, 'contradiction'));
  analysis.researchGaps.forEach((gap) => validateSourceIds(gap.sourceIds, 'research gap'));
  analysis.researchGaps.forEach((gap) => validateRequiredSpans(gap.sourceSpans, 'research gap'));
  return analysis;
}

function spansFromExtraction(sourceId: string, sourceVersionId: string, extraction: DeterministicExtraction): KnowledgeAnalysisSourceSpan[] {
  const spans = new Map<string, KnowledgeAnalysisSourceSpan>();
  const addSpan = (span: KnowledgeSourceSpan | null | undefined): void => {
    if (!span) {
      return;
    }
    const value: KnowledgeAnalysisSourceSpan = {
      sourceId,
      sourceVersionId,
      startOffset: span.startOffset,
      endOffset: span.endOffset,
      startLine: span.startLine,
      startColumn: span.startColumn,
      endLine: span.endLine,
      endColumn: span.endColumn,
      ...(span.label ? { label: span.label } : {}),
    };
    spans.set(sourceSpanFingerprint(value), value);
  };
  extraction.sections.forEach((section) => addSpan(section.span));
  extraction.symbols.forEach((symbol) => addSpan(symbol.span));
  extraction.relationships.forEach((relationship) => addSpan(relationship.span));
  extraction.links.forEach((link) => addSpan(link.span));
  extraction.diagnostics.forEach((diagnostic) => addSpan(diagnostic.span));
  return [...spans.values()];
}

function renderAnalysisPrompt(input: KnowledgeEnrichmentInput, sourceSpans: readonly KnowledgeAnalysisSourceSpan[]): string {
  if (sourceSpans.length > MAX_ALLOWED_SOURCE_SPANS) {
    throw new Error(`Provider grounding exceeds the maximum supported source span count (${MAX_ALLOWED_SOURCE_SPANS})`);
  }
  let truncatedSectionTexts = 0;
  const sections = input.extraction.sections.slice(0, MAX_SECTION_COUNT).map((section) => {
    const bounded = redactedPromptField(section.text, MAX_SECTION_TEXT_LENGTH);
    if (bounded.truncated) {
      truncatedSectionTexts += 1;
    }
    return {
      id: section.id,
      title: redactedPromptText(section.title ?? section.kind, MAX_SECTION_TEXT_LENGTH),
      text: redactedPromptText(section.text, MAX_SECTION_TEXT_LENGTH),
      span: (() => {
        const span = sourceSpans.find(
          (candidate) =>
            candidate.startOffset === section.span.startOffset && candidate.endOffset === section.span.endOffset,
        );
        return span ? redactedPromptSpan(span) : undefined;
      })(),
    };
  });
  const symbols = input.extraction.symbols.slice(0, MAX_SYMBOL_COUNT).map((symbol) => ({
    id: symbol.id,
    kind: redactedPromptText(symbol.kind, MAX_EXCERPT_LENGTH),
    name: redactedPromptText(symbol.name, MAX_EXCERPT_LENGTH),
    qualifiedName:
      symbol.qualifiedName === undefined || symbol.qualifiedName === null
        ? null
        : redactedPromptText(symbol.qualifiedName, MAX_EXCERPT_LENGTH),
  }));
  const relationships = input.extraction.relationships.slice(0, MAX_RELATIONSHIP_COUNT).map((relationship) => ({
    id: relationship.id,
    type: redactedPromptText(relationship.type, MAX_EXCERPT_LENGTH),
    fromId: redactedPromptText(
      relationship.fromId ?? relationship.sourceSymbolId ?? '',
      MAX_EXCERPT_LENGTH,
    ) || null,
    toId: redactedPromptText(
      relationship.toId ?? relationship.targetSymbolId ?? relationship.targetReference ?? '',
      MAX_EXCERPT_LENGTH,
    ) || null,
  }));
  const prompt = JSON.stringify(
    {
      task: 'Return JSON matching the KnowledgeAnalysis contract. Do not invent facts. Use only the supplied sourceId and exact sourceSpans. Focus on contradictions and research gaps that should be reviewed by a human.',
      source: {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourcePath: redactedPromptText(input.sourcePath ?? '', MAX_SOURCE_PATH_LENGTH),
      },
      extraction: {
        title: redactedPromptText(input.extraction.title ?? '', MAX_SECTION_TEXT_LENGTH),
        summary: redactedPromptText(input.extraction.summary, MAX_SECTION_TEXT_LENGTH),
        sections,
        symbols,
        relationships,
      },
      truncation: {
        sectionsOmitted: Math.max(0, input.extraction.sections.length - sections.length),
        sectionTextsTruncated: truncatedSectionTexts,
        symbolsOmitted: Math.max(0, input.extraction.symbols.length - symbols.length),
        relationshipsOmitted: Math.max(0, input.extraction.relationships.length - relationships.length),
        diagnosticsOmitted: input.extraction.diagnostics.length,
        linksOmitted: input.extraction.links.length,
      },
      allowedSourceSpans: sourceSpans.map(redactedPromptSpan),
    },
    null,
    2,
  );
  if (utf8ByteLength(prompt) > MAX_REQUEST_PROMPT_BYTES) {
    throw new Error(`Provider analysis prompt exceeds the ${MAX_REQUEST_PROMPT_BYTES}-byte limit`);
  }
  return prompt;
}

function renderGenerationPrompt(
  input: KnowledgeEnrichmentInput,
  pages: readonly KnowledgePageVersion[],
  providerAnalysis: KnowledgeAnalysis,
): string {
  const prompt = JSON.stringify(
    {
      task: 'Return JSON matching the KnowledgeGeneration contract. Do not remove deterministic facts or add ungrounded facts.',
      source: {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourcePath: redactedPromptText(input.sourcePath ?? '', MAX_SOURCE_PATH_LENGTH),
      },
      pages: pages.slice(0, MAX_PAGE_COUNT).map((page) => ({
        pageVersionId: page.id,
        title: redactedPromptText(page.content.split('\n', 2)[0] ?? '', MAX_PAGE_CONTENT_LENGTH),
        contentExcerpt: redactedPromptText(page.content, MAX_PAGE_CONTENT_LENGTH),
      })),
      truncation: {
        pagesOmitted: Math.max(0, input.pageVersionIds.length - Math.min(input.pageVersionIds.length, MAX_PAGE_COUNT)),
      },
      analysis: redactedPromptValue(providerAnalysis),
    },
    null,
    2,
  );
  if (utf8ByteLength(prompt) > MAX_REQUEST_PROMPT_BYTES) {
    throw new Error(`Provider generation prompt exceeds the ${MAX_REQUEST_PROMPT_BYTES}-byte limit`);
  }
  return prompt;
}

function requestInitFromTransport(input: OpenAICompatibleTransportRequest): RequestInit {
  return {
    method: input.method,
    redirect: input.redirect,
    signal: input.signal,
    headers: input.headers,
    body: input.body,
  };
}

export function createOpenAICompatibleFetchTransport(fetchImplementation?: typeof fetch): OpenAICompatibleTransport {
  const implementation = fetchImplementation ?? fetch;
  return {
    async request(input: OpenAICompatibleTransportRequest): Promise<Response> {
      return implementation(input.url, requestInitFromTransport(input));
    },
  };
}

async function readResponseText(response: Response, controller: AbortController): Promise<string> {
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BODY_BYTES) {
      controller.abort(new Error('response_too_large'));
      try {
        await response.body?.cancel('response_too_large');
      } catch {
        // ignore best-effort cleanup
      }
      throw new Error(`Provider response exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte limit`);
    }
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        controller.abort(new Error('response_too_large'));
        await reader.cancel('response_too_large');
        throw new Error(`Provider response exceeds the ${MAX_RESPONSE_BODY_BYTES}-byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function warningFromError(error: unknown, fallbackCode: string): KnowledgeProviderDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  let code = fallbackCode;
  if (lower.includes('timed out')) {
    code = 'provider_timeout';
  } else if (lower.includes('json') || lower.includes('response') || lower.includes('unexpected field') || lower.includes('grounded')) {
    code = 'provider_invalid_response';
  } else if (lower.includes('status') || lower.includes('redirect')) {
    code = 'provider_http_error';
  }
  return {
    code,
    message: sanitizeExcerpt(message),
  };
}

export class OpenAICompatibleProvider implements KnowledgeProviderTestAdapter {
  private readonly transport: OpenAICompatibleTransport;
  private readonly credentialPolicy: KnowledgeProviderCredentialPolicy;
  private readonly hostPolicy: OpenAICompatibleHostPolicy;

  public constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.transport = options.transport ?? createOpenAICompatibleFetchTransport(options.fetchImplementation);
    this.credentialPolicy = options.credentialPolicy ?? {};
    this.hostPolicy = options.hostPolicy ?? {};
  }

  public async analyze(input: OpenAICompatibleAnalyzeInput): Promise<OpenAICompatibleProviderResult<KnowledgeAnalysis>> {
    const result = await this.executeRequest({
      profile: input.profile,
      environment: input.environment,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt ?? 'You are a strict JSON-only assistant. Return only valid JSON.',
      signal: input.signal,
    });
    const parsed = safeParseJson(result.content, 'Provider message content');
    const analysis = validateKnowledgeAnalysis(parsed);
    return {
      value: ensureGroundedAnalysis(analysis, {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourceSpans: input.sourceSpans,
      }),
      warnings: result.warnings,
    };
  }

  public async generate(input: OpenAICompatibleGenerateInput): Promise<OpenAICompatibleProviderResult<KnowledgeGeneration>> {
    const result = await this.executeRequest({
      profile: input.profile,
      environment: input.environment,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt ?? 'You are a strict JSON-only assistant. Return only valid JSON.',
      signal: input.signal,
    });
    const parsed = safeParseJson(result.content, 'Provider message content');
    const generation = validateKnowledgeGeneration(parsed);
    if (generation.status === 'generated') {
      ensureGroundedAnalysis(generation.analysis, {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourceSpans: input.sourceSpans,
      });
    }
    return { value: generation, warnings: result.warnings };
  }

  /**
   * Single-shot, non-streaming request whose message content must be one JSON document. Failures carry a classified
   * `KnowledgeProviderCallError`; callers own semantic validation of the returned value.
   */
  public async completeJson(input: OpenAICompatibleCompleteJsonInput): Promise<OpenAICompatibleProviderResult<unknown>> {
    const result = await this.executeRequest({
      profile: input.profile,
      environment: input.environment,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      signal: input.signal,
    });
    try {
      return { value: safeParseJson(result.content, 'Provider message content'), warnings: result.warnings };
    } catch (error) {
      throw new KnowledgeProviderCallError('invalid_response', error instanceof Error ? sanitizeExcerpt(error.message) : 'invalid response');
    }
  }

  public async testProfile(input: KnowledgeProviderTestAdapterInput): Promise<KnowledgeProviderTestAdapterResult> {
    const result = await this.executeRequest({
      profile: input.profile,
      environment: input.environment,
      prompt: JSON.stringify({
        task: 'Return a minimal valid KnowledgeAnalysis JSON object with a summary and empty arrays.',
        sourceId: 'provider-test-source',
        sourceVersionId: 'provider-test-version',
        allowedSourceSpans: [],
      }),
      systemPrompt: 'You are a strict JSON-only assistant. Return only valid JSON.',
      resolvedKey: { apiKey: input.apiKey, warnings: [] },
    });
    const analysis = validateKnowledgeAnalysis(safeParseJson(result.content, 'Provider message content'));
    return {
      success: analysis.summary.trim().length > 0,
      warnings: result.warnings,
      diagnostics: [`Validated ${input.profile.endpoint}/chat/completions`],
    };
  }

  private async executeRequest(input: {
    profile: KnowledgeProviderProfile;
    environment: NodeJS.ProcessEnv;
    prompt: string;
    systemPrompt: string;
    signal?: AbortSignal;
    resolvedKey?: ResolveKnowledgeProviderApiKeyResult;
  }): Promise<{ content: string; warnings: KnowledgeProviderDiagnostic[] }> {
    throwIfAborted(input.signal);
    if (utf8ByteLength(input.prompt) > MAX_REQUEST_PROMPT_BYTES) {
      throw new Error(`Provider prompt exceeds the ${MAX_REQUEST_PROMPT_BYTES}-byte limit`);
    }
    if (utf8ByteLength(input.systemPrompt) > MAX_REQUEST_SYSTEM_PROMPT_LENGTH) {
      throw new Error(`Provider system prompt exceeds the ${MAX_REQUEST_SYSTEM_PROMPT_LENGTH}-byte limit`);
    }
    let endpoint: string;
    try {
      endpoint = normalizeOpenAICompatibleEndpoint(input.profile.endpoint);
    } catch (error) {
      throw new KnowledgeProviderCallError('unsafe_endpoint', error instanceof Error ? sanitizeExcerpt(error.message) : 'unsafe endpoint');
    }
    const url = new URL('chat/completions', `${endpoint}/`).toString();
    const resolvedKey = input.resolvedKey ?? resolveKnowledgeProviderApiKey(input.profile, input.environment, this.credentialPolicy);
    const requestSignal = composeSignals(input.signal, input.profile.timeoutMs);
    const transportRequest: OpenAICompatibleTransportRequest = {
      url,
      method: 'POST',
      redirect: 'manual',
      signal: requestSignal.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(resolvedKey.apiKey ? { authorization: `Bearer ${resolvedKey.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: input.profile.model,
        response_format: { type: 'json_object' },
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: boundedText(input.systemPrompt, MAX_REQUEST_SYSTEM_PROMPT_LENGTH),
          } satisfies ChatMessage,
          {
            role: 'user',
            content: input.prompt,
          } satisfies ChatMessage,
        ],
      }),
    };
    try {
      const response = await this.sendRequest(
        endpoint,
        input.profile,
        resolvedKey.apiKey !== null,
        requestSignal.signal,
        transportRequest,
      );
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Provider redirects are not allowed for ${endpoint}`);
      }
      const responseText = await readResponseText(response, requestSignal.controller);
      if (!response.ok) {
        throw new Error(
          `Provider request failed with status ${response.status}. Response body was redacted.`,
        );
      }
      let content: string;
      try {
        content = extractResponseContent(safeParseJson(responseText, 'Provider response'));
      } catch (error) {
        throw new KnowledgeProviderCallError('invalid_response', error instanceof Error ? error.message : String(error));
      }
      return { content, warnings: resolvedKey.warnings };
    } catch (error) {
      if (requestSignal.timeoutReached()) {
        throw new KnowledgeProviderCallError(
          'timeout',
          `Provider request to ${endpoint} timed out after ${input.profile.timeoutMs}ms.`,
        );
      }
      if (error instanceof KnowledgeProviderCallError) {
        throw new KnowledgeProviderCallError(error.reason, sanitizeExcerpt(error.message));
      }
      if (error instanceof Error) {
        throw new Error(sanitizeExcerpt(error.message));
      }
      throw new Error(sanitizeExcerpt(String(error)));
    } finally {
      requestSignal.release();
    }
  }

  private async sendRequest(
    endpoint: string,
    profile: KnowledgeProviderProfile,
    hasCredentials: boolean,
    signal: AbortSignal,
    request: OpenAICompatibleTransportRequest,
  ): Promise<Response> {
    const url = new URL(endpoint);
    const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const literalHostname = tryParseCanonicalIpLiteral(hostname);
    const originAllowed =
      this.hostPolicy.allowedOrigins?.has(url.origin) === true ||
      this.hostPolicy.isOriginAllowed?.({ origin: url.origin, profile, hasCredentials }) === true;
    if (!originAllowed) {
      throw new KnowledgeProviderCallError(
        'unsafe_endpoint',
        hasCredentials
          ? `Host policy rejected credential-bearing provider origin ${url.origin}`
          : `Host policy rejected provider origin ${url.origin}`,
      );
    }

    if (literalHostname === null) {
      if (!this.transport.requestPinned) {
        throw new Error(`Provider transport must implement requestPinned for named host ${hostname}`);
      }
      const protocol = url.protocol === 'https:' ? 'https:' : 'http:';
      const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
      const tlsServername = url.protocol === 'https:' ? hostname : null;
      return await awaitWithAbort(
        this.transport.requestPinned({
          origin: url.origin,
          originalHostname: hostname,
          protocol,
          port,
          path: requestPathForUrl(url),
          signal,
          tlsServername,
          buildValidatedRequest: async ({ resolvedAddresses, selectedAddress }) => {
            throwIfAborted(signal);
            const approvedAddresses = await this.validateNamedHostResolvedAddresses(url, resolvedAddresses);
            const approvedSelectedAddress = validatePinnedResolvedAddress(selectedAddress);
            if (!hasMatchingResolvedAddress(approvedSelectedAddress, approvedAddresses)) {
              throw new Error(`Provider transport selected an address that was not part of the validated set for ${url.origin}`);
            }
            return {
              approvedAddresses,
              connectionTarget: toPinnedConnectionTarget(url, protocol, port, tlsServername, approvedSelectedAddress),
              payload: {
                method: request.method,
                headers: request.headers,
                body: request.body,
                signal: request.signal,
                path: requestPathForUrl(url),
              },
            };
          },
        }),
        signal,
      );
    }

    this.validateLiteralIpDestination(url, literalHostname.address);
    return await awaitWithAbort(this.transport.request(request), signal);
  }

  private validateLiteralIpDestination(url: URL, address: string): void {
    const classification = classifyProviderEndpointIp(address);
    if (!classification.isGlobalDestination && !classification.isExactLoopbackLiteral) {
      throw new KnowledgeProviderCallError('unsafe_endpoint', `Provider endpoint ${url.origin} resolves to a private or reserved address`);
    }
  }

  private async validateNamedHostResolvedAddresses(
    url: URL,
    addresses: readonly OpenAICompatibleResolvedAddress[],
  ): Promise<readonly OpenAICompatibleResolvedAddress[]> {
    if (addresses.length === 0) {
      throw new Error(`Provider endpoint ${url.origin} did not resolve to any addresses`);
    }
    const canonicalAddresses = addresses.map((address) => validatePinnedResolvedAddress(address));
    const privateOrReserved = canonicalAddresses.some((address) => !classifyProviderEndpointIp(address.address).isGlobalDestination);
    if (privateOrReserved) {
      throw new KnowledgeProviderCallError('unsafe_endpoint', `Provider endpoint ${url.origin} resolves to a private or reserved address`);
    }
    return canonicalAddresses;
  }
}

export class OpenAICompatibleEnrichmentService implements KnowledgeEnrichmentService {
  private readonly provider: OpenAICompatibleProvider;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pageStore: KnowledgePageStore;

  public constructor(
    private readonly db: Database.Database,
    private readonly options: OpenAICompatibleEnrichmentServiceOptions,
  ) {
    this.provider = options.provider ?? new OpenAICompatibleProvider({
      credentialPolicy: options.credentialPolicy,
      hostPolicy: options.hostPolicy,
      transport: options.transport,
    });
    this.environment = options.environment ?? process.env;
    this.pageStore = new KnowledgePageStore(db);
  }

  public async enrich(input: KnowledgeEnrichmentInput): Promise<KnowledgeEnrichmentResult | void> {
    const profile = this.options.profileStore.selectEnabledProfile(input.projectId, 'analysis');
    if (!profile) {
      return;
    }
    const sourceSpans = spansFromExtraction(input.sourceId, input.sourceVersionId, input.extraction);
    const warnings: KnowledgeProviderDiagnostic[] = [];
    let analysis: KnowledgeAnalysis;
    try {
      const result = await this.provider.analyze({
        profile,
        environment: this.environment,
        prompt: renderAnalysisPrompt(input, sourceSpans),
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourceSpans,
        signal: input.signal,
      });
      warnings.push(...result.warnings);
      analysis = result.value;
    } catch (error) {
      return { warnings: [warningFromError(error, 'provider_invalid_response')], reviews: [], insights: [] };
    }

    const reviews: KnowledgeEnrichmentReviewInput[] = analysis.contradictions.map((contradiction) => ({
      pageVersionId: input.pageVersionIds[0] ?? null,
      summary: contradiction.summary,
    }));
    const insights = input.sourcePath
      ? analysis.researchGaps.map((gap) => ({
          type: 'research_gap',
          contentPath: input.sourcePath!,
          confidence: gap.confidence,
        }))
      : [];

    const generationProfile = profile.capabilities.includes('generation')
      ? profile
      : this.options.profileStore.selectEnabledProfile(input.projectId, 'generation');
    if (generationProfile) {
      try {
        const pages = input.pageVersionIds
          .map((pageVersionId) => this.pageStore.getVersion(input.projectId, pageVersionId))
          .filter((page): page is KnowledgePageVersion => page !== null)
          .slice(0, MAX_PAGE_COUNT);
        const generation = await this.provider.generate({
          profile: generationProfile,
          environment: this.environment,
          prompt: renderGenerationPrompt(input, pages, analysis),
          sourceId: input.sourceId,
          sourceVersionId: input.sourceVersionId,
          sourceSpans,
          signal: input.signal,
        });
        warnings.push(...generation.warnings);
      } catch (error) {
        warnings.push(warningFromError(error, 'provider_invalid_response'));
      }
    }

    return { warnings, reviews, insights };
  }
}
