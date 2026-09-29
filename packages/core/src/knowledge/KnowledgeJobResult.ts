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
 * Reserved union member: the analyzer-coverage slice defines, writes, and
 * parses the `coverage_only` variant. Until then readers treat it as unknown.
 */
export type KnowledgeCoverageOnlyJobResult = never;

export type KnowledgeJobResult = KnowledgeAnalyzedJobResult | KnowledgeCoverageOnlyJobResult;

export type KnowledgeJobProcessingMode = KnowledgeJobResultBase['processingMode'] | 'unknown';

/** Writer input: the envelope discriminator is optional so existing callers stay compatible. */
export type KnowledgeJobResultInput = Omit<KnowledgeAnalyzedJobResult, 'resultKind'> & {
  resultKind?: 'analyzed';
};

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
  if (!Array.isArray(value.warnings)) {
    throw new Error('Knowledge queue result warnings must be an array');
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
    warnings: value.warnings.map((warning) => {
      if (!isRecord(warning)) throw new Error('Knowledge queue result warning must be an object');
      return {
        code: requireNonEmptyString(warning.code, 'result warning code'),
        message: requireNonEmptyString(warning.message, 'result warning message'),
      };
    }),
    ...(coverageStatus !== undefined ? { coverageStatus } : {}),
  };
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
    const result = validateAnalyzedJobResult(JSON.parse(resultJson) as unknown, {
      requireResultKind: schemaVersion !== null,
    });
    return { result: { ...result, legacyState }, legacyState };
  } catch {
    return UNKNOWN;
  }
}
