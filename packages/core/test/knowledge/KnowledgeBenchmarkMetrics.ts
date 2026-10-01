export interface KnowledgeBenchmarkRankedResult {
  title: string;
  hasSpanCitation: boolean;
  searchConfidence: 'clear' | 'ambiguous' | null;
}

export interface KnowledgeBenchmarkQuestionOutcome {
  id: string;
  expectedPaths: readonly string[];
  results: readonly KnowledgeBenchmarkRankedResult[];
  hasTypedGraphEvidence: boolean;
}

export interface MetricCountRate {
  count: number;
  total: number;
  rate: number;
}

export interface KnowledgeBenchmarkQualityMetrics {
  recallAt1: MetricCountRate;
  recallAt3: MetricCountRate;
  recallAt10: MetricCountRate;
  meanReciprocalRank: number;
  ndcgAt10: number;
  zeroResultRate: MetricCountRate;
  ambiguityRate: MetricCountRate;
  exactSpanCitationRate: MetricCountRate;
  typedGraphEvidenceRate: MetricCountRate;
}

const MAX_RANK = 10;
const DEFAULT_ROUND_DIGITS = 6;

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateOutcome(outcome: KnowledgeBenchmarkQuestionOutcome, index: number): void {
  assertNonEmptyString(outcome.id, `outcomes[${index}].id`);
  if (!Array.isArray(outcome.expectedPaths) || outcome.expectedPaths.length === 0) {
    throw new Error(`outcomes[${index}].expectedPaths must contain at least one path`);
  }
  if (!Array.isArray(outcome.results)) {
    throw new Error(`outcomes[${index}].results must be an array`);
  }
  if (typeof outcome.hasTypedGraphEvidence !== 'boolean') {
    throw new Error(`outcomes[${index}].hasTypedGraphEvidence must be a boolean`);
  }

  for (const [expectedPathIndex, expectedPath] of outcome.expectedPaths.entries()) {
    assertNonEmptyString(expectedPath, `outcomes[${index}].expectedPaths[${expectedPathIndex}]`);
  }

  for (const [resultIndex, result] of outcome.results.entries()) {
    assertNonEmptyString(result.title, `outcomes[${index}].results[${resultIndex}].title`);
    if (typeof result.hasSpanCitation !== 'boolean') {
      throw new Error(`outcomes[${index}].results[${resultIndex}].hasSpanCitation must be a boolean`);
    }
    if (result.searchConfidence !== 'clear' && result.searchConfidence !== 'ambiguous' && result.searchConfidence !== null) {
      throw new Error(`outcomes[${index}].results[${resultIndex}].searchConfidence must be clear, ambiguous, or null`);
    }
  }
}

function validateOutcomes(outcomes: readonly KnowledgeBenchmarkQuestionOutcome[]): void {
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    throw new Error('outcomes must contain at least one question outcome');
  }

  const seenIds = new Set<string>();
  for (const [index, outcome] of outcomes.entries()) {
    validateOutcome(outcome, index);
    if (seenIds.has(outcome.id)) {
      throw new Error(`Duplicate outcome id "${outcome.id}"`);
    }
    seenIds.add(outcome.id);
  }
}

function validateValues(values: readonly number[]): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('values must contain at least one number');
  }
  for (const [index, value] of values.entries()) {
    assertFiniteNumber(value, `values[${index}]`);
  }
}

function countRate(count: number, total: number): MetricCountRate {
  return {
    count,
    total,
    rate: roundMetric(count / total),
  };
}

function isRelevant(title: string, expectedPaths: readonly string[]): boolean {
  return expectedPaths.includes(title);
}

function discount(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

function metricAtRank(
  outcomes: readonly KnowledgeBenchmarkQuestionOutcome[],
  limit: number,
): MetricCountRate {
  let count = 0;
  for (const outcome of outcomes) {
    const relevant = outcome.results.slice(0, limit).some((result) => isRelevant(result.title, outcome.expectedPaths));
    if (relevant) {
      count += 1;
    }
  }
  return countRate(count, outcomes.length);
}

function reciprocalRank(outcome: KnowledgeBenchmarkQuestionOutcome): number {
  const firstRelevantIndex = outcome.results.findIndex((result) => isRelevant(result.title, outcome.expectedPaths));
  return firstRelevantIndex < 0 ? 0 : 1 / (firstRelevantIndex + 1);
}

function dcgAt10(outcome: KnowledgeBenchmarkQuestionOutcome): number {
  let score = 0;
  for (const [index, result] of outcome.results.slice(0, MAX_RANK).entries()) {
    if (isRelevant(result.title, outcome.expectedPaths)) {
      score += discount(index + 1);
    }
  }
  return score;
}

function idealDcgAt10(outcome: KnowledgeBenchmarkQuestionOutcome): number {
  const idealRelevantCount = Math.min(outcome.expectedPaths.length, MAX_RANK);
  let score = 0;
  for (let rank = 1; rank <= idealRelevantCount; rank += 1) {
    score += discount(rank);
  }
  return score;
}

export function calculateKnowledgeBenchmarkQuality(
  outcomes: readonly KnowledgeBenchmarkQuestionOutcome[],
): KnowledgeBenchmarkQualityMetrics {
  validateOutcomes(outcomes);

  let reciprocalRankTotal = 0;
  let ndcgTotal = 0;
  let zeroResultCount = 0;
  let ambiguityCount = 0;
  let exactSpanCitationCount = 0;
  let typedGraphEvidenceCount = 0;

  for (const outcome of outcomes) {
    reciprocalRankTotal += reciprocalRank(outcome);
    const ideal = idealDcgAt10(outcome);
    ndcgTotal += ideal === 0 ? 0 : dcgAt10(outcome) / ideal;

    if (outcome.results.length === 0) {
      zeroResultCount += 1;
    }
    if (outcome.results[0]?.searchConfidence === 'ambiguous') {
      ambiguityCount += 1;
    }
    if (outcome.results.some((result) => isRelevant(result.title, outcome.expectedPaths) && result.hasSpanCitation)) {
      exactSpanCitationCount += 1;
    }
    if (outcome.hasTypedGraphEvidence) {
      typedGraphEvidenceCount += 1;
    }
  }

  return {
    recallAt1: metricAtRank(outcomes, 1),
    recallAt3: metricAtRank(outcomes, 3),
    recallAt10: metricAtRank(outcomes, MAX_RANK),
    meanReciprocalRank: roundMetric(reciprocalRankTotal / outcomes.length),
    ndcgAt10: roundMetric(ndcgTotal / outcomes.length),
    zeroResultRate: countRate(zeroResultCount, outcomes.length),
    ambiguityRate: countRate(ambiguityCount, outcomes.length),
    exactSpanCitationRate: countRate(exactSpanCitationCount, outcomes.length),
    typedGraphEvidenceRate: countRate(typedGraphEvidenceCount, outcomes.length),
  };
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number {
  validateValues(values);
  assertFiniteNumber(percentile, 'percentile');
  if (percentile <= 0 || percentile > 1) {
    throw new Error('percentile must be greater than 0 and less than or equal to 1');
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const nearestRankIndex = Math.ceil(percentile * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(nearestRankIndex, 0), sortedValues.length - 1)];
}

export function roundMetric(value: number, digits = DEFAULT_ROUND_DIGITS): number {
  assertFiniteNumber(value, 'value');
  if (!Number.isInteger(digits) || digits < 0) {
    throw new Error('digits must be a non-negative integer');
  }
  return Number(value.toFixed(digits));
}
