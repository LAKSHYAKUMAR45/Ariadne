import { ANALYZER_UNSUPPORTED_REASONS, type AnalyzerUnsupportedReason } from './analyzers/AnalyzerCoverage.js';

export type KnowledgeJobResultLegacyState = 'current' | 'legacy_payload' | 'legacy_unknown';

export interface KnowledgeJobResultWarning {
  code: string;
  message: string;
}

export interface KnowledgeJobResultBase {
  resultKind: 'analyzed' | 'coverage_only';
  processingMode: 'deterministic' | 'enriched';
  warnings: KnowledgeJobResultWarning[];
  legacyState?: KnowledgeJobResultLegacyState;
}

export interface KnowledgeAnalyzedJobResult extends KnowledgeJobResultBase {
  resultKind: 'analyzed';
  analyzerId: string;
  analyzerVersion: string;
  extractionId: string;
  pageVersionIds: string[];
  graphNodeCount: number;
  graphEdgeCount: number;
  coverageStatus?: 'supported' | 'partial';
}

/**
 * An unsupported source completes without an analyzer or extraction. The coverage row keyed by source version is
 * authoritative; this payload is a pointer plus bounded warnings, so no coverage ID is embedded.
 */
export interface KnowledgeCoverageOnlyJobResult extends KnowledgeJobResultBase {
  resultKind: 'coverage_only';
  processingMode: 'deterministic';
  coverageStatus: 'unsupported';
  unsupportedReason: AnalyzerUnsupportedReason;
  analyzerId: null;
  analyzerVersion: null;
  extractionId: null;
}

export type KnowledgeJobResult = KnowledgeAnalyzedJobResult | KnowledgeCoverageOnlyJobResult;

export type KnowledgeJobProcessingMode = KnowledgeJobResultBase['processingMode'] | 'unknown';

/** Writer input: the envelope discriminator is optional so existing callers stay compatible. */
export type KnowledgeJobResultInput =
  | (Omit<KnowledgeAnalyzedJobResult, 'resultKind'> & { resultKind?: 'analyzed' })
  | KnowledgeCoverageOnlyJobResult;

export const KNOWLEDGE_JOB_RESULT_SCHEMA_VERSION = 1;

export interface ParsedKnowledgeJobResult {
  result: KnowledgeJobResult | null;
  legacyState: KnowledgeJobResultLegacyState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Knowledge queue ${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Knowledge queue ${label} must be a non-negative integer`);
  }
  return value as number;
}

function validateWarnings(value: unknown): KnowledgeJobResultWarning[] {
  if (!Array.isArray(value)) {
    throw new Error('Knowledge queue result warnings must be an array');
  }
  return value.map((warning) => {
    if (!isRecord(warning)) throw new Error('Knowledge queue result warning must be an object');
    return {
      code: requireNonEmptyString(warning.code, 'result warning code'),
      message: requireNonEmptyString(warning.message, 'result warning message'),
    };
  });
}

/**
 * Validates an analyzed result. `requireResultKind` is true for versioned
 * envelopes; legacy payloads have no discriminator and are read as analyzed.
 */
export function validateAnalyzedJobResult(
  value: unknown,
  options: { requireResultKind: boolean } = { requireResultKind: false },
): KnowledgeAnalyzedJobResult {
  if (!isRecord(value)) throw new Error('Knowledge queue result must be an object');
  if (value.resultKind === undefined ? options.requireResultKind : value.resultKind !== 'analyzed') {
    throw new Error('Knowledge queue result resultKind must be analyzed');
  }
  const processingMode = value.processingMode;
  if (processingMode !== 'deterministic' && processingMode !== 'enriched') {
    throw new Error('Knowledge queue result processingMode must be deterministic or enriched');
  }
  if (!Array.isArray(value.pageVersionIds)) {
    throw new Error('Knowledge queue result pageVersionIds must be an array');
  }
  const coverageStatus = value.coverageStatus;
  if (coverageStatus !== undefined && coverageStatus !== 'supported' && coverageStatus !== 'partial') {
    throw new Error('Knowledge queue result coverageStatus must be supported or partial');
  }
  return {
    resultKind: 'analyzed',
    processingMode,
    analyzerId: requireNonEmptyString(value.analyzerId, 'result analyzerId'),
    analyzerVersion: requireNonEmptyString(value.analyzerVersion, 'result analyzerVersion'),
    extractionId: requireNonEmptyString(value.extractionId, 'result extractionId'),
    pageVersionIds: value.pageVersionIds.map((item) => requireNonEmptyString(item, 'result pageVersionId')),
    graphNodeCount: requireNonNegativeInteger(value.graphNodeCount, 'result graphNodeCount'),
    graphEdgeCount: requireNonNegativeInteger(value.graphEdgeCount, 'result graphEdgeCount'),
    warnings: validateWarnings(value.warnings),
    ...(coverageStatus !== undefined ? { coverageStatus } : {}),
  };
}

export function validateCoverageOnlyJobResult(value: unknown): KnowledgeCoverageOnlyJobResult {
  if (!isRecord(value)) throw new Error('Knowledge queue result must be an object');
  if (value.resultKind !== 'coverage_only') {
    throw new Error('Knowledge queue result resultKind must be coverage_only');
  }
  if (value.processingMode !== 'deterministic') {
    throw new Error('Knowledge queue coverage_only result processingMode must be deterministic');
  }
  if (value.coverageStatus !== 'unsupported') {
    throw new Error('Knowledge queue coverage_only result coverageStatus must be unsupported');
  }
  if (!ANALYZER_UNSUPPORTED_REASONS.includes(value.unsupportedReason as AnalyzerUnsupportedReason)) {
    throw new Error('Knowledge queue coverage_only result unsupportedReason must be a known reason');
  }
  if (value.analyzerId !== null || value.analyzerVersion !== null || value.extractionId !== null) {
    throw new Error('Knowledge queue coverage_only result must not carry analyzer or extraction identity');
  }
  return {
    resultKind: 'coverage_only',
    processingMode: 'deterministic',
    coverageStatus: 'unsupported',
    unsupportedReason: value.unsupportedReason as AnalyzerUnsupportedReason,
    analyzerId: null,
    analyzerVersion: null,
    extractionId: null,
    warnings: validateWarnings(value.warnings),
  };
}

/** Validates a versioned (schema version 1) envelope, dispatching on `resultKind`. */
export function validateVersionedJobResult(value: unknown): KnowledgeJobResult {
  if (isRecord(value) && value.resultKind === 'coverage_only') return validateCoverageOnlyJobResult(value);
  return validateAnalyzedJobResult(value, { requireResultKind: true });
}

const UNKNOWN: ParsedKnowledgeJobResult = { result: null, legacyState: 'legacy_unknown' };

/**
 * Tolerant reader for `knowledge_jobs.result_json`. It never throws: unknown
 * modes, unparseable JSON, malformed shapes, and unsupported versions all map
 * to an explicit `legacy_unknown` state with no structured result.
 */
export function parseStoredKnowledgeJobResult(
  resultJson: string | null,
  schemaVersion: number | null,
  processingMode: KnowledgeJobProcessingMode | null,
  status: string,
): ParsedKnowledgeJobResult {
  if (resultJson === null) {
    return status === 'completed' ? UNKNOWN : { result: null, legacyState: null };
  }
  if (processingMode === 'unknown') return UNKNOWN;
  if (schemaVersion !== null && schemaVersion !== KNOWLEDGE_JOB_RESULT_SCHEMA_VERSION) return UNKNOWN;
  try {
    const legacyState = schemaVersion === null ? 'legacy_payload' : 'current';
    const parsedJson = JSON.parse(resultJson) as unknown;
    const result =
      schemaVersion === null
        ? validateAnalyzedJobResult(parsedJson, { requireResultKind: false })
        : validateVersionedJobResult(parsedJson);
    return { result: { ...result, legacyState }, legacyState };
  } catch {
    return UNKNOWN;
  }
}
