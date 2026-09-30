import { redactLines } from '../Redactor.js';
import { searchTokens } from './KnowledgeSearchTokens.js';

/** Bump when the tokenizer, projection, dimension, or neighbor rules change; existing models become unusable. */
export const KNOWLEDGE_SEMANTIC_MODEL_VERSION = 1;

export const SEMANTIC_VECTOR_DIMENSION = 128;
export const MAX_NEIGHBORS_PER_TERM = 5;
export const MAX_NEIGHBOR_TERMS = 2_000;
export const MAX_EXPANSION_TERMS = 12;
export const MAX_EXPANSION_CANDIDATES = 25;
export const MAX_MODEL_SOURCES = 5_000;
export const MAX_COOCCURRENCE_PAIRS = 200_000;
/** Distinct sources a term pair must co-occur in before it is a neighbor. */
export const MIN_NEIGHBOR_SUPPORT = 2;
export const MIN_NEIGHBOR_WEIGHT = 0.2;

const MAX_WINDOW_TERMS = 24;
const MAX_SOURCE_TOKENS = 512;
const MAX_SOURCE_VECTOR_TERMS = 128;
const MAX_SOURCE_EXPANDED_TERMS = 16;
const MAX_SOURCE_PAIRS = 2_000;
const MIN_TOKEN_LENGTH = 3;
const MAX_TOKEN_LENGTH = 40;
const NEIGHBOR_DAMPING = 0.5;
const ROUNDING_SCALE = 1e6;
const PLACEHOLDER_TOKENS = new Set(['redacted', 'truncated', 'more', 'line', 'lines']);
const STOP_TOKENS = new Set(['the', 'and', 'for', 'are', 'with', 'this', 'that', 'from', 'not', 'but', 'has', 'was']);

export interface SemanticLimits {
  maxModelSources: number;
  maxNeighborTerms: number;
  maxCooccurrencePairs: number;
}

export const DEFAULT_SEMANTIC_LIMITS: SemanticLimits = {
  maxModelSources: MAX_MODEL_SOURCES,
  maxNeighborTerms: MAX_NEIGHBOR_TERMS,
  maxCooccurrencePairs: MAX_COOCCURRENCE_PAIRS,
};

export interface SemanticSourceInput {
  sourceVersionId: string;
  /** Redacted indexed field texts in field order; each one is a co-occurrence window. */
  windows: readonly string[];
}

export interface SemanticNeighbor {
  term: string;
  neighborTerm: string;
  rank: number;
  weight: number;
}

export interface SemanticSourceVector {
  sourceVersionId: string;
  vector: number[];
  norm: number;
}

export interface SemanticModelBuild {
  vectors: SemanticSourceVector[];
  neighbors: SemanticNeighbor[];
}

export interface ProjectedVector {
  vector: number[];
  norm: number;
}

/**
 * Tokens that may enter the model: identifier-aware, lowercase, and free of anything that looks like a secret,
 * a hash, or a redaction placeholder. Text is redacted again here so a field written before a redaction rule existed
 * still cannot leak through counting.
 */
export function isSemanticToken(token: string): boolean {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return false;
  if (PLACEHOLDER_TOKENS.has(token) || STOP_TOKENS.has(token)) return false;
  if (/^\p{N}+$/u.test(token)) return false;
  if (token.length >= 16 && /\p{N}/u.test(token) && /\p{L}/u.test(token)) return false;
  if (token.length >= 16 && /^[0-9a-f]+$/.test(token)) return false;
  return true;
}

export function semanticTokens(text: string): string[] {
  return searchTokens(redactLines(text)).filter(isSemanticToken);
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function round(value: number): number {
  return Math.round(value * ROUNDING_SCALE) / ROUNDING_SCALE + 0;
}

/** Signed hashed projection of a weighted sparse term set into the fixed-dimension dense vector. */
export function projectWeights(entries: Iterable<readonly [string, number]>): ProjectedVector | null {
  const accumulator = new Array<number>(SEMANTIC_VECTOR_DIMENSION).fill(0);
  const ordered = [...entries].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [term, weight] of ordered) {
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    const hash = fnv1a(term);
    accumulator[hash % SEMANTIC_VECTOR_DIMENSION] += (hash & 0x80000000) === 0 ? weight : -weight;
  }
  const vector = accumulator.map(round);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? { vector, norm } : null;
}

export function cosineSimilarity(left: ProjectedVector, right: ProjectedVector): number {
  if (left.vector.length !== right.vector.length || left.norm === 0 || right.norm === 0) return 0;
  let dot = 0;
  for (let index = 0; index < left.vector.length; index += 1) dot += left.vector[index] * right.vector[index];
  return Math.min(1, Math.max(0, dot / (left.norm * right.norm)));
}

/** Damped neighbor-term weight used for query expansion so expansion never outweighs the query's own terms. */
export function dampenedNeighborWeight(weight: number): number {
  return weight * NEIGHBOR_DAMPING;
}

interface SourceStatistics {
  sourceVersionId: string;
  termFrequency: Map<string, number>;
}

function comparePair(left: readonly [string, number], right: readonly [string, number]): number {
  return right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
}

function collectSource(
  source: SemanticSourceInput,
  pairSupport: Map<string, number>,
  maxPairs: number,
): SourceStatistics {
  const termFrequency = new Map<string, number>();
  const sourcePairs = new Set<string>();
  for (const window of source.windows) {
    const tokens = semanticTokens(window).slice(0, MAX_WINDOW_TERMS);
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    for (let left = 0; left < tokens.length && sourcePairs.size < MAX_SOURCE_PAIRS; left += 1) {
      for (let right = left + 1; right < tokens.length && sourcePairs.size < MAX_SOURCE_PAIRS; right += 1) {
        const [first, second] = tokens[left] < tokens[right] ? [tokens[left], tokens[right]] : [tokens[right], tokens[left]];
        sourcePairs.add(`${first}\0${second}`);
      }
    }
  }
  for (const pair of sourcePairs) {
    const known = pairSupport.get(pair);
    if (known !== undefined) pairSupport.set(pair, known + 1);
    else if (pairSupport.size < maxPairs) pairSupport.set(pair, 1);
  }
  const kept = [...termFrequency.entries()].sort(comparePair).slice(0, MAX_SOURCE_TOKENS);
  return { sourceVersionId: source.sourceVersionId, termFrequency: new Map(kept) };
}

function isMorphologicalVariant(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function deriveNeighbors(
  pairSupport: ReadonlyMap<string, number>,
  documentFrequency: ReadonlyMap<string, number>,
  maxNeighborTerms: number,
): Map<string, Array<{ neighborTerm: string; weight: number }>> {
  const adjacency = new Map<string, Array<{ neighborTerm: string; weight: number }>>();
  const link = (term: string, neighborTerm: string, weight: number): void => {
    const list = adjacency.get(term);
    if (list) list.push({ neighborTerm, weight });
    else adjacency.set(term, [{ neighborTerm, weight }]);
  };
  for (const [pair, support] of pairSupport) {
    if (support < MIN_NEIGHBOR_SUPPORT) continue;
    const [first, second] = pair.split('\0');
    if (isMorphologicalVariant(first, second)) continue;
    const denominator = (documentFrequency.get(first) ?? 0) + (documentFrequency.get(second) ?? 0);
    if (denominator === 0) continue;
    const weight = round((2 * support) / denominator);
    if (weight < MIN_NEIGHBOR_WEIGHT) continue;
    link(first, second, weight);
    link(second, first, weight);
  }
  const trimmed = new Map<string, Array<{ neighborTerm: string; weight: number }>>();
  for (const [term, list] of adjacency) {
    list.sort((left, right) => right.weight - left.weight || (left.neighborTerm < right.neighborTerm ? -1 : 1));
    trimmed.set(term, list.slice(0, MAX_NEIGHBORS_PER_TERM));
  }
  const selected = [...trimmed.entries()]
    .sort(
      (left, right) =>
        right[1][0].weight - left[1][0].weight ||
        (documentFrequency.get(right[0]) ?? 0) - (documentFrequency.get(left[0]) ?? 0) ||
        (left[0] < right[0] ? -1 : 1),
    )
    .slice(0, maxNeighborTerms);
  return new Map(selected);
}

function sourceVector(
  statistics: SourceStatistics,
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  neighbors: ReadonlyMap<string, Array<{ neighborTerm: string; weight: number }>>,
): ProjectedVector | null {
  const weighted = [...statistics.termFrequency.entries()]
    .map(([term, frequency]): [string, number] => [
      term,
      (1 + Math.log(frequency)) * Math.log(1 + documentCount / (documentFrequency.get(term) ?? 1)),
    ])
    .sort(comparePair)
    .slice(0, MAX_SOURCE_VECTOR_TERMS);
  const combined = new Map(weighted);
  for (const [term, weight] of weighted.slice(0, MAX_SOURCE_EXPANDED_TERMS)) {
    for (const neighbor of neighbors.get(term) ?? []) {
      combined.set(neighbor.neighborTerm, (combined.get(neighbor.neighborTerm) ?? 0) + weight * dampenedNeighborWeight(neighbor.weight));
    }
  }
  return projectWeights(combined);
}

/**
 * Deterministic model over redacted indexed windows: bounded co-occurrence neighbors (pairs supported by at least
 * MIN_NEIGHBOR_SUPPORT sources) and one hashed-projection vector per source. Identical input yields identical output.
 */
export function buildSemanticModel(
  sources: readonly SemanticSourceInput[],
  limits: SemanticLimits = DEFAULT_SEMANTIC_LIMITS,
): SemanticModelBuild {
  const pairSupport = new Map<string, number>();
  const statistics = sources.map((source) => collectSource(source, pairSupport, limits.maxCooccurrencePairs));
  const documentFrequency = new Map<string, number>();
  for (const source of statistics) {
    for (const term of source.termFrequency.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const neighborMap = deriveNeighbors(pairSupport, documentFrequency, limits.maxNeighborTerms);
  const vectors: SemanticSourceVector[] = [];
  for (const source of statistics) {
    const projected = sourceVector(source, documentFrequency, statistics.length, neighborMap);
    if (projected) vectors.push({ sourceVersionId: source.sourceVersionId, ...projected });
  }
  const neighbors = [...neighborMap.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .flatMap(([term, list]) =>
      list.map((entry, rank): SemanticNeighbor => ({ term, neighborTerm: entry.neighborTerm, rank, weight: entry.weight })),
    );
  return { vectors, neighbors };
}
