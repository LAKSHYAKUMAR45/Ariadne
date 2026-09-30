import path from 'node:path';
import { redact } from '../../Redactor.js';
import type { ExtractionDiagnostic } from '../KnowledgeExtraction.js';

export type AnalyzerCoverageStatus = 'supported' | 'partial' | 'unsupported' | 'failed';

export type AnalyzerUnsupportedReason =
  | 'no_analyzer'
  | 'unknown_format'
  | 'adapter_missing'
  | 'binary_or_non_text'
  | 'size_limit_exceeded'
  | 'policy_rejected'
  | 'parser_failed';

export const ANALYZER_COVERAGE_STATUSES: readonly AnalyzerCoverageStatus[] = ['supported', 'partial', 'unsupported', 'failed'];

export const ANALYZER_UNSUPPORTED_REASONS: readonly AnalyzerUnsupportedReason[] = [
  'no_analyzer',
  'unknown_format',
  'adapter_missing',
  'binary_or_non_text',
  'size_limit_exceeded',
  'policy_rejected',
  'parser_failed',
];

export const ANALYZER_COVERAGE_DIAGNOSTIC_CODES = [
  'coverage_no_analyzer',
  'coverage_unknown_format',
  'coverage_adapter_missing',
  'coverage_binary_or_non_text',
  'coverage_size_limit_exceeded',
  'coverage_generated_code_detected',
  'coverage_partial_dynamic_relationships',
  'coverage_parser_failed',
  'coverage_policy_rejected',
] as const;

export type AnalyzerCoverageDiagnosticCode = (typeof ANALYZER_COVERAGE_DIAGNOSTIC_CODES)[number];

export const MAX_COVERAGE_DIAGNOSTICS = 8;
export const MAX_COVERAGE_MESSAGE_LENGTH = 280;
export const MAX_COVERAGE_FEATURES = 16;
export const MAX_COVERAGE_FEATURE_LENGTH = 64;
const GENERATED_HEADER_WINDOW = 2_048;
const TRUNCATION_SUFFIX = ' …[truncated]';

export interface AnalyzerCoverageSummary {
  status: AnalyzerCoverageStatus;
  analyzerId: string | null;
  analyzerVersion: string | null;
  generatedCode: boolean;
  generatedReason: string | null;
  supportedFeatures: string[];
  missingFeatures: string[];
  warnings: ExtractionDiagnostic[];
  unsupportedReason?: AnalyzerUnsupportedReason;
}

export interface CoverageSelectionInput {
  sourcePath?: string | null;
  mimeType?: string | null;
}

const UNSUPPORTED_DIAGNOSTIC_CODES: Readonly<Record<AnalyzerUnsupportedReason, AnalyzerCoverageDiagnosticCode>> = {
  no_analyzer: 'coverage_no_analyzer',
  unknown_format: 'coverage_unknown_format',
  adapter_missing: 'coverage_adapter_missing',
  binary_or_non_text: 'coverage_binary_or_non_text',
  size_limit_exceeded: 'coverage_size_limit_exceeded',
  policy_rejected: 'coverage_policy_rejected',
  parser_failed: 'coverage_parser_failed',
};

const UNSUPPORTED_EXPLANATIONS: Readonly<Record<AnalyzerUnsupportedReason, string>> = {
  no_analyzer: 'no deterministic analyzer is registered for this source',
  unknown_format: 'the source format could not be identified',
  adapter_missing: 'the format needs an optional adapter that is not installed',
  binary_or_non_text: 'the source is binary or not valid UTF-8 text',
  size_limit_exceeded: 'the source exceeds the analysis size limit',
  policy_rejected: 'a source policy rejected analysis of this source',
  parser_failed: 'the parser could not process this source',
};

const ADAPTER_FORMAT_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.odt', '.epub',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.svg',
  '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.mp4', '.mov', '.mkv', '.webm', '.avi',
]);
const ADAPTER_FORMAT_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const ADAPTER_FORMAT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const BINARY_MIMES = new Set([
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-sqlite3',
  'application/wasm',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'pipfile.lock',
  'cargo.lock', 'gemfile.lock', 'composer.lock', 'go.sum',
]);
const BUILD_OUTPUT_SEGMENTS = new Set(['dist', 'node_modules', '__pycache__', '.next']);
const GENERATED_PATH_PATTERN = /(_pb2(_grpc)?\.pyi?|\.pb\.go|\.g\.dart|\.generated\.[a-z]+|\.gen\.[a-z]+)$/i;
const GENERATED_MARKER_PATTERN = /@generated\b|\bcode generated\b.*\bdo not edit\b|\bauto-?generated\b.*\bdo not edit\b/i;

function normalizeMime(mimeType: string | null | undefined): string | null {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function extensionOf(sourcePath: string | null | undefined): string | null {
  const extension = sourcePath ? path.extname(sourcePath).toLowerCase() : '';
  return extension.length > 0 ? extension : null;
}

export function classifyUnsupportedSource(input: CoverageSelectionInput): AnalyzerUnsupportedReason {
  const mime = normalizeMime(input.mimeType);
  const extension = extensionOf(input.sourcePath);
  if (mime === null && extension === null) return 'unknown_format';
  if (
    (extension !== null && ADAPTER_FORMAT_EXTENSIONS.has(extension)) ||
    (mime !== null && (ADAPTER_FORMAT_MIMES.has(mime) || ADAPTER_FORMAT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))))
  ) {
    return 'adapter_missing';
  }
  if (mime !== null && BINARY_MIMES.has(mime)) return 'binary_or_non_text';
  return 'no_analyzer';
}

export function detectGeneratedCode(input: { sourcePath?: string | null; content?: string | null }): {
  generated: boolean;
  reason: string | null;
} {
  const sourcePath = input.sourcePath?.replace(/\\/g, '/') ?? '';
  const segments = sourcePath.split('/').filter((segment) => segment.length > 0);
  const name = (segments.at(-1) ?? '').toLowerCase();
  if (LOCKFILE_NAMES.has(name)) return { generated: true, reason: 'lockfile' };
  if (/\.min\.(js|css|mjs)$/.test(name) || segments.slice(0, -1).some((segment) => BUILD_OUTPUT_SEGMENTS.has(segment.toLowerCase()))) {
    return { generated: true, reason: 'build_output' };
  }
  if (GENERATED_PATH_PATTERN.test(name)) return { generated: true, reason: 'generated_path' };
  if (input.content && GENERATED_MARKER_PATTERN.test(input.content.slice(0, GENERATED_HEADER_WINDOW))) {
    return { generated: true, reason: 'generated_marker' };
  }
  return { generated: false, reason: null };
}

export function boundCoverageText(value: string, maxLength: number = MAX_COVERAGE_MESSAGE_LENGTH): string {
  const redacted = redact(value).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - TRUNCATION_SUFFIX.length))}${TRUNCATION_SUFFIX}`;
}

/** Redacts, bounds, deduplicates, and strips spans from diagnostics so coverage never stores source excerpts. */
export function boundCoverageDiagnostics(diagnostics: readonly ExtractionDiagnostic[]): ExtractionDiagnostic[] {
  const bounded = new Map<string, ExtractionDiagnostic>();
  for (const diagnostic of diagnostics) {
    const code = boundCoverageText(diagnostic.code, MAX_COVERAGE_FEATURE_LENGTH);
    const message = boundCoverageText(diagnostic.message);
    const key = `${code}\0${diagnostic.severity}\0${message}`;
    if (!bounded.has(key)) bounded.set(key, { code, message, severity: diagnostic.severity });
    if (bounded.size >= MAX_COVERAGE_DIAGNOSTICS) break;
  }
  return [...bounded.values()];
}

export function boundCoverageFeatures(features: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const feature of features) {
    const bounded = boundCoverageText(feature, MAX_COVERAGE_FEATURE_LENGTH);
    if (bounded.length > 0) unique.add(bounded);
    if (unique.size >= MAX_COVERAGE_FEATURES) break;
  }
  return [...unique];
}

function describeSource(input: CoverageSelectionInput): string {
  const mime = normalizeMime(input.mimeType) ?? 'unknown MIME';
  return `${mime}, ${extensionOf(input.sourcePath) ?? 'no extension'}`;
}

export function unsupportedDiagnostic(
  reason: AnalyzerUnsupportedReason,
  input: CoverageSelectionInput,
  severity: ExtractionDiagnostic['severity'] = 'warning',
): ExtractionDiagnostic {
  return {
    code: UNSUPPORTED_DIAGNOSTIC_CODES[reason],
    message: boundCoverageText(`Source not analyzed (${describeSource(input)}): ${UNSUPPORTED_EXPLANATIONS[reason]}.`),
    severity,
  };
}

export function unsupportedCoverage(
  reason: AnalyzerUnsupportedReason,
  input: CoverageSelectionInput,
  options: { status?: 'unsupported' | 'failed'; analyzerId?: string | null; analyzerVersion?: string | null } = {},
): AnalyzerCoverageSummary {
  const status = options.status ?? 'unsupported';
  const generated = detectGeneratedCode({ sourcePath: input.sourcePath });
  return {
    status,
    analyzerId: options.analyzerId ?? null,
    analyzerVersion: options.analyzerVersion ?? null,
    generatedCode: generated.generated,
    generatedReason: generated.reason,
    supportedFeatures: [],
    missingFeatures: [],
    warnings: [unsupportedDiagnostic(reason, input, status === 'failed' ? 'error' : 'warning')],
    unsupportedReason: reason,
  };
}

export type OptionalIngestOutcome =
  | { status: 'unsupported'; reason: 'no_adapter' | 'unknown_format' }
  | { status: 'failed'; code: 'parser_failed' | 'size_limit_exceeded' };

/** Maps a `DocumentIngestor`/`MediaIngestor` outcome to unified coverage; raw parser errors are never carried over. */
export function coverageFromOptionalIngest(
  outcome: OptionalIngestOutcome,
  input: CoverageSelectionInput,
): AnalyzerCoverageSummary {
  if (outcome.status === 'unsupported') {
    return unsupportedCoverage(outcome.reason === 'no_adapter' ? 'adapter_missing' : 'unknown_format', input);
  }
  return outcome.code === 'parser_failed'
    ? unsupportedCoverage('parser_failed', input, { status: 'failed' })
    : unsupportedCoverage('size_limit_exceeded', input);
}

export function supportedAnalyzerCoverage(
  analyzer: { id: string; version: string },
  input: CoverageSelectionInput,
): AnalyzerCoverageSummary {
  const generated = detectGeneratedCode({ sourcePath: input.sourcePath });
  return {
    status: 'supported',
    analyzerId: analyzer.id,
    analyzerVersion: analyzer.version,
    generatedCode: generated.generated,
    generatedReason: generated.reason,
    supportedFeatures: ['deterministic_extraction'],
    missingFeatures: [],
    warnings: [],
  };
}

export function generatedCodeDiagnostic(reason: string): ExtractionDiagnostic {
  return {
    code: 'coverage_generated_code_detected',
    message: boundCoverageText(`Generated code detected (${reason}); analysis continued.`),
    severity: 'info',
  };
}
