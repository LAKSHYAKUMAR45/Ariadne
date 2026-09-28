import net from 'node:net';
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
import type { KnowledgePageVersion } from '../KnowledgePageStore.js';
import { KnowledgePageStore } from '../KnowledgePageStore.js';
import type {
  KnowledgeEnrichmentInput,
  KnowledgeEnrichmentResult,
  KnowledgeEnrichmentReviewInput,
  KnowledgeEnrichmentService,
} from '../KnowledgeWorker.js';
import { redact } from '../../Redactor.js';

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

interface CanonicalIpLiteral {
  address: string;
  family: 4 | 6;
  embeddedIpv4Address: string | null;
  isMappedIpv6: boolean;
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

function boundPromptField(value: string, maxLength: number): { value: string; truncated: boolean } {
  const bounded = boundedText(value, maxLength);
  return { value: bounded, truncated: bounded !== value.trim() };
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

function normalizeIpLiteralCandidate(address: string): string {
  return address.toLowerCase();
}

function parseIpv4Segments(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const segments: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith('0')) {
      return null;
    }
    const value = Number.parseInt(part, 10);
    if (value < 0 || value > 255) {
      return null;
    }
    segments.push(value);
  }

  return segments;
}

function parseIpv6Segments(address: string): number[] | null {
  const lower = address.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(lower)) {
    return null;
  }

  const doubleColonIndex = lower.indexOf('::');
  if (doubleColonIndex !== lower.lastIndexOf('::')) {
    return null;
  }

  const hasCompression = doubleColonIndex !== -1;
  const [headText, tailText] = hasCompression ? lower.split('::') : [lower, ''];
  const parseSide = (side: string, allowIpv4Tail: boolean): number[] | null => {
    if (side === '') {
      return [];
    }

    const parts = side.split(':');
    const segments: number[] = [];
    for (const [index, part] of parts.entries()) {
      if (part === '') {
        return null;
      }
      const isLastPart = index === parts.length - 1;
      if (part.includes('.')) {
        if (!allowIpv4Tail || !isLastPart) {
          return null;
        }
        const ipv4Segments = parseIpv4Segments(part);
        if (!ipv4Segments) {
          return null;
        }
        segments.push((ipv4Segments[0]! << 8) | ipv4Segments[1]!);
        segments.push((ipv4Segments[2]! << 8) | ipv4Segments[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      segments.push(Number.parseInt(part, 16));
    }
    return segments;
  };

  const headSegments = parseSide(headText, !hasCompression);
  const tailSegments = parseSide(tailText, true);
  if (!headSegments || !tailSegments) {
    return null;
  }

  if (!hasCompression) {
    return headSegments.length === 8 ? headSegments : null;
  }

  if (headSegments.length + tailSegments.length >= 8) {
    return null;
  }

  const zeroSegments = new Array<number>(8 - headSegments.length - tailSegments.length).fill(0);
  return [...headSegments, ...zeroSegments, ...tailSegments];
}

function canonicalizeIpv6Segments(segments: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] === 0) {
      if (currentStart === -1) {
        currentStart = index;
        currentLength = 1;
      } else {
        currentLength += 1;
      }
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
      continue;
    }
    currentStart = -1;
    currentLength = 0;
  }

  if (bestLength < 2) {
    bestStart = -1;
  }

  if (bestStart === -1) {
    return segments.map((segment) => segment.toString(16)).join(':');
  }

  const before = segments.slice(0, bestStart).map((segment) => segment.toString(16)).join(':');
  const after = segments.slice(bestStart + bestLength).map((segment) => segment.toString(16)).join(':');
  if (before === '' && after === '') {
    return '::';
  }
  if (before === '') {
    return `::${after}`;
  }
  if (after === '') {
    return `${before}::`;
  }
  return `${before}::${after}`;
}

function ipv4FromTailSegments(segments: readonly number[]): string {
  const high = segments[6]!;
  const low = segments[7]!;
  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff,
  ].join('.');
}

function parseCanonicalIpLiteral(address: string): CanonicalIpLiteral {
  const normalized = normalizeIpLiteralCandidate(address);
  if (normalized.startsWith('[') || normalized.endsWith(']') || normalized.includes('[') || normalized.includes(']')) {
    throw new Error(`Provider transport must supply bare IP literals for pinned addresses (${address})`);
  }
  if (normalized.includes('%')) {
    throw new Error(`Provider transport must not use zone identifiers in pinned IP literals (${address})`);
  }

  const ipv4Segments = parseIpv4Segments(normalized);
  if (ipv4Segments) {
    return {
      address: ipv4Segments.join('.'),
      family: 4,
      embeddedIpv4Address: null,
      isMappedIpv6: false,
    };
  }

  const ipv6Segments = parseIpv6Segments(normalized);
  if (!ipv6Segments) {
    throw new Error(`Provider transport must supply a valid IP literal for pinned addresses (${address})`);
  }

  const mappedIpv6 =
    ipv6Segments[0] === 0 &&
    ipv6Segments[1] === 0 &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0xffff;
  const compatibleEmbeddedIpv4 =
    ipv6Segments[0] === 0 &&
    ipv6Segments[1] === 0 &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0 &&
    !(ipv6Segments[6] === 0 && ipv6Segments[7] <= 1);
  const nat64WellKnown =
    ipv6Segments[0] === 0x64 &&
    ipv6Segments[1] === 0xff9b &&
    ipv6Segments[2] === 0 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0;
  const nat64LocalUse =
    ipv6Segments[0] === 0x64 &&
    ipv6Segments[1] === 0xff9b &&
    ipv6Segments[2] === 0x1 &&
    ipv6Segments[3] === 0 &&
    ipv6Segments[4] === 0 &&
    ipv6Segments[5] === 0;
  const embeddedIpv4Address = mappedIpv6 || compatibleEmbeddedIpv4 || nat64WellKnown || nat64LocalUse
    ? ipv4FromTailSegments(ipv6Segments)
    : null;

  return {
    address: canonicalizeIpv6Segments(ipv6Segments),
    family: 6,
    embeddedIpv4Address,
    isMappedIpv6: mappedIpv6,
  };
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

function canonicalizeIpLiteral(address: string): string {
  const parsed = parseCanonicalIpLiteral(address);
  return parsed.embeddedIpv4Address ?? parsed.address;
}

function isPrivateOrReservedAddress(address: string): boolean {
  let normalized: string;
  try {
    normalized = canonicalizeIpLiteral(address);
  } catch {
    return false;
  }
  const ipv4Parts = normalized.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d+$/.test(part))) {
    const [first = 0, second = 0, third = 0] = ipv4Parts.map((part) => Number(part));
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 169 && second === 254) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;
    if (first === 192 && second === 0 && third <= 2) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first === 198 && second === 51 && third === 100) return true;
    if (first === 203 && second === 0 && third === 113) return true;
    return first >= 224;
  }
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('fec') ||
    normalized.startsWith('fed') ||
    normalized.startsWith('fee') ||
    normalized.startsWith('fef') ||
    /^2001:db8(?::|$)/.test(normalized)
  );
}

function isLoopbackAddress(address: string): boolean {
  let normalized: string;
  try {
    normalized = canonicalizeIpLiteral(address);
  } catch {
    return false;
  }
  const ipv4Parts = normalized.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d+$/.test(part))) {
    return normalized === '127.0.0.1' || normalized.startsWith('127.');
  }
  return normalized === '::1';
}

function isLoopbackHostnameLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.localhost') || isLoopbackAddress(normalized);
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
  if (sourceSpans.length > MAX_ALLOWED_SOURCE_SPANS) {
    throw new Error(`Provider grounding exceeds the maximum supported source span count (${MAX_ALLOWED_SOURCE_SPANS})`);
  }
  let truncatedSectionTexts = 0;
  const sections = input.extraction.sections.slice(0, MAX_SECTION_COUNT).map((section) => {
    const bounded = boundPromptField(section.text, MAX_SECTION_TEXT_LENGTH);
    if (bounded.truncated) {
      truncatedSectionTexts += 1;
    }
    return {
      id: section.id,
      title: section.title ?? section.kind,
      text: bounded.value,
      span: sourceSpans.find((span) => span.startOffset === section.span.startOffset && span.endOffset === section.span.endOffset),
    };
  });
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
  const prompt = JSON.stringify(
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
      truncation: {
        sectionsOmitted: Math.max(0, input.extraction.sections.length - sections.length),
        sectionTextsTruncated: truncatedSectionTexts,
        symbolsOmitted: Math.max(0, input.extraction.symbols.length - symbols.length),
        relationshipsOmitted: Math.max(0, input.extraction.relationships.length - relationships.length),
        diagnosticsOmitted: input.extraction.diagnostics.length,
        linksOmitted: input.extraction.links.length,
      },
      allowedSourceSpans: sourceSpans,
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
        sourcePath: input.sourcePath,
      },
      pages: pages.slice(0, MAX_PAGE_COUNT).map((page) => ({
        pageVersionId: page.id,
        title: page.content.split('\n', 2)[0] ?? '',
        contentExcerpt: boundedText(page.content, MAX_PAGE_CONTENT_LENGTH),
      })),
      truncation: {
        pagesOmitted: Math.max(0, input.pageVersionIds.length - Math.min(input.pageVersionIds.length, MAX_PAGE_COUNT)),
      },
      analysis: providerAnalysis,
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
    const endpoint = normalizeOpenAICompatibleEndpoint(input.profile.endpoint);
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

  private async sendRequest(
    endpoint: string,
    profile: KnowledgeProviderProfile,
    hasCredentials: boolean,
    signal: AbortSignal,
    request: OpenAICompatibleTransportRequest,
  ): Promise<Response> {
    const url = new URL(endpoint);
    const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const originAllowed =
      this.hostPolicy.allowedOrigins?.has(url.origin) === true ||
      this.hostPolicy.isOriginAllowed?.({ origin: url.origin, profile, hasCredentials }) === true;
    if (!originAllowed) {
      throw new Error(
        hasCredentials
          ? `Host policy rejected credential-bearing provider origin ${url.origin}`
          : `Host policy rejected provider origin ${url.origin}`,
      );
    }

    if (net.isIP(hostname) === 0) {
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

    this.validateLiteralIpDestination(url, hostname);
    return await awaitWithAbort(this.transport.request(request), signal);
  }

  private validateLiteralIpDestination(url: URL, hostname: string): void {
    const parsed = parseCanonicalIpLiteral(hostname);
    const privateOrReserved = isPrivateOrReservedAddress(parsed.address);
    const approvedLoopback = parsed.address === '127.0.0.1' || parsed.address === '::1';
    if (privateOrReserved && !approvedLoopback) {
      throw new Error(`Provider endpoint ${url.origin} resolves to a private or reserved address`);
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
    const privateOrReserved = canonicalAddresses.some((address) => isPrivateOrReservedAddress(address.address));
    if (privateOrReserved) {
      throw new Error(`Provider endpoint ${url.origin} resolves to a private or reserved address`);
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
