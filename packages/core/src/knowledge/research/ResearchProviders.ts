export interface ResearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface ResearchProvider {
  id: string;
  search(query: string, signal: AbortSignal): Promise<ResearchResult[]>;
}

export type ResearchSearchFn<RawResult> = (query: string, signal: AbortSignal) => Promise<RawResult>;

export interface GenericResearchProviderOptions {
  id: string;
  search: ResearchSearchFn<readonly unknown[]>;
}

export interface TavilyResearchProviderOptions {
  id?: string;
  search: ResearchSearchFn<unknown>;
}

export interface SerpApiResearchProviderOptions {
  id?: string;
  search: ResearchSearchFn<unknown>;
}

export interface SearXNGResearchProviderOptions {
  id?: string;
  search: ResearchSearchFn<unknown>;
}

interface ResultRecord {
  results?: unknown;
  organic_results?: unknown;
  url?: unknown;
  link?: unknown;
  title?: unknown;
  content?: unknown;
  snippet?: unknown;
  published_date?: unknown;
  publishedDate?: unknown;
  score?: unknown;
}

function record(value: unknown): ResultRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ResultRecord : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resultTitle(value: ResultRecord, url: string): string {
  return stringValue(value.title) ?? new URL(url).hostname;
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && (
    octets[0] === 0 ||
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 169 && octets[1] === 254 ||
    octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
    octets[0] === 192 && octets[1] === 168
  );
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) return isPrivateIpv4(host);
  if (isIP(host) !== 6) return false;
  if (host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  const mappedIpv4 = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  return mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4);
}

/** Validates and canonicalizes web result URLs before source ingestion. */
export function validateResearchUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || isPrivateHost(url.hostname)) {
    throw new Error(`Research result URL must be a public unauthenticated HTTP(S) URL: ${value}`);
  }
  return url.toString();
}

function normalizeResult(value: unknown): ResearchResult | null {
  const source = record(value);
  if (source === null) return null;
  const rawUrl = stringValue(source.url) ?? stringValue(source.link);
  if (rawUrl === undefined) return null;

  let url: string;
  try {
    url = validateResearchUrl(rawUrl);
  } catch {
    return null;
  }

  return {
    url,
    title: resultTitle(source, url),
    snippet: stringValue(source.content) ?? stringValue(source.snippet) ?? '',
    publishedAt: stringValue(source.published_date) ?? stringValue(source.publishedDate),
    score: numberValue(source.score),
  };
}

function normalizeResults(values: readonly unknown[]): ResearchResult[] {
  const byUrl = new Map<string, ResearchResult>();
  for (const value of values) {
    const normalized = normalizeResult(value);
    if (normalized !== null && !byUrl.has(normalized.url)) {
      byUrl.set(normalized.url, normalized);
    }
  }
  return [...byUrl.values()];
}

function resultList(payload: unknown, property: 'results' | 'organic_results'): readonly unknown[] {
  const value = record(payload)?.[property];
  return Array.isArray(value) ? value : [];
}

function provider(
  id: string,
  search: ResearchSearchFn<unknown>,
  extract: (payload: unknown) => readonly unknown[],
): ResearchProvider {
  if (id.trim().length === 0) throw new Error('Research provider ID must not be empty');
  return {
    id,
    async search(query: string, signal: AbortSignal): Promise<ResearchResult[]> {
      return normalizeResults(extract(await search(query, signal)));
    },
  };
}

/** Adapts a provider that already produces generic result-shaped records. */
export function createGenericResearchProvider(options: GenericResearchProviderOptions): ResearchProvider {
  return provider(options.id, options.search, (payload) => Array.isArray(payload) ? payload : []);
}

/** Adapts Tavily's `results` response shape without importing its SDK. */
export function createTavilyResearchProvider(options: TavilyResearchProviderOptions): ResearchProvider {
  return provider(options.id ?? 'tavily', options.search, (payload) => resultList(payload, 'results'));
}

/** Adapts SerpApi's `organic_results` response shape without importing its SDK. */
export function createSerpApiResearchProvider(options: SerpApiResearchProviderOptions): ResearchProvider {
  return provider(options.id ?? 'serpapi', options.search, (payload) => resultList(payload, 'organic_results'));
}

/** Adapts SearXNG's `results` response shape without importing its SDK. */
export function createSearXNGResearchProvider(options: SearXNGResearchProviderOptions): ResearchProvider {
  return provider(options.id ?? 'searxng', options.search, (payload) => resultList(payload, 'results'));
}
import { isIP } from 'node:net';
