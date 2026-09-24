import { lexicalScore } from './KnowledgeSearch.js';

export interface KnowledgeEmbeddingProvider {
  embed(input: string): Promise<number[]> | number[];
}

export type EmbeddingProvider = KnowledgeEmbeddingProvider;

export interface EmbeddingCandidate {
  id: string;
  text: string;
  [key: string]: unknown;
}

export interface RankedEmbeddingCandidate<T extends EmbeddingCandidate = EmbeddingCandidate> {
  candidate: T;
  score: number;
  method: 'embedding' | 'lexical';
}

export interface RankByEmbeddingOptions {
  dimension?: number;
  timeoutMs?: number;
}

function validateOptions(options: RankByEmbeddingOptions): void {
  if (options.dimension !== undefined && (!Number.isInteger(options.dimension) || options.dimension < 1)) {
    throw new Error('Embedding dimension must be a positive integer');
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('Embedding timeout must be a positive number');
  }
}

function validateVector(vector: number[], dimension: number | undefined, label: string): void {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} embedding must contain finite numeric values`);
  }
  if (dimension !== undefined && vector.length !== dimension) {
    throw new Error(`Embedding dimension mismatch: expected ${dimension}, received ${vector.length}`);
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error('Embedding dimensions must match');
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function lexicalRank<T extends EmbeddingCandidate>(query: string, candidates: T[]): RankedEmbeddingCandidate<T>[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      score: lexicalScore(query, [
        { text: candidate.text, weight: 1 },
        { text: candidate.id, weight: 0.25 },
      ]),
      method: 'lexical' as const,
      index,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ index: _index, ...ranked }) => ranked);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Embedding provider timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function rankByEmbedding<T extends EmbeddingCandidate>(
  query: string,
  candidates: T[],
  provider?: KnowledgeEmbeddingProvider,
  options: RankByEmbeddingOptions = {},
): Promise<RankedEmbeddingCandidate<T>[]> {
  validateOptions(options);
  if (!provider) return lexicalRank(query, candidates);

  const queryVector = await withTimeout(Promise.resolve(provider.embed(query)), options.timeoutMs);
  validateVector(queryVector, options.dimension, 'Query');
  const ranked: RankedEmbeddingCandidate<T>[] = [];
  for (const candidate of candidates) {
    const vector = await withTimeout(Promise.resolve(provider.embed(candidate.text)), options.timeoutMs);
    validateVector(vector, queryVector.length, 'Candidate');
    ranked.push({ candidate, score: cosineSimilarity(queryVector, vector), method: 'embedding' });
  }
  return ranked.sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id));
}
