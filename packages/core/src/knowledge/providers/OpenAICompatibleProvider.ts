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
  KnowledgeProviderProfile,
  KnowledgeProviderTestAdapter,
  KnowledgeProviderTestAdapterInput,
  KnowledgeProviderTestAdapterResult,
  KnowledgeProviderTestResult,
} from '../KnowledgeProviderProfiles.js';
import {
  KnowledgeProviderProfileStore,
  normalizeOpenAICompatibleEndpoint,
  resolveKnowledgeProviderApiKey,
} from '../KnowledgeProviderProfiles.js';
import type { KnowledgePageVersion } from '../KnowledgePageStore.js';
import { KnowledgePageStore } from '../KnowledgePageStore.js';
import type {
  KnowledgeEnrichmentInput,
  KnowledgeEnrichmentResult,
  KnowledgeEnrichmentReviewInput,
  KnowledgeEnrichmentService,
} from '../KnowledgeWorker.js';
import { redact } from '../../Redactor.js';

const MAX_REQUEST_PROMPT_LENGTH = 6_000;
const MAX_REQUEST_SYSTEM_PROMPT_LENGTH = 2_000;
const MAX_RESPONSE_TEXT_LENGTH = 80_000;
const MAX_RESPONSE_CONTENT_LENGTH = 20_000;
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

export interface OpenAICompatibleProviderResult<T> {
  value: T;
  warnings: KnowledgeProviderDiagnostic[];
}

export interface OpenAICompatibleProviderOptions {
  fetchImplementation?: typeof fetch;
}

export interface OpenAICompatibleEnrichmentServiceOptions {
  profileStore: KnowledgeProviderProfileStore;
  provider?: OpenAICompatibleProvider;
  environment?: NodeJS.ProcessEnv;
}

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
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

function composeSignals(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  release(): void;
  timeoutReached(): boolean;
} {
  const controller = new AbortController();
  let didTimeout = false;
  const onAbort = (): void => controller.abort(parent?.reason);
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
    timeoutReached: () => didTimeout,
  };
}

function safeParseJson(text: string, label: string): unknown {
  if (text.length > MAX_RESPONSE_TEXT_LENGTH) {
    throw new Error(`${label} exceeds the maximum supported size`);
  }
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
  if (content.length > MAX_RESPONSE_CONTENT_LENGTH) {
    throw new Error('Provider response content exceeds the maximum supported size');
  }
  return content;
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

function ensureGroundedAnalysis(
  analysis: KnowledgeAnalysis,
  grounding: OpenAICompatibleGroundingInput,
): KnowledgeAnalysis {
  const allowedSourceIds = new Set([grounding.sourceId]);
  const allowedSpanFingerprints = new Set(grounding.sourceSpans.map(sourceSpanFingerprint));
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
      if (!allowedSpanFingerprints.has(sourceSpanFingerprint(span))) {
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
  const sections = input.extraction.sections.slice(0, MAX_SECTION_COUNT).map((section) => ({
    id: section.id,
    title: section.title ?? section.kind,
    text: boundedText(section.text, MAX_SECTION_TEXT_LENGTH),
    span: sourceSpans.find((span) => span.startOffset === section.span.startOffset && span.endOffset === section.span.endOffset),
  }));
  const symbols = input.extraction.symbols.slice(0, MAX_SYMBOL_COUNT).map((symbol) => ({
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName ?? null,
  }));
  const relationships = input.extraction.relationships.slice(0, MAX_RELATIONSHIP_COUNT).map((relationship) => ({
    id: relationship.id,
    type: relationship.type,
    fromId: relationship.fromId ?? relationship.sourceSymbolId ?? null,
    toId: relationship.toId ?? relationship.targetSymbolId ?? relationship.targetReference ?? null,
  }));
  return JSON.stringify(
    {
      task: 'Return JSON matching the KnowledgeAnalysis contract. Do not invent facts. Use only the supplied sourceId and exact sourceSpans. Focus on contradictions and research gaps that should be reviewed by a human.',
      source: {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourcePath: input.sourcePath,
      },
      extraction: {
        title: input.extraction.title,
        summary: boundedText(input.extraction.summary, MAX_SECTION_TEXT_LENGTH),
        sections,
        symbols,
        relationships,
      },
      allowedSourceSpans: sourceSpans,
    },
    null,
    2,
  );
}

function renderGenerationPrompt(
  input: KnowledgeEnrichmentInput,
  pages: readonly KnowledgePageVersion[],
  providerAnalysis: KnowledgeAnalysis,
): string {
  return JSON.stringify(
    {
      task: 'Return JSON matching the KnowledgeGeneration contract. Do not remove deterministic facts or add ungrounded facts.',
      source: {
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        sourcePath: input.sourcePath,
      },
      pages: pages.slice(0, MAX_PAGE_COUNT).map((page) => ({
        pageVersionId: page.id,
        title: page.content.split('\n', 2)[0] ?? '',
        contentExcerpt: boundedText(page.content, MAX_PAGE_CONTENT_LENGTH),
      })),
      analysis: providerAnalysis,
    },
    null,
    2,
  );
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
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
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

  public async testProfile(input: KnowledgeProviderTestAdapterInput): Promise<KnowledgeProviderTestAdapterResult> {
    const result = await this.analyze({
      profile: input.profile,
      environment: input.environment,
      prompt: JSON.stringify({
        task: 'Return a minimal valid KnowledgeAnalysis JSON object with a summary and empty arrays.',
        sourceId: 'provider-test-source',
        sourceVersionId: 'provider-test-version',
        allowedSourceSpans: [],
      }),
      sourceId: 'provider-test-source',
      sourceVersionId: 'provider-test-version',
      sourceSpans: [],
    });
    return {
      success: result.value.summary.trim().length > 0,
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
  }): Promise<{ content: string; warnings: KnowledgeProviderDiagnostic[] }> {
    const endpoint = normalizeOpenAICompatibleEndpoint(input.profile.endpoint);
    const url = new URL('chat/completions', `${endpoint}/`).toString();
    const resolvedKey = resolveKnowledgeProviderApiKey(input.profile, input.environment);
    const requestSignal = composeSignals(input.signal, input.profile.timeoutMs);
    try {
      const response = await this.fetchImplementation(url, {
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
              content: boundedText(input.prompt, MAX_REQUEST_PROMPT_LENGTH),
            } satisfies ChatMessage,
          ],
        }),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`Provider redirects are not allowed for ${endpoint}`);
      }
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `Provider request failed with status ${response.status}. Response excerpt: ${sanitizeExcerpt(responseText)}`,
        );
      }
      const parsed = safeParseJson(responseText, 'Provider response');
      return {
        content: extractResponseContent(parsed),
        warnings: resolvedKey.warnings,
      };
    } catch (error) {
      if (requestSignal.timeoutReached()) {
        throw new Error(
          `Provider request to ${endpoint} timed out after ${input.profile.timeoutMs}ms. Prompt excerpt: ${sanitizeExcerpt(input.prompt)}`,
        );
      }
      if (error instanceof Error) {
        throw new Error(sanitizeExcerpt(error.message));
      }
      throw new Error(sanitizeExcerpt(String(error)));
    } finally {
      requestSignal.release();
    }
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
    this.provider = options.provider ?? new OpenAICompatibleProvider();
    this.environment = options.environment ?? process.env;
    this.pageStore = new KnowledgePageStore(db);
  }

  public async enrich(input: KnowledgeEnrichmentInput): Promise<KnowledgeEnrichmentResult> {
    const profile = this.options.profileStore.selectEnabledProfile(input.projectId, 'analysis');
    if (!profile) {
      return { warnings: [], reviews: [], insights: [] };
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
