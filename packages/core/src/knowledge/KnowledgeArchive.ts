import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeKnowledgePath } from './KnowledgeIds.js';
import { assertNoSymlinkComponents, isPathWithinRoot } from './KnowledgePathSecurity.js';
import {
  KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2,
  KNOWLEDGE_ARCHIVE_HOST_SETTING_ROW_FILTER,
  KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS,
  KNOWLEDGE_ARCHIVE_SETTINGS_TABLE,
  KNOWLEDGE_ARCHIVE_TABLE_REGISTRY,
  assertTableFingerprints,
  assessAuthenticity,
  assessManifestCompatibility,
  expectedOmissions,
  featuresForTables,
  getKnowledgeArchiveRegistration,
  importRejected,
  manifestVersionIncompatible,
  preservedTableColumns,
  rebuildTargetsAfterImport,
  registeredTablesOfClass,
  reviewArchiveDataFiles,
  signKnowledgeArchiveManifest,
  type KnowledgeArchiveAuthenticity,
  type KnowledgeArchiveAuthenticityResult,
  type KnowledgeArchiveAuthenticitySigner,
  type KnowledgeArchiveAuthenticityVerifier,
  type KnowledgeArchiveCompatibilityBlock,
  type KnowledgeArchiveCompatibilityPolicy,
  type KnowledgeArchiveRebuildTarget,
  type KnowledgeArchiveWarning,
} from './KnowledgeArchiveCompatibility.js';
import { KNOWLEDGE_HOST_SETTING_PREFIX, KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';
import { parseCitationContext } from './KnowledgeCitationContext.js';
import {
  KNOWLEDGE_SEMANTIC_SUMMARIES_TABLE,
  assertArchiveSummaryRows,
  redactSummaryRowsForExport,
} from './KnowledgeArchiveSummaries.js';
import { parsePersistedKnowledgeSynthesis } from './KnowledgeSynthesisPersistence.js';
import { renderKnowledgePage } from './KnowledgeRenderer.js';

export { KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS, KNOWLEDGE_ARCHIVE_TABLE_REGISTRY };
export type {
  KnowledgeArchiveAuthenticity,
  KnowledgeArchiveAuthenticityResult,
  KnowledgeArchiveAuthenticitySigner,
  KnowledgeArchiveAuthenticityVerifier,
  KnowledgeArchiveCompatibilityBlock,
  KnowledgeArchiveCompatibilityPolicy,
  KnowledgeArchiveWarning,
};

/** Version written by default when a project has no version 2 only data. */
export const KNOWLEDGE_ARCHIVE_VERSION = 1 as const;

export interface KnowledgeArchiveEntry {
  path: string;
  size: number;
  sha256: string;
  mediaType: string;
}

export interface KnowledgeArchiveManifest {
  archiveVersion: 1 | 2;
  format: 'ariadne-knowledge-archive';
  projectId: string;
  generatedAt: string;
  entries: KnowledgeArchiveEntry[];
  omitted: string[];
  compatibility?: KnowledgeArchiveCompatibilityBlock;
  authenticity?: KnowledgeArchiveAuthenticity;
}

export interface KnowledgeArchiveManifestV2 extends KnowledgeArchiveManifest {
  archiveVersion: 2;
  compatibility: KnowledgeArchiveCompatibilityBlock;
}

export type KnowledgeArchiveFile = string | Uint8Array;

export interface KnowledgeArchive {
  manifest: KnowledgeArchiveManifest;
  files: Record<string, KnowledgeArchiveFile>;
}

export interface ExportKnowledgeProjectOptions {
  projectId: string;
  generatedAt?: string;
  contentRoot?: string;
  pageContents?: Record<string, string>;
  includeObsidian?: boolean;
  manifestVersion?: 1 | 2 | 'auto';
  authenticitySigner?: KnowledgeArchiveAuthenticitySigner;
}

export interface ImportKnowledgeProjectOptions {
  replaceExisting?: boolean;
  expectedProjectId?: string;
  workspaceRoot?: string;
  compatibilityPolicy?: KnowledgeArchiveCompatibilityPolicy;
  authenticityVerifier?: KnowledgeArchiveAuthenticityVerifier;
}

export interface ImportResult {
  projectId: string;
  tables: number;
  rows: number;
  files: string[];
  warnings: KnowledgeArchiveWarning[];
  postImport: { rebuildRequired: KnowledgeArchiveRebuildTarget[] };
  authenticity: KnowledgeArchiveAuthenticityResult;
}

const ANALYSIS_COVERAGE_FEATURE = 'knowledge-analysis-coverage-v1';
const COVERAGE_TABLES: ReadonlySet<string> = new Set(['knowledge_analysis_coverage', 'knowledge_deferred_relationships']);

const TABLES = [
  'knowledge_projects',
  'knowledge_project_roots',
  'knowledge_settings',
  'knowledge_schema_versions',
  'knowledge_sources',
  'knowledge_source_versions',
  'knowledge_source_assets',
  'knowledge_source_spans',
  'knowledge_analysis_coverage',
  'knowledge_deferred_relationships',
  'knowledge_extractions',
  'knowledge_pages',
  'knowledge_page_versions',
  'knowledge_semantic_summaries',
  'knowledge_page_sources',
  'knowledge_page_provenance',
  'knowledge_page_aliases',
  'knowledge_page_links',
  'knowledge_graph_nodes',
  'knowledge_graph_edges',
  'knowledge_graph_snapshots',
  'knowledge_graph_reports',
  'knowledge_graph_ambiguities',
  'knowledge_communities',
  'knowledge_insights',
  'knowledge_jobs',
  'knowledge_job_events',
  'knowledge_reviews',
  'knowledge_review_actions',
  'knowledge_research_runs',
  'knowledge_research_results',
  'knowledge_conversations',
  'knowledge_messages',
  'knowledge_outputs',
  'knowledge_operation_log',
] as const;

/** Tables written as `data/<table>.json`, in foreign-key dependency order. */
export const KNOWLEDGE_ARCHIVE_TABLES: readonly string[] = TABLES;

const OMITTED_TABLES = ['knowledge_provider_profiles'];
const SUPPORTED_TABLE_NAMES: ReadonlySet<string> = new Set(TABLES);

type ArchiveTableName = (typeof TABLES)[number];

interface ArchiveTableSchema {
  name: ArchiveTableName;
  columns: readonly string[];
  optionalColumns?: readonly string[];
  identityColumns?: readonly string[];
}

type ArchiveColumnKind = 'text' | 'integer' | 'real';

interface ArchiveColumnInfo {
  kind: ArchiveColumnKind;
}

interface ArchiveImportPlan {
  projectId: string;
  workspaceRoot: string;
  files: string[];
  rowsByTable: Map<ArchiveTableName, Record<string, unknown>[]>;
  materializedFiles: ArchiveMaterializedFile[];
  staleArtifactPaths: string[];
  tables: number;
  rows: number;
  warnings: KnowledgeArchiveWarning[];
  authenticity: KnowledgeArchiveAuthenticityResult;
}

type ArchiveArtifactRoot = 'knowledge-root' | 'workspace-root';

interface ArchiveArtifactSpec {
  table: ArchiveTableName;
  column: string;
  root: ArchiveArtifactRoot;
  hashColumn?: string;
  sizeColumn?: string;
  requiredOnExport?: boolean;
}

interface ArchiveMaterializedFile {
  archivePath: string;
  absolutePath: string;
  content: Uint8Array;
}

const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ROWS_PER_TABLE = 50_000;
const MAX_ARCHIVE_TOTAL_ROWS = 200_000;
const MAX_ARCHIVE_STRING_LENGTH = 1_000_000;
const REDACTED_WORKSPACE_ROOT = '__redacted_workspace_root__';
const ARCHIVE_CONTENT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const ALLOWED_KNOWLEDGE_SEARCH_MODES = new Set<string>(['knowledge', 'sources', 'tasks', 'hybrid', 'read-sources-only']);

type ArchivePathPolicy = 'workspace-relative' | 'source-storage-relative' | 'conversation-storage-relative';

const PATH_POLICY_BY_COLUMN = new Map<string, ArchivePathPolicy>([
  ['knowledge_project_roots.root_path', 'workspace-relative'],
  ['knowledge_sources.source_path', 'workspace-relative'],
  ['knowledge_source_versions.content_path', 'source-storage-relative'],
  ['knowledge_source_assets.asset_path', 'workspace-relative'],
  ['knowledge_extractions.result_path', 'workspace-relative'],
  ['knowledge_page_versions.content_path', 'workspace-relative'],
  ['knowledge_graph_snapshots.content_path', 'workspace-relative'],
  ['knowledge_insights.content_path', 'workspace-relative'],
  ['knowledge_research_results.content_path', 'workspace-relative'],
  ['knowledge_messages.content_path', 'conversation-storage-relative'],
  ['knowledge_outputs.content_path', 'workspace-relative'],
]);

const ARTIFACT_SPEC_BY_COLUMN = new Map<string, ArchiveArtifactSpec>([
  [
    'knowledge_source_versions.content_path',
    {
      table: 'knowledge_source_versions',
      column: 'content_path',
      root: 'knowledge-root',
      hashColumn: 'content_hash',
      sizeColumn: 'byte_length',
      requiredOnExport: true,
    },
  ],
  [
    'knowledge_page_versions.content_path',
    {
      table: 'knowledge_page_versions',
      column: 'content_path',
      root: 'knowledge-root',
      hashColumn: 'content_hash',
    },
  ],
  [
    'knowledge_graph_snapshots.content_path',
    {
      table: 'knowledge_graph_snapshots',
      column: 'content_path',
      root: 'knowledge-root',
      hashColumn: 'content_hash',
      requiredOnExport: true,
    },
  ],
  [
    'knowledge_research_results.content_path',
    {
      table: 'knowledge_research_results',
      column: 'content_path',
      root: 'knowledge-root',
      hashColumn: 'content_hash',
      requiredOnExport: true,
    },
  ],
  [
    'knowledge_messages.content_path',
    {
      table: 'knowledge_messages',
      column: 'content_path',
      root: 'workspace-root',
      requiredOnExport: true,
    },
  ],
  [
    'knowledge_outputs.content_path',
    {
      table: 'knowledge_outputs',
      column: 'content_path',
      root: 'knowledge-root',
      hashColumn: 'content_hash',
      requiredOnExport: true,
    },
  ],
]);

const TABLE_SCHEMAS: readonly ArchiveTableSchema[] = [
  {
    name: 'knowledge_projects',
    columns: ['id', 'workspace_root', 'name', 'description', 'status', 'created_at', 'updated_at'],
    optionalColumns: ['description'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_project_roots',
    columns: ['id', 'project_id', 'root_path', 'created_at', 'updated_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_settings',
    columns: ['id', 'project_id', 'setting_key', 'setting_value', 'created_at', 'updated_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_schema_versions',
    columns: ['id', 'project_id', 'version', 'applied_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_sources',
    columns: ['id', 'project_id', 'source_kind', 'source_path', 'source_url', 'title', 'current_hash', 'status', 'created_at', 'updated_at'],
    optionalColumns: ['source_path', 'source_url', 'title', 'current_hash'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_source_versions',
    columns: ['id', 'project_id', 'source_id', 'version_number', 'content_hash', 'content_path', 'byte_length', 'mime_type', 'created_at'],
    optionalColumns: ['mime_type'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_source_assets',
    columns: ['id', 'project_id', 'source_version_id', 'asset_path', 'content_hash', 'mime_type', 'byte_length', 'created_at'],
    optionalColumns: ['mime_type'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_source_spans',
    columns: ['id', 'project_id', 'source_version_id', 'start_offset', 'end_offset', 'start_line', 'start_column', 'end_line', 'end_column', 'label', 'created_at'],
    optionalColumns: ['start_line', 'start_column', 'end_line', 'end_column', 'label'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_analysis_coverage',
    columns: ['id', 'project_id', 'source_version_id', 'status', 'analyzer_id', 'analyzer_version', 'generated_code', 'generated_reason', 'unsupported_reason', 'supported_features_json', 'missing_features_json', 'diagnostics_json', 'created_at', 'updated_at'],
    optionalColumns: ['analyzer_id', 'analyzer_version', 'generated_reason', 'unsupported_reason'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_deferred_relationships',
    columns: ['id', 'project_id', 'source_version_id', 'relationship_type', 'source_symbol_id', 'target_symbol_id', 'target_reference', 'resolution_kind', 'evidence_kind', 'confidence', 'span_id', 'metadata_json', 'created_at'],
    optionalColumns: ['source_symbol_id', 'target_symbol_id', 'target_reference', 'span_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_extractions',
    columns: ['id', 'project_id', 'source_version_id', 'extractor_kind', 'analyzer_id', 'analyzer_version', 'result_path', 'content_hash', 'extraction_hash', 'result_json', 'diagnostics_json', 'status', 'completed_at', 'created_at', 'updated_at'],
    optionalColumns: ['analyzer_id', 'analyzer_version', 'extraction_hash', 'result_json', 'diagnostics_json', 'completed_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_pages',
    columns: ['id', 'project_id', 'page_type', 'title', 'slug', 'status', 'created_at', 'updated_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_page_versions',
    columns: ['id', 'project_id', 'page_id', 'version_number', 'content_hash', 'content_path', 'summary', 'created_at'],
    optionalColumns: ['summary'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_semantic_summaries',
    columns: ['id', 'project_id', 'scope_kind', 'scope_id', 'strategy', 'provider_profile_name', 'summary_json', 'warnings_json', 'created_at', 'updated_at'],
    optionalColumns: ['provider_profile_name'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_page_sources',
    columns: ['page_version_id', 'project_id', 'source_version_id', 'created_at'],
    identityColumns: ['page_version_id', 'source_version_id'],
  },
  {
    name: 'knowledge_page_provenance',
    columns: ['id', 'project_id', 'page_version_id', 'source_kind', 'source_id', 'source_span_id', 'confidence', 'created_at'],
    optionalColumns: ['source_span_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_page_aliases',
    columns: ['id', 'project_id', 'page_id', 'alias', 'created_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_page_links',
    columns: ['id', 'project_id', 'source_page_id', 'target_page_id', 'target_reference', 'created_at'],
    optionalColumns: ['target_page_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_graph_nodes',
    columns: ['id', 'project_id', 'node_type', 'label', 'source_kind', 'source_id', 'qualified_name', 'source_version_id', 'start_offset', 'end_offset', 'start_line', 'start_column', 'end_line', 'end_column', 'span_label', 'confidence', 'created_at', 'updated_at'],
    optionalColumns: [
      'source_kind',
      'source_id',
      'qualified_name',
      'source_version_id',
      'start_offset',
      'end_offset',
      'start_line',
      'start_column',
      'end_line',
      'end_column',
      'span_label',
    ],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_graph_edges',
    columns: ['id', 'project_id', 'source_node_id', 'target_node_id', 'edge_type', 'evidence_json', 'confidence', 'created_at', 'updated_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_graph_snapshots',
    columns: ['id', 'project_id', 'snapshot_number', 'content_hash', 'content_path', 'created_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_graph_reports',
    columns: ['id', 'project_id', 'graph_snapshot_id', 'report_json', 'created_at'],
    optionalColumns: ['graph_snapshot_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_graph_ambiguities',
    columns: ['id', 'project_id', 'graph_snapshot_id', 'source_version_id', 'source_node_id', 'target_node_id', 'ambiguity_kind', 'severity', 'detail_json', 'created_at'],
    optionalColumns: ['graph_snapshot_id', 'source_version_id', 'source_node_id', 'target_node_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_communities',
    columns: ['id', 'project_id', 'graph_snapshot_id', 'label', 'summary', 'created_at'],
    optionalColumns: ['summary'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_insights',
    columns: ['id', 'project_id', 'graph_snapshot_id', 'insight_type', 'content_path', 'confidence', 'created_at'],
    optionalColumns: ['graph_snapshot_id'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_jobs',
    columns: ['id', 'project_id', 'job_kind', 'source_version_id', 'status', 'payload_json', 'result_json', 'result_processing_mode', 'result_schema_version', 'requested_at', 'started_at', 'completed_at', 'failure_code', 'failure_message', 'retry_count', 'max_retries', 'worker_id', 'lease_expires_at'],
    optionalColumns: ['source_version_id', 'result_json', 'result_processing_mode', 'result_schema_version', 'started_at', 'completed_at', 'failure_code', 'failure_message', 'worker_id', 'lease_expires_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_job_events',
    columns: ['id', 'project_id', 'job_id', 'event_kind', 'detail_json', 'created_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_reviews',
    columns: ['id', 'project_id', 'page_version_id', 'status', 'requested_at', 'reviewed_at', 'reviewer_id', 'summary'],
    optionalColumns: ['page_version_id', 'reviewed_at', 'reviewer_id', 'summary'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_review_actions',
    columns: ['id', 'project_id', 'review_id', 'action_kind', 'comment', 'created_at'],
    optionalColumns: ['comment'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_research_runs',
    columns: ['id', 'project_id', 'query', 'status', 'requested_at', 'completed_at', 'failure_message'],
    optionalColumns: ['completed_at', 'failure_message'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_research_results',
    columns: ['id', 'project_id', 'research_run_id', 'result_url', 'title', 'content_hash', 'content_path', 'created_at'],
    optionalColumns: ['title', 'content_hash', 'content_path'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_conversations',
    columns: ['id', 'project_id', 'title', 'created_at', 'updated_at'],
    optionalColumns: ['title'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_messages',
    columns: ['id', 'project_id', 'conversation_id', 'role', 'content_path', 'created_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_outputs',
    columns: ['id', 'project_id', 'output_kind', 'content_hash', 'content_path', 'created_at', 'updated_at'],
    identityColumns: ['id'],
  },
  {
    name: 'knowledge_operation_log',
    columns: ['id', 'project_id', 'operation_kind', 'status', 'detail_json', 'created_at', 'completed_at'],
    optionalColumns: ['completed_at'],
    identityColumns: ['id'],
  },
] as const;

const TABLE_SCHEMA_BY_NAME = new Map(TABLE_SCHEMAS.map((schema) => [schema.name, schema] satisfies readonly [ArchiveTableName, ArchiveTableSchema]));

function assertSafePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || path.posix.normalize(normalized) !== normalized) {
    throw new Error(`Knowledge archive path traversal rejected: ${value}`);
  }
  return normalized;
}

function bytes(value: KnowledgeArchiveFile): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mediaType(filePath: string): string {
  if (filePath.endsWith('.md')) return 'text/markdown';
  if (filePath.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function addFile(files: Record<string, KnowledgeArchiveFile>, filePath: string, content: KnowledgeArchiveFile): void {
  files[assertSafePath(filePath)] = content;
}

function requireNonEmptyArchiveText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw importRejected(`${label} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw importRejected(`${label} must not be empty.`);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function assertArchiveScalar(value: unknown, context: string): void {
  if (value === null) {
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_ARCHIVE_STRING_LENGTH) {
      throw importRejected(`${context} exceeds the maximum supported string length.`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw importRejected(`${context} must be a finite number.`);
    }
    return;
  }
  if (typeof value === 'boolean') {
    return;
  }
  throw importRejected(`${context} must be a JSON scalar value.`);
}

function parseJsonFile(archive: KnowledgeArchive, filePath: string, label: string): unknown {
  const file = archive.files[filePath];
  if (file === undefined) {
    return undefined;
  }
  const encoded = Buffer.from(bytes(file));
  if (encoded.byteLength > MAX_ARCHIVE_ENTRY_BYTES) {
    throw importRejected(`${label} exceeds the maximum supported file size.`);
  }
  try {
    return JSON.parse(encoded.toString('utf8')) as unknown;
  } catch {
    throw importRejected(`${label} must contain valid JSON.`);
  }
}

function parseTableRows(
  archive: KnowledgeArchive,
  schema: ArchiveTableSchema,
  warnings: KnowledgeArchiveWarning[],
): Record<string, unknown>[] {
  const value = parseJsonFile(archive, `data/${schema.name}.json`, `table ${schema.name}`);
  if (value === undefined) {
    if (getKnowledgeArchiveRegistration(schema.name)?.class === 'optional') {
      warnings.push({ code: 'optional_table_absent', message: `Optional archive table ${schema.name} is absent.` });
      return [];
    }
    throw importRejected(`table ${schema.name} is required.`);
  }
  if (!Array.isArray(value)) {
    throw importRejected(`table ${schema.name} must be a JSON array.`);
  }
  if (value.length > MAX_ARCHIVE_ROWS_PER_TABLE) {
    throw importRejected(`table ${schema.name} exceeds the maximum supported row count.`);
  }

  const allowed = new Set(schema.columns);
  const optional = new Set(schema.optionalColumns ?? []);
  const seenIdentities = new Set<string>();

  return value.map((row, index) => {
    const rowNumber = index + 1;
    if (!isPlainObject(row)) {
      throw importRejected(`table ${schema.name} row ${rowNumber} must be a plain object.`);
    }
    const keys = Object.keys(row);
    for (const key of keys) {
      if (!allowed.has(key)) {
        throw importRejected(`table ${schema.name} row ${rowNumber} contains unknown column ${key}.`);
      }
      assertArchiveScalar(row[key], `table ${schema.name} row ${rowNumber} column ${key}`);
    }
    for (const column of schema.columns) {
      if (!optional.has(column) && !Object.prototype.hasOwnProperty.call(row, column)) {
        throw importRejected(`table ${schema.name} row ${rowNumber} is missing required column ${column}.`);
      }
    }
    if (schema.identityColumns && schema.identityColumns.length > 0) {
      const identity = schema.identityColumns
        .map((column) => {
          if (!Object.prototype.hasOwnProperty.call(row, column)) {
            throw importRejected(`table ${schema.name} row ${rowNumber} is missing identity column ${column}.`);
          }
          return JSON.stringify(row[column]);
        })
        .join('|');
      if (seenIdentities.has(identity)) {
        throw importRejected(`table ${schema.name} contains duplicate primary identity rows.`);
      }
      seenIdentities.add(identity);
    }
    return { ...row };
  });
}

function loadTableColumnInfo(
  db: Database.Database,
  table: ArchiveTableName,
  columns: readonly string[],
): ReadonlyMap<string, ArchiveColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>;
  const byName = new Map(rows.map((row) => [row.name, row.type] as const));
  const info = new Map<string, ArchiveColumnInfo>();
  for (const column of columns) {
    const type = byName.get(column)?.toUpperCase();
    if (type === 'TEXT') {
      info.set(column, { kind: 'text' });
      continue;
    }
    if (type === 'INTEGER') {
      info.set(column, { kind: 'integer' });
      continue;
    }
    if (type === 'REAL') {
      info.set(column, { kind: 'real' });
      continue;
    }
    throw new Error(`Unsupported archive schema column type for ${table}.${column}: ${type ?? 'missing'}`);
  }
  return info;
}

function assertArchiveColumnValue(
  value: unknown,
  columnInfo: ArchiveColumnInfo,
  context: string,
  options: { nullable: boolean },
): void {
  if (value === null) {
    if (!options.nullable) {
      throw importRejected(`${context} must not be null.`);
    }
    return;
  }
  if (columnInfo.kind === 'text') {
    if (typeof value !== 'string') {
      throw importRejected(`${context} must be a string.`);
    }
    if (value.length > MAX_ARCHIVE_STRING_LENGTH) {
      throw importRejected(`${context} exceeds the maximum supported string length.`);
    }
    return;
  }
  if (columnInfo.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throw importRejected(`${context} must be a finite integer.`);
    }
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw importRejected(`${context} must be a finite number.`);
  }
}

function knowledgeRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ariadne', 'knowledge');
}

function knowledgeSourceStorageRoot(workspaceRoot: string): string {
  return path.join(knowledgeRoot(workspaceRoot), 'sources');
}

function knowledgeConversationStorageRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, 'conversations');
}

function assertArchivePathValue(
  value: string,
  policy: ArchivePathPolicy,
  workspaceRoot: string,
  context: string,
): void {
  const normalized = normalizeKnowledgePath(value);
  if (policy === 'workspace-relative') {
    return;
  }
  if (policy === 'conversation-storage-relative') {
    const candidate = path.resolve(workspaceRoot, normalized);
    if (!isPathWithinRoot(knowledgeConversationStorageRoot(workspaceRoot), candidate)) {
      throw importRejected(`${context} must stay within conversations/.`);
    }
    try {
      assertNoSymlinkComponents(workspaceRoot, candidate, context);
    } catch (error) {
      throw importRejected(error instanceof Error ? error.message : `${context} must not traverse symbolic links.`);
    }
    return;
  }
  const candidate = path.resolve(knowledgeRoot(workspaceRoot), normalized);
  if (!isPathWithinRoot(knowledgeSourceStorageRoot(workspaceRoot), candidate)) {
    throw importRejected(`${context} must stay within .ariadne/knowledge/sources.`);
  }
  try {
    assertNoSymlinkComponents(workspaceRoot, candidate, context);
  } catch (error) {
    throw importRejected(error instanceof Error ? error.message : `${context} must not traverse symbolic links.`);
  }
}

function validateTableRowValues(
  db: Database.Database,
  schema: ArchiveTableSchema,
  rows: readonly Record<string, unknown>[],
  workspaceRoot: string,
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
): void {
  const optional = new Set(schema.optionalColumns ?? []);
  const columnInfo = loadTableColumnInfo(db, schema.name, schema.columns);
  const taskHistoryIds = taskHistorySourceTaskIds(rowsByTable);
  for (const [index, row] of rows.entries()) {
    for (const column of schema.columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        continue;
      }
      const info = columnInfo.get(column);
      if (!info) {
        throw new Error(`Missing archive column info for ${schema.name}.${column}`);
      }
      assertArchiveColumnValue(row[column], info, `table ${schema.name} row ${index + 1} column ${column}`, {
        nullable: optional.has(column),
      });
      if (schema.name === 'knowledge_sources' && column === 'source_path' && row.source_kind === 'task_history') {
        if (typeof row[column] !== 'string' || !/^ariadne:\/\/task\/[A-Za-z0-9_-]+$/.test(row[column])) {
          throw importRejected(`table knowledge_sources row ${index + 1} column source_path must be a canonical task URI.`);
        }
        continue;
      }
      if (typeof row[column] === 'string') {
        const pathPolicy = PATH_POLICY_BY_COLUMN.get(`${schema.name}.${column}`);
        const externalSourceVersion =
          schema.name === 'knowledge_source_versions' &&
          column === 'content_path' &&
          isExternalSourceVersionArtifact(
            { table: 'knowledge_source_versions', column: 'content_path', root: 'knowledge-root' },
            row,
            taskHistoryIds,
          );
        if (pathPolicy && !externalSourceVersion) {
          assertArchivePathValue(
            row[column],
            pathPolicy,
            workspaceRoot,
            `table ${schema.name} row ${index + 1} column ${column}`,
          );
        }
      }
    }
  }
}

function insertStatementsForTable(
  db: Database.Database,
  schema: ArchiveTableSchema,
  rows: readonly Record<string, unknown>[],
): { rows: number; tables: number } {
  if (rows.length === 0) {
    return { rows: 0, tables: 0 };
  }
  const statements = new Map<string, Database.Statement>();
  for (const row of rows) {
    const insertColumns = schema.columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column));
    const signature = insertColumns.join('|');
    let statement = statements.get(signature);
    if (!statement) {
      statement = db.prepare(
        `INSERT INTO ${schema.name} (${insertColumns.join(', ')})
         VALUES (${insertColumns.map((column) => `@${column}`).join(', ')})`,
      );
      statements.set(signature, statement);
    }
    statement.run(row);
  }
  return { rows: rows.length, tables: 1 };
}

function assertProjectOwnership(table: ArchiveTableName, rows: readonly Record<string, unknown>[], projectId: string): void {
  if (table === 'knowledge_projects') {
    return;
  }
  for (const [index, row] of rows.entries()) {
    if (typeof row.project_id !== 'string' || row.project_id !== projectId) {
      throw importRejected(`table ${table} row ${index + 1} has a project ownership mismatch.`);
    }
  }
}

function rowsById(rows: readonly Record<string, unknown>[], table: ArchiveTableName): Set<string> {
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (typeof row.id !== 'string' || row.id.trim().length === 0) {
      throw importRejected(`table ${table} row ${index + 1} must contain a non-empty string id.`);
    }
    ids.add(row.id);
  }
  return ids;
}

const MAX_GRAPH_REPORT_JSON_BYTES = 65_536;
const MAX_GRAPH_AMBIGUITY_JSON_BYTES = 8_192;

function assertBoundedJsonObject(table: ArchiveTableName, rowIndex: number, column: string, value: unknown, maxBytes: number): void {
  const label = `table ${table} row ${rowIndex + 1} column ${column}`;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw importRejected(`${label} must be a JSON object of at most ${maxBytes} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw importRejected(`${label} must contain valid JSON.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw importRejected(`${label} must be a JSON object.`);
  }
}

function assertReferenceExists(
  table: ArchiveTableName,
  rowIndex: number,
  column: string,
  value: unknown,
  targetTable: ArchiveTableName,
  targetIds: ReadonlySet<string>,
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw importRejected(`table ${table} row ${rowIndex + 1} column ${column} must be a non-empty string reference.`);
  }
  if (!targetIds.has(value)) {
    throw importRejected(`table ${table} row ${rowIndex + 1} column ${column} references a row outside this archive.`);
  }
}

function assertGraphEdgeEvidence(
  rows: readonly Record<string, unknown>[],
  sourceIds: ReadonlySet<string>,
  sourceVersionIds: ReadonlySet<string>,
): void {
  for (const [index, row] of rows.entries()) {
    const raw = row.evidence_json;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw importRejected(`table knowledge_graph_edges row ${index + 1} column evidence_json must be a non-empty JSON string.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw importRejected(`table knowledge_graph_edges row ${index + 1} contains invalid graph edge provenance JSON.`);
    }
    if (!isPlainObject(parsed)) {
      throw importRejected(`table knowledge_graph_edges row ${index + 1} graph edge provenance must be a plain object.`);
    }
    const provenance = parsed.provenance;
    if (provenance === undefined) {
      continue;
    }
    if (!Array.isArray(provenance)) {
      throw importRejected(`table knowledge_graph_edges row ${index + 1} graph edge provenance must be an array when present.`);
    }
    for (const [provenanceIndex, reference] of provenance.entries()) {
      if (!isPlainObject(reference)) {
        throw importRejected(`table knowledge_graph_edges row ${index + 1} provenance ${provenanceIndex + 1} must be a plain object.`);
      }
      if (reference.kind === 'source') {
        if (typeof reference.id !== 'string' || !sourceIds.has(reference.id)) {
          throw importRejected(
            `table knowledge_graph_edges row ${index + 1} contains graph edge provenance that references a source outside this archive.`,
          );
        }
        if (
          reference.sourceVersionId !== undefined &&
          reference.sourceVersionId !== null &&
          (typeof reference.sourceVersionId !== 'string' || !sourceVersionIds.has(reference.sourceVersionId))
        ) {
          throw importRejected(
            `table knowledge_graph_edges row ${index + 1} contains graph edge provenance that references a source version outside this archive.`,
          );
        }
      }
    }
  }
}

function assertArchiveRelationships(
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
  manifestProjectId: string,
): void {
  const projects = rowsByTable.get('knowledge_projects') ?? [];
  if (projects.length !== 1) {
    throw importRejected('knowledge_projects must contain exactly one project row.');
  }
  const projectId = requireNonEmptyArchiveText(projects[0]?.id, 'archive project ID');
  if (projectId !== manifestProjectId) {
    throw importRejected('knowledge_projects must contain exactly one row whose id matches manifest.projectId.');
  }

  for (const table of TABLES) {
    assertProjectOwnership(table, rowsByTable.get(table) ?? [], projectId);
  }

  const sourceIds = rowsById(rowsByTable.get('knowledge_sources') ?? [], 'knowledge_sources');
  const sourceVersionIds = rowsById(rowsByTable.get('knowledge_source_versions') ?? [], 'knowledge_source_versions');
  const sourceSpanIds = rowsById(rowsByTable.get('knowledge_source_spans') ?? [], 'knowledge_source_spans');
  const pageRows = rowsByTable.get('knowledge_pages') ?? [];
  const pageIds = rowsById(pageRows, 'knowledge_pages');
  const pagesById = new Map(pageRows.map((row) => [row.id, row]));
  const pageVersionIds = rowsById(rowsByTable.get('knowledge_page_versions') ?? [], 'knowledge_page_versions');
  const graphNodeIds = rowsById(rowsByTable.get('knowledge_graph_nodes') ?? [], 'knowledge_graph_nodes');
  const snapshotIds = rowsById(rowsByTable.get('knowledge_graph_snapshots') ?? [], 'knowledge_graph_snapshots');
  const jobIds = rowsById(rowsByTable.get('knowledge_jobs') ?? [], 'knowledge_jobs');
  const reviewIds = rowsById(rowsByTable.get('knowledge_reviews') ?? [], 'knowledge_reviews');
  const researchRunIds = rowsById(rowsByTable.get('knowledge_research_runs') ?? [], 'knowledge_research_runs');
  const conversationIds = rowsById(rowsByTable.get('knowledge_conversations') ?? [], 'knowledge_conversations');

  for (const [index, row] of (rowsByTable.get('knowledge_conversations') ?? []).entries()) {
    requireSafeArchiveContentSegment(row.id, `table knowledge_conversations row ${index + 1} column id`);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_messages') ?? []).entries()) {
    const messageId = requireSafeArchiveContentSegment(row.id, `table knowledge_messages row ${index + 1} column id`);
    const conversationId = requireSafeArchiveContentSegment(
      row.conversation_id,
      `table knowledge_messages row ${index + 1} column conversation_id`,
    );
    const expectedContentPath = expectedMessageContentPath(conversationId, messageId);
    if (row.content_path !== expectedContentPath) {
      throw importRejected(
        `table knowledge_messages row ${index + 1} column content_path must match ${expectedContentPath}.`,
      );
    }
  }

  for (const [index, row] of (rowsByTable.get('knowledge_source_versions') ?? []).entries()) {
    assertReferenceExists('knowledge_source_versions', index, 'source_id', row.source_id, 'knowledge_sources', sourceIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_source_assets') ?? []).entries()) {
    assertReferenceExists('knowledge_source_assets', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_source_spans') ?? []).entries()) {
    assertReferenceExists('knowledge_source_spans', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
  }
  for (const table of ['knowledge_analysis_coverage', 'knowledge_deferred_relationships'] as const) {
    for (const [index, row] of (rowsByTable.get(table) ?? []).entries()) {
      assertReferenceExists(table, index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_deferred_relationships') ?? []).entries()) {
    if (row.span_id !== undefined && row.span_id !== null) {
      assertReferenceExists('knowledge_deferred_relationships', index, 'span_id', row.span_id, 'knowledge_source_spans', sourceSpanIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_extractions') ?? []).entries()) {
    assertReferenceExists('knowledge_extractions', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
  }
  assertArchiveSummaryRows(rowsByTable.get(KNOWLEDGE_SEMANTIC_SUMMARIES_TABLE) ?? [], { projectId, sourceVersionIds, pageVersionIds });
  for (const [index, row] of (rowsByTable.get('knowledge_page_versions') ?? []).entries()) {
    assertReferenceExists('knowledge_page_versions', index, 'page_id', row.page_id, 'knowledge_pages', pageIds);
    const page = pagesById.get(row.page_id as string);
    if (page) {
      const expectedContentPath = expectedPageContentPath(
        requireNonEmptyArchiveText(page.page_type, `table knowledge_pages row ${index + 1} column page_type`),
        requireNonEmptyArchiveText(page.slug, `table knowledge_pages row ${index + 1} column slug`),
      );
      if (row.content_path !== expectedContentPath) {
        throw importRejected(
          `table knowledge_page_versions row ${index + 1} column content_path must match ${expectedContentPath}.`,
        );
      }
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_page_sources') ?? []).entries()) {
    assertReferenceExists('knowledge_page_sources', index, 'page_version_id', row.page_version_id, 'knowledge_page_versions', pageVersionIds);
    assertReferenceExists('knowledge_page_sources', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_page_provenance') ?? []).entries()) {
    assertReferenceExists('knowledge_page_provenance', index, 'page_version_id', row.page_version_id, 'knowledge_page_versions', pageVersionIds);
    if (row.source_span_id !== undefined && row.source_span_id !== null) {
      assertReferenceExists('knowledge_page_provenance', index, 'source_span_id', row.source_span_id, 'knowledge_source_spans', sourceSpanIds);
    }
    if (row.source_kind === 'source') {
      assertReferenceExists('knowledge_page_provenance', index, 'source_id', row.source_id, 'knowledge_sources', sourceIds);
    }
    if (row.source_kind === 'page') {
      assertReferenceExists('knowledge_page_provenance', index, 'source_id', row.source_id, 'knowledge_pages', pageIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_page_aliases') ?? []).entries()) {
    assertReferenceExists('knowledge_page_aliases', index, 'page_id', row.page_id, 'knowledge_pages', pageIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_page_links') ?? []).entries()) {
    assertReferenceExists('knowledge_page_links', index, 'source_page_id', row.source_page_id, 'knowledge_pages', pageIds);
    if (row.target_page_id !== undefined && row.target_page_id !== null) {
      assertReferenceExists('knowledge_page_links', index, 'target_page_id', row.target_page_id, 'knowledge_pages', pageIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_graph_nodes') ?? []).entries()) {
    if (row.source_version_id !== undefined && row.source_version_id !== null) {
      assertReferenceExists('knowledge_graph_nodes', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
    }
    if (row.source_kind === 'source' && row.source_id !== undefined && row.source_id !== null) {
      assertReferenceExists('knowledge_graph_nodes', index, 'source_id', row.source_id, 'knowledge_sources', sourceIds);
    }
    if (row.source_kind === 'page' && row.source_id !== undefined && row.source_id !== null) {
      assertReferenceExists('knowledge_graph_nodes', index, 'source_id', row.source_id, 'knowledge_pages', pageIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_graph_edges') ?? []).entries()) {
    assertReferenceExists('knowledge_graph_edges', index, 'source_node_id', row.source_node_id, 'knowledge_graph_nodes', graphNodeIds);
    assertReferenceExists('knowledge_graph_edges', index, 'target_node_id', row.target_node_id, 'knowledge_graph_nodes', graphNodeIds);
  }
  for (const table of ['knowledge_graph_reports', 'knowledge_graph_ambiguities'] as const) {
    for (const [index, row] of (rowsByTable.get(table) ?? []).entries()) {
      if (row.graph_snapshot_id !== undefined && row.graph_snapshot_id !== null) {
        assertReferenceExists(table, index, 'graph_snapshot_id', row.graph_snapshot_id, 'knowledge_graph_snapshots', snapshotIds);
      }
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_graph_reports') ?? []).entries()) {
    assertBoundedJsonObject('knowledge_graph_reports', index, 'report_json', row.report_json, MAX_GRAPH_REPORT_JSON_BYTES);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_graph_ambiguities') ?? []).entries()) {
    assertBoundedJsonObject('knowledge_graph_ambiguities', index, 'detail_json', row.detail_json, MAX_GRAPH_AMBIGUITY_JSON_BYTES);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_communities') ?? []).entries()) {
    assertReferenceExists('knowledge_communities', index, 'graph_snapshot_id', row.graph_snapshot_id, 'knowledge_graph_snapshots', snapshotIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_insights') ?? []).entries()) {
    if (row.graph_snapshot_id !== undefined && row.graph_snapshot_id !== null) {
      assertReferenceExists('knowledge_insights', index, 'graph_snapshot_id', row.graph_snapshot_id, 'knowledge_graph_snapshots', snapshotIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_jobs') ?? []).entries()) {
    if (row.source_version_id !== undefined && row.source_version_id !== null) {
      assertReferenceExists('knowledge_jobs', index, 'source_version_id', row.source_version_id, 'knowledge_source_versions', sourceVersionIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_job_events') ?? []).entries()) {
    assertReferenceExists('knowledge_job_events', index, 'job_id', row.job_id, 'knowledge_jobs', jobIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_reviews') ?? []).entries()) {
    if (row.page_version_id !== undefined && row.page_version_id !== null) {
      assertReferenceExists('knowledge_reviews', index, 'page_version_id', row.page_version_id, 'knowledge_page_versions', pageVersionIds);
    }
  }
  for (const [index, row] of (rowsByTable.get('knowledge_review_actions') ?? []).entries()) {
    assertReferenceExists('knowledge_review_actions', index, 'review_id', row.review_id, 'knowledge_reviews', reviewIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_research_results') ?? []).entries()) {
    assertReferenceExists('knowledge_research_results', index, 'research_run_id', row.research_run_id, 'knowledge_research_runs', researchRunIds);
  }
  for (const [index, row] of (rowsByTable.get('knowledge_messages') ?? []).entries()) {
    assertReferenceExists('knowledge_messages', index, 'conversation_id', row.conversation_id, 'knowledge_conversations', conversationIds);
  }
  assertGraphEdgeEvidence(rowsByTable.get('knowledge_graph_edges') ?? [], sourceIds, sourceVersionIds);
}

function rowsFor(db: Database.Database, table: string, projectId: string): Record<string, unknown>[] {
  if (table === 'knowledge_projects') {
    const row = db.prepare('SELECT * FROM knowledge_projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    return row ? [row] : [];
  }
  return db.prepare(`SELECT * FROM ${table} WHERE project_id = ?`).all(projectId) as Record<string, unknown>[];
}

function redactProviderProfiles(db: Database.Database, projectId: string): Record<string, unknown>[] {
  return (db.prepare('SELECT * FROM knowledge_provider_profiles WHERE project_id = ?').all(projectId) as Record<string, unknown>[])
    .map(({ configuration_json: _configuration, ...profile }) => profile);
}

function redactProjectWorkspaceRoot(project: Record<string, unknown>): Record<string, unknown> {
  return {
    ...project,
    workspace_root: REDACTED_WORKSPACE_ROOT,
  };
}

function requireSafeArchiveContentSegment(value: unknown, context: string): string {
  const segment = requireNonEmptyArchiveText(value, context);
  if (!ARCHIVE_CONTENT_SEGMENT_PATTERN.test(segment)) {
    throw importRejected(`${context} must use a safe single path segment.`);
  }
  return segment;
}

function expectedMessageContentPath(conversationId: string, messageId: string): string {
  return `conversations/${conversationId}/${messageId}.json`;
}

function expectedPageContentPath(pageType: string, slug: string): string {
  return `pages/${pageType}/${slug}.md`;
}

function requireArtifactArchivePath(
  spec: ArchiveArtifactSpec,
  row: Record<string, unknown>,
  rowIndex: number,
  mode: 'export' | 'import' | 'cleanup',
): string | undefined {
  const context = `table ${spec.table} row ${rowIndex + 1} column ${spec.column}`;
  const rawPath = row[spec.column];
  if (rawPath === undefined || rawPath === null) {
    return undefined;
  }
  const archivePath = requireNonEmptyArchiveText(rawPath, context);
  if (spec.table !== 'knowledge_messages') {
    return archivePath;
  }

  const messageId = requireSafeArchiveContentSegment(row.id, `table knowledge_messages row ${rowIndex + 1} column id`);
  const conversationId = requireSafeArchiveContentSegment(
    row.conversation_id,
    `table knowledge_messages row ${rowIndex + 1} column conversation_id`,
  );
  const expectedPath = expectedMessageContentPath(conversationId, messageId);
  if (archivePath === expectedPath) {
    return archivePath;
  }
  if (mode === 'cleanup') {
    return undefined;
  }
  const message = `${context} must match ${expectedPath}.`;
  if (mode === 'import') {
    throw importRejected(message);
  }
  throw new Error(`Knowledge archive export rejected: ${message}`);
}

function isExternalSourceVersionArtifact(
  spec: ArchiveArtifactSpec,
  row: Record<string, unknown>,
  taskHistorySourceTaskIds: ReadonlyMap<string, string>,
): boolean {
  if (spec.table !== 'knowledge_source_versions') {
    return false;
  }
  const sourceId = row.source_id;
  const taskId = typeof sourceId === 'string' ? taskHistorySourceTaskIds.get(sourceId) : undefined;
  if (taskId === undefined) {
    return false;
  }
  return row.content_path === `tasks/${taskId}.md`;
}

function taskHistorySourceTaskIds(
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
): Map<string, string> {
  const taskIds = new Map<string, string>();
  for (const source of rowsByTable.get('knowledge_sources') ?? []) {
    if (source.source_kind !== 'task_history' || typeof source.id !== 'string' || typeof source.source_path !== 'string') {
      continue;
    }
    const match = /^ariadne:\/\/task\/([A-Za-z0-9_-]+)$/.exec(source.source_path);
    if (match) {
      taskIds.set(source.id, match[1]);
    }
  }
  return taskIds;
}

function resolveKnowledgeContentPath(root: string, relativePath: string, label: string): string {
  const normalizedPath = normalizeKnowledgePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, normalizedPath);
  if (!isPathWithinRoot(absoluteRoot, absolutePath)) {
    throw new Error(`${label} must stay within the knowledge content root`);
  }
  return absolutePath;
}

function resolveExportArtifactAbsolutePath(
  spec: ArchiveArtifactSpec,
  workspaceRoot: string,
  archivePath: string,
  label: string,
): string {
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  const absolutePath = resolveArtifactAbsolutePath(absoluteWorkspaceRoot, archivePath, spec.root);
  const confinedRoot =
    spec.root === 'workspace-root'
      ? knowledgeConversationStorageRoot(absoluteWorkspaceRoot)
      : knowledgeRoot(absoluteWorkspaceRoot);
  if (!isPathWithinRoot(confinedRoot, absolutePath)) {
    throw new Error(`${label} must stay within the knowledge export root`);
  }
  assertNoSymlinkComponents(absoluteWorkspaceRoot, absolutePath, label);
  return absolutePath;
}

function assertArchiveCitationContext(value: unknown, context: string): void {
  let parsed;
  try {
    parsed = parseCitationContext(value);
  } catch (error) {
    throw importRejected(`${context} has an invalid citation context: ${error instanceof Error ? error.message : 'invalid'}.`);
  }
  if (parsed.snippetPolicy !== 'reference_only') {
    throw importRejected(`${context} citation context snippetPolicy must be reference_only.`);
  }
}

function assertArchiveMessagePayload(content: Uint8Array, context: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(content).toString('utf8')) as unknown;
  } catch {
    throw importRejected(`${context} must contain valid JSON.`);
  }
  if (!isPlainObject(parsed)) {
    throw importRejected(`${context} must be a plain object.`);
  }
  if (typeof parsed.content !== 'string') {
    throw importRejected(`${context} field content must be a string.`);
  }
  if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) {
    throw importRejected(`${context} field schemaVersion must be absent or 2.`);
  }
  if (parsed.synthesis !== undefined && parsed.synthesis !== null && !isPlainObject(parsed.synthesis)) {
    throw importRejected(`${context} field synthesis must be a plain object or null.`);
  }
  if (isPlainObject(parsed.synthesis)) {
    try {
      parsePersistedKnowledgeSynthesis(parsed.synthesis);
    } catch (error) {
      throw importRejected(`${context} field synthesis is invalid: ${error instanceof Error ? error.message : 'unknown error'}.`);
    }
  }
  if (!Array.isArray(parsed.citations)) {
    throw importRejected(`${context} field citations must be an array.`);
  }
  for (const [index, citation] of parsed.citations.entries()) {
    if (!isPlainObject(citation)) {
      throw importRejected(`${context} citation ${index + 1} must be a plain object.`);
    }
    for (const key of ['pageId', 'sourceId', 'path', 'url'] as const) {
      const value = citation[key];
      if (value !== null && value !== undefined && typeof value !== 'string') {
        throw importRejected(`${context} citation ${index + 1} field ${key} must be a string or null.`);
      }
    }
    if (citation.span !== null && citation.span !== undefined) {
      if (!isPlainObject(citation.span)) {
        throw importRejected(`${context} citation ${index + 1} span must be a plain object or null.`);
      }
      if (typeof citation.span.id !== 'string') {
        throw importRejected(`${context} citation ${index + 1} span id must be a string.`);
      }
      for (const key of ['startOffset', 'endOffset'] as const) {
        if (typeof citation.span[key] !== 'number' || !Number.isInteger(citation.span[key])) {
          throw importRejected(`${context} citation ${index + 1} span ${key} must be an integer.`);
        }
      }
    }
    if (citation.context !== undefined) {
      assertArchiveCitationContext(citation.context, `${context} citation ${index + 1}`);
    }
  }
  if (parsed.retrievalMode !== null && parsed.retrievalMode !== undefined) {
    if (typeof parsed.retrievalMode !== 'string' || !ALLOWED_KNOWLEDGE_SEARCH_MODES.has(parsed.retrievalMode)) {
      throw importRejected(`${context} field retrievalMode must be a supported search mode or null.`);
    }
  }
}

function resolveArtifactAbsolutePath(
  workspaceRoot: string,
  archivePath: string,
  root: ArchiveArtifactRoot,
): string {
  const normalizedPath = assertSafePath(archivePath);
  if (root === 'workspace-root') {
    return path.resolve(workspaceRoot, normalizedPath);
  }
  return path.resolve(knowledgeRoot(workspaceRoot), normalizedPath);
}

function archiveArtifactRows(
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
): Array<{ spec: ArchiveArtifactSpec; row: Record<string, unknown>; rowIndex: number }> {
  const entries: Array<{ spec: ArchiveArtifactSpec; row: Record<string, unknown>; rowIndex: number }> = [];
  for (const spec of ARTIFACT_SPEC_BY_COLUMN.values()) {
    const rows = rowsByTable.get(spec.table) ?? [];
    for (const [rowIndex, row] of rows.entries()) {
      entries.push({ spec, row, rowIndex });
    }
  }
  return entries;
}

function addArchiveArtifactFiles(
  files: Record<string, KnowledgeArchiveFile>,
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
  workspaceRoot: string,
): void {
  const taskHistoryIds = taskHistorySourceTaskIds(rowsByTable);
  for (const { spec, row, rowIndex } of archiveArtifactRows(rowsByTable)) {
    if (isExternalSourceVersionArtifact(spec, row, taskHistoryIds)) {
      continue;
    }
    const archivePath = requireArtifactArchivePath(spec, row, rowIndex, 'export');
    if (archivePath === undefined) {
      continue;
    }
    if (files[archivePath] !== undefined) {
      continue;
    }
    const absolutePath = resolveExportArtifactAbsolutePath(
      spec,
      workspaceRoot,
      archivePath,
      `table ${spec.table} row ${rowIndex + 1} column ${spec.column}`,
    );
    if (!existsSync(absolutePath)) {
      if (spec.requiredOnExport) {
        throw new Error(`Knowledge archive export missing required content file: ${archivePath}`);
      }
      continue;
    }
    const content = readFileSync(absolutePath);
    if (spec.sizeColumn) {
      const expectedSize = row[spec.sizeColumn];
      if (typeof expectedSize === 'number' && Number.isInteger(expectedSize) && expectedSize >= 0 && content.byteLength !== expectedSize) {
        throw new Error(`Knowledge archive export rejected: table ${spec.table} row ${rowIndex + 1} column ${spec.column} size does not match persisted metadata.`);
      }
    }
    if (spec.hashColumn) {
      const expectedHash = row[spec.hashColumn];
      if (typeof expectedHash === 'string' && expectedHash.trim().length > 0) {
        const actualHash = createHash('sha256').update(content).digest('hex');
        if (actualHash !== expectedHash) {
          throw new Error(`Knowledge archive export rejected: table ${spec.table} row ${rowIndex + 1} column ${spec.column} hash does not match persisted metadata.`);
        }
      }
    }
    addFile(files, archivePath, content);
  }
}

function buildArchiveMaterializedFiles(
  archive: KnowledgeArchive,
  rowsByTable: ReadonlyMap<ArchiveTableName, readonly Record<string, unknown>[]>,
  workspaceRoot: string,
): ArchiveMaterializedFile[] {
  const files = new Map<string, ArchiveMaterializedFile>();
  const taskHistoryIds = taskHistorySourceTaskIds(rowsByTable);
  for (const { spec, row, rowIndex } of archiveArtifactRows(rowsByTable)) {
    if (isExternalSourceVersionArtifact(spec, row, taskHistoryIds)) {
      continue;
    }
    const archivePath = requireArtifactArchivePath(spec, row, rowIndex, 'import');
    if (archivePath === undefined) {
      continue;
    }
    const archiveFile = archive.files[archivePath];
    if (archiveFile === undefined) {
      throw importRejected(`archive content file is missing for table ${spec.table} row ${rowIndex + 1} column ${spec.column}.`);
    }
    const content = bytes(archiveFile);
    if (spec.table === 'knowledge_messages') {
      assertArchiveMessagePayload(content, `table ${spec.table} row ${rowIndex + 1} content file`);
    }
    if (spec.sizeColumn) {
      const expectedSize = row[spec.sizeColumn];
      if (typeof expectedSize === 'number' && Number.isInteger(expectedSize) && expectedSize >= 0 && content.byteLength !== expectedSize) {
        throw importRejected(`archive content file size mismatch for table ${spec.table} row ${rowIndex + 1} column ${spec.column}.`);
      }
    }
    if (spec.hashColumn) {
      const expectedHash = row[spec.hashColumn];
      if (typeof expectedHash === 'string' && expectedHash.trim().length > 0) {
        const actualHash = createHash('sha256').update(content).digest('hex');
        if (actualHash !== expectedHash) {
          throw importRejected(`archive content file hash mismatch for table ${spec.table} row ${rowIndex + 1} column ${spec.column}.`);
        }
      }
    }
    const absolutePath = resolveArtifactAbsolutePath(workspaceRoot, archivePath, spec.root);
    files.set(absolutePath, { archivePath, absolutePath, content });
  }
  return [...files.values()].sort((left, right) => left.absolutePath.localeCompare(right.absolutePath));
}

function collectExistingArtifactPaths(
  db: Database.Database,
  projectId: string,
  workspaceRoot: string,
): string[] {
  const paths = new Set<string>();
  const sourceRows = rowsFor(db, 'knowledge_sources', projectId);
  const taskHistoryIds = taskHistorySourceTaskIds(new Map([['knowledge_sources', sourceRows]]));
  for (const spec of ARTIFACT_SPEC_BY_COLUMN.values()) {
    const rows = rowsFor(db, spec.table, projectId);
    for (const [rowIndex, row] of rows.entries()) {
      if (isExternalSourceVersionArtifact(spec, row, taskHistoryIds)) {
        continue;
      }
      const archivePath = requireArtifactArchivePath(spec, row, rowIndex, 'cleanup');
      if (archivePath === undefined) {
        continue;
      }
      try {
        paths.add(resolveArtifactAbsolutePath(workspaceRoot, archivePath, spec.root));
      } catch {
        continue;
      }
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function assertNoArtifactPathConflicts(
  db: Database.Database,
  projectId: string,
  workspaceRoot: string,
  targetPaths: ReadonlySet<string>,
): void {
  if (targetPaths.size === 0) {
    return;
  }
  const rows = db
    .prepare('SELECT id FROM knowledge_projects WHERE id != ? AND workspace_root = ?')
    .all(projectId, workspaceRoot) as Array<{ id: string }>;
  for (const row of rows) {
    const otherPaths = new Set(collectExistingArtifactPaths(db, row.id, workspaceRoot));
    for (const targetPath of targetPaths) {
      if (otherPaths.has(targetPath)) {
        throw new Error('Knowledge archive import would overwrite knowledge artifacts used by another project in this workspace.');
      }
    }
  }
}

function existingProjectWorkspaceRoot(db: Database.Database, projectId: string): string | undefined {
  const row = db.prepare('SELECT workspace_root FROM knowledge_projects WHERE id = ?').get(projectId) as
    | { workspace_root: string }
    | undefined;
  if (!row || typeof row.workspace_root !== 'string' || row.workspace_root.trim().length === 0) {
    return undefined;
  }
  return path.resolve(row.workspace_root);
}

function writeArchiveStagedFile(filePath: string, content: Uint8Array): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { flag: 'wx' });
}

function commitArchiveFiles(
  workspaceRoot: string,
  files: readonly ArchiveMaterializedFile[],
  stalePaths: readonly string[],
): { finalize: () => void; rollback: () => void } {
  if (files.length === 0 && stalePaths.length === 0) {
    return { finalize: () => undefined, rollback: () => undefined };
  }

  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);
  const archiveRoot = knowledgeRoot(absoluteWorkspaceRoot);
  const token = `${process.pid}.${Date.now()}.${createHash('sha256')
    .update(`${absoluteWorkspaceRoot}:${files.length}:${stalePaths.length}`)
    .digest('hex')
    .slice(0, 12)}`;
  const stagingRoot = path.join(archiveRoot, `.archive-import-${token}`);
  const backupRoot = path.join(archiveRoot, `.archive-import-backup-${token}`);
  assertNoSymlinkComponents(absoluteWorkspaceRoot, archiveRoot, 'Knowledge archive import root');
  assertNoSymlinkComponents(absoluteWorkspaceRoot, stagingRoot, 'Knowledge archive import staging path');
  assertNoSymlinkComponents(absoluteWorkspaceRoot, backupRoot, 'Knowledge archive import backup path');
  mkdirSync(archiveRoot, { recursive: true });
  const staged = files.map((file) => ({
    ...file,
    relativeWorkspacePath: path.relative(absoluteWorkspaceRoot, file.absolutePath),
  }));
  const newTargets = new Set(staged.map((file) => file.absolutePath));
  const targetsToRemove = stalePaths.filter((target) => !newTargets.has(target));
  const backups: Array<{ target: string; backup: string }> = [];
  const rollback = (): void => {
    for (const file of staged) rmSync(file.absolutePath, { force: true });
    for (const { target, backup } of backups.reverse()) {
      if (existsSync(backup)) {
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(backup, target);
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  };

  try {
    for (const file of staged) {
      writeArchiveStagedFile(path.join(stagingRoot, file.relativeWorkspacePath), file.content);
    }
    for (const target of [...newTargets, ...targetsToRemove]) {
      assertNoSymlinkComponents(absoluteWorkspaceRoot, path.dirname(target), 'Knowledge archive import target path');
      if (!existsSync(target)) {
        continue;
      }
      const backup = path.join(backupRoot, path.relative(absoluteWorkspaceRoot, target));
      mkdirSync(path.dirname(backup), { recursive: true });
      renameSync(target, backup);
      backups.push({ target, backup });
    }
    for (const file of staged) {
      mkdirSync(path.dirname(file.absolutePath), { recursive: true });
      renameSync(path.join(stagingRoot, file.relativeWorkspacePath), file.absolutePath);
    }
    return {
      finalize: () => {
        try {
          rmSync(stagingRoot, { recursive: true, force: true });
          rmSync(backupRoot, { recursive: true, force: true });
        } catch {
          // Database and final files are already committed; cleanup can be retried safely.
        }
      },
      rollback,
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

function pageMarkdown(
  db: Database.Database,
  page: Record<string, unknown>,
  workspaceRoot: string,
  contentRoot?: string,
  pageContents?: Record<string, string>,
): string {
  const version = db
    .prepare('SELECT * FROM knowledge_page_versions WHERE project_id = ? AND page_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(page.project_id, page.id) as Record<string, unknown> | undefined;
  let content = '';
  if (pageContents?.[String(page.id)] !== undefined) {
    content = pageContents[String(page.id)];
  } else if (contentRoot && version?.content_path) {
    const absolutePath = resolveKnowledgeContentPath(
      contentRoot,
      requireNonEmptyArchiveText(version.content_path, 'knowledge page version content_path'),
      'Knowledge page content path',
    );
    assertNoSymlinkComponents(path.resolve(workspaceRoot), absolutePath, 'Knowledge page content path');
    if (existsSync(absolutePath)) {
      content = readFileSync(absolutePath, 'utf8');
    }
  }
  const rendered = renderKnowledgePage({
    id: String(page.id),
    type: String(page.page_type) as never,
    title: String(page.title),
    slug: String(page.slug),
    status: String(page.status),
    content,
    version: Number(version?.version_number ?? 1),
    generatedAt: String(version?.created_at ?? page.updated_at),
  });
  return rendered.replace(/\[([^\]]+)\]\(pages\/[^/]+\/([^/)]+)\.md\)/g, '[[$2|$1]]');
}

function isHostSettingRow(row: Record<string, unknown>): boolean {
  return typeof row.setting_key === 'string' && row.setting_key.startsWith(KNOWLEDGE_HOST_SETTING_PREFIX);
}

function isChatPayloadV2(content: KnowledgeArchiveFile | undefined): boolean {
  if (content === undefined) {
    return false;
  }
  try {
    const parsed = JSON.parse(Buffer.from(bytes(content)).toString('utf8')) as unknown;
    return isPlainObject(parsed) && parsed.schemaVersion === 2;
  } catch {
    return false;
  }
}

function containsChatPayloadV2(
  files: Readonly<Record<string, KnowledgeArchiveFile>>,
  messageRows: readonly Record<string, unknown>[],
): boolean {
  return messageRows.some((row) => typeof row.content_path === 'string' && isChatPayloadV2(files[row.content_path]));
}

function assertExportTablesClassified(): void {
  for (const table of TABLES) {
    const archiveClass = getKnowledgeArchiveRegistration(table)?.class;
    if (archiveClass !== 'required' && archiveClass !== 'optional') {
      throw new Error(`Knowledge archive export rejected: table ${table} has no exportable archive classification.`);
    }
  }
}

function resolveManifestVersion(
  requested: ExportKnowledgeProjectOptions['manifestVersion'],
  requiresVersion2: boolean,
  signing: boolean,
): 1 | 2 {
  if (requested !== undefined && requested !== 'auto' && requested !== 1 && requested !== 2) {
    throw new Error(`Knowledge archive export rejected: unsupported manifest version ${String(requested)}.`);
  }
  if (requested === 1 && requiresVersion2) {
    throw manifestVersionIncompatible('the project has data that requires a version 2 archive.');
  }
  if (requested === 1 && signing) {
    throw manifestVersionIncompatible('signed archives require manifest version 2.');
  }
  if (requested === 1 || requested === 2) {
    return requested;
  }
  return requiresVersion2 || signing ? 2 : 1;
}

export function exportKnowledgeProject(db: Database.Database, options: ExportKnowledgeProjectOptions): KnowledgeArchive {
  assertExportTablesClassified();
  const project = db.prepare('SELECT * FROM knowledge_projects WHERE id = ?').get(options.projectId) as Record<string, unknown> | undefined;
  if (!project) throw new Error(`Knowledge project not found: ${options.projectId}`);
  const exportedProject = redactProjectWorkspaceRoot(project);
  const projectWorkspaceRoot = requireNonEmptyArchiveText(project.workspace_root, 'project workspace_root');
  const contentRoot = options.contentRoot ?? knowledgeRoot(projectWorkspaceRoot);
  const files: Record<string, KnowledgeArchiveFile> = {};
  const rowsByTable = new Map<ArchiveTableName, Record<string, unknown>[]>();
  for (const table of TABLES) {
    let rows: Record<string, unknown>[];
    if (table === 'knowledge_projects') {
      rows = [exportedProject];
    } else if (table === KNOWLEDGE_ARCHIVE_SETTINGS_TABLE) {
      rows = rowsFor(db, table, options.projectId).filter((row) => !isHostSettingRow(row));
    } else if (table === KNOWLEDGE_SEMANTIC_SUMMARIES_TABLE) {
      rows = redactSummaryRowsForExport(rowsFor(db, table, options.projectId));
    } else {
      rows = rowsFor(db, table, options.projectId);
    }
    rowsByTable.set(table, rows);
    addFile(files, `data/${table}.json`, json(rows));
  }
  addFile(files, 'project.json', json(exportedProject));
  const pages = rowsByTable.get('knowledge_pages') ?? [];
  for (const page of pages) {
    addFile(files, `pages/${page.page_type}/${page.slug}.md`, pageMarkdown(db, page, projectWorkspaceRoot, contentRoot, options.pageContents));
  }
  const pageVersionRows = rowsByTable.get('knowledge_page_versions');
  if (pageVersionRows) {
    const normalizedRows = pageVersionRows.map((row) => {
      if (typeof row.content_path !== 'string') {
        return row;
      }
      const archivedPage = files[row.content_path];
      if (archivedPage === undefined) {
        return row;
      }
      return {
        ...row,
        content_hash: createHash('sha256').update(bytes(archivedPage)).digest('hex'),
      };
    });
    rowsByTable.set('knowledge_page_versions', normalizedRows);
    addFile(files, 'data/knowledge_page_versions.json', json(normalizedRows));
  }
  const graph = {
    nodes: rowsByTable.get('knowledge_graph_nodes') ?? [],
    edges: rowsByTable.get('knowledge_graph_edges') ?? [],
  };
  addFile(files, 'graph.json', json(graph));
  if (options.includeObsidian) addFile(files, '.obsidian/app.json', json({ alwaysUpdateLinks: true, newFileLocation: 'folder' }));
  addArchiveArtifactFiles(files, rowsByTable, projectWorkspaceRoot);

  const tablesWithRows = TABLES.filter((table) => (rowsByTable.get(table)?.length ?? 0) > 0);
  const features = featuresForTables(tablesWithRows);
  if (containsChatPayloadV2(files, rowsByTable.get('knowledge_messages') ?? [])) {
    features.required = [...features.required, KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2].sort();
  }
  const version = resolveManifestVersion(options.manifestVersion, features.required.length > 0, options.authenticitySigner !== undefined);
  if (version === 1) {
    // Version 1 keeps shipping the secret-redacted profile table; version 2 declares it as omitted instead.
    addFile(files, 'data/knowledge_provider_profiles.json', json(redactProviderProfiles(db, options.projectId)));
  }

  const omitted = [...OMITTED_TABLES].map((table) => `${table}.configuration_json`);
  const entries = Object.entries(files)
    .map(([filePath, content]) => ({ path: filePath, size: bytes(content).byteLength, sha256: createHash('sha256').update(bytes(content)).digest('hex'), mediaType: mediaType(filePath) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifest: KnowledgeArchiveManifest = {
    archiveVersion: version,
    format: 'ariadne-knowledge-archive',
    projectId: options.projectId,
    generatedAt,
    entries,
    omitted,
  };
  if (version === 2) {
    manifest.compatibility = {
      minimumReaderArchiveVersion: 2,
      producedBy: { packageVersion: null, knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION },
      requiredFeatures: features.required,
      optionalFeatures: features.optional,
      tableFingerprints: TABLES.map((table) => ({
        table,
        sha256: createHash('sha256').update(bytes(files[`data/${table}.json`])).digest('hex'),
        rowCount: rowsByTable.get(table)?.length ?? 0,
      })),
      omissions: expectedOmissions(),
    };
  }
  if (options.authenticitySigner) {
    manifest.authenticity = signKnowledgeArchiveManifest(manifest, options.authenticitySigner, generatedAt);
  }
  return { manifest, files };
}

function validateArchive(
  archive: KnowledgeArchive,
  options: ImportKnowledgeProjectOptions,
): ReturnType<typeof assessManifestCompatibility> & { authenticity: ReturnType<typeof assessAuthenticity> } {
  const compatibility = assessManifestCompatibility(archive.manifest, options.compatibilityPolicy);
  if (archive.manifest.format !== 'ariadne-knowledge-archive') throw new Error('Invalid knowledge archive format');
  requireNonEmptyArchiveText(archive.manifest.projectId, 'archive project ID');
  if (!Array.isArray(archive.manifest.entries)) {
    throw importRejected('manifest entries must be an array.');
  }
  if (archive.manifest.entries.length > MAX_ARCHIVE_ENTRIES) {
    throw importRejected('manifest exceeds the maximum supported entry count.');
  }
  const manifestPaths = new Set<string>();
  let totalBytes = 0;
  for (const entry of archive.manifest.entries) {
    if (!isPlainObject(entry)) {
      throw importRejected('manifest entries must be plain objects.');
    }
    if (
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.mediaType !== 'string' ||
      typeof entry.size !== 'number' ||
      !Number.isInteger(entry.size) ||
      entry.size < 0
    ) {
      throw importRejected('manifest entries must include string path/sha256/mediaType values and a non-negative integer size.');
    }
    assertSafePath(entry.path);
    if (manifestPaths.has(entry.path)) {
      throw importRejected(`manifest contains a duplicate entry path: ${entry.path}`);
    }
    manifestPaths.add(entry.path);
    if (entry.size > MAX_ARCHIVE_ENTRY_BYTES) {
      throw importRejected(`archive entry exceeds the maximum supported file size: ${entry.path}`);
    }
    const content = archive.files[entry.path];
    if (content === undefined) throw new Error(`Knowledge archive entry is missing: ${entry.path}`);
    const actual = bytes(content);
    totalBytes += actual.byteLength;
    if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      throw importRejected('archive exceeds the maximum supported total file size.');
    }
    if (actual.byteLength !== entry.size || createHash('sha256').update(actual).digest('hex') !== entry.sha256) {
      throw new Error(`Knowledge archive entry checksum mismatch: ${entry.path}`);
    }
  }
  const filePaths = Object.keys(archive.files).map((filePath) => assertSafePath(filePath));
  for (const filePath of filePaths) {
    if (!manifestPaths.has(filePath)) {
      throw importRejected(`archive file is not declared in the manifest: ${filePath}`);
    }
  }
  if (filePaths.length !== manifestPaths.size) {
    throw importRejected('manifest entries and archive files must match exactly.');
  }
  return { ...compatibility, authenticity: assessAuthenticity(archive.manifest, options.authenticityVerifier) };
}

function buildImportPlan(db: Database.Database, archive: KnowledgeArchive, options: ImportKnowledgeProjectOptions): ArchiveImportPlan {
  const validation = validateArchive(archive, options);
  const warnings: KnowledgeArchiveWarning[] = [...validation.warnings, ...validation.authenticity.warnings];
  const dataFileReview = reviewArchiveDataFiles(Object.keys(archive.files), validation.version, SUPPORTED_TABLE_NAMES);
  warnings.push(...dataFileReview.warnings);

  const projectId = requireNonEmptyArchiveText(archive.manifest.projectId, 'archive project ID');
  if (options.expectedProjectId !== undefined && options.expectedProjectId !== projectId) {
    throw new Error('Knowledge archive import target does not match the archive project ID.');
  }

  const projectRecord = parseJsonFile(archive, 'project.json', 'project.json');
  if (projectRecord === undefined) {
    throw importRejected('project.json is required.');
  }
  if (!isPlainObject(projectRecord)) {
    throw importRejected('project.json must be a plain object.');
  }
  if (requireNonEmptyArchiveText(projectRecord.id, 'project.json id') !== projectId) {
    throw importRejected('project.json must describe the same project as the manifest.');
  }
  const existingWorkspaceRoot = existingProjectWorkspaceRoot(db, projectId);
  const archiveWorkspaceRoot =
    typeof projectRecord.workspace_root === 'string' && projectRecord.workspace_root !== REDACTED_WORKSPACE_ROOT
      ? projectRecord.workspace_root
      : undefined;
  const workspaceRoot = path.resolve(
    requireNonEmptyArchiveText(options.workspaceRoot ?? existingWorkspaceRoot ?? archiveWorkspaceRoot, 'workspace root'),
  );

  const rowsByTable = new Map<ArchiveTableName, Record<string, unknown>[]>();
  const archiveTables = new Map<string, { sha256: string; rowCount: number }>();
  let totalRows = 0;
  const coverageDeclared = validation.block?.requiredFeatures.includes(ANALYSIS_COVERAGE_FEATURE) ?? false;
  for (const schema of TABLE_SCHEMAS) {
    const coverageTable = COVERAGE_TABLES.has(schema.name);
    const absentCoverageTable = coverageTable && archive.files[`data/${schema.name}.json`] === undefined;
    if (absentCoverageTable && coverageDeclared) {
      throw importRejected(`table ${schema.name} is required by the ${ANALYSIS_COVERAGE_FEATURE} feature declaration.`);
    }
    // Archives written before analysis coverage existed legitimately omit these tables.
    const rows = absentCoverageTable ? [] : parseTableRows(archive, schema, warnings);
    if (coverageTable && rows.length > 0 && !coverageDeclared) {
      throw importRejected(`table ${schema.name} requires the ${ANALYSIS_COVERAGE_FEATURE} feature declaration.`);
    }
    if (schema.name === KNOWLEDGE_ARCHIVE_SETTINGS_TABLE && rows.some(isHostSettingRow)) {
      const position = rows.findIndex(isHostSettingRow) + 1;
      throw importRejected(`table ${schema.name} row ${position} contains a host-local setting.`);
    }
    const tableFile = archive.files[`data/${schema.name}.json`];
    if (tableFile !== undefined) {
      archiveTables.set(schema.name, {
        sha256: createHash('sha256').update(bytes(tableFile)).digest('hex'),
        rowCount: rows.length,
      });
    }
    if (schema.name === 'knowledge_projects' && rows[0]) {
      rows[0] = { ...rows[0], workspace_root: workspaceRoot };
    }
    validateTableRowValues(db, schema, rows, workspaceRoot, rowsByTable);
    totalRows += rows.length;
    if (totalRows > MAX_ARCHIVE_TOTAL_ROWS) {
      throw importRejected('archive exceeds the maximum supported total row count.');
    }
    rowsByTable.set(schema.name, rows);
  }
  if (validation.block) {
    const ignoredOptionalTables = new Map(
      [...dataFileReview.ignoredOptionalTables].map((table) => [
        table,
        { sha256: createHash('sha256').update(bytes(archive.files[`data/${table}.json`])).digest('hex') },
      ]),
    );
    assertTableFingerprints(validation.block, archiveTables, ignoredOptionalTables);
  }
  assertArchiveRelationships(rowsByTable, projectId);
  const materializedFiles = buildArchiveMaterializedFiles(archive, rowsByTable, workspaceRoot);
  if (
    containsChatPayloadV2(archive.files, rowsByTable.get('knowledge_messages') ?? []) &&
    !validation.block?.requiredFeatures.includes(KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2)
  ) {
    throw importRejected(`chat payload version 2 requires the ${KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2} feature declaration.`);
  }

  const existing = db.prepare('SELECT id FROM knowledge_projects WHERE id = ?').get(projectId);
  if (existing && !options.replaceExisting) {
    throw new Error(`Knowledge project already exists: ${projectId}`);
  }
  if (existing && options.replaceExisting && existingWorkspaceRoot && existingWorkspaceRoot !== workspaceRoot) {
    throw new Error('Knowledge archive replace target exists in a different workspace root.');
  }
  const staleArtifactPaths =
    existingWorkspaceRoot && existingWorkspaceRoot === workspaceRoot
      ? collectExistingArtifactPaths(db, projectId, existingWorkspaceRoot)
      : [];
  assertNoArtifactPathConflicts(
    db,
    projectId,
    workspaceRoot,
    new Set([...materializedFiles.map((file) => file.absolutePath), ...staleArtifactPaths]),
  );

  return {
    projectId,
    workspaceRoot,
    files: Object.keys(archive.files).sort(),
    rowsByTable,
    materializedFiles,
    staleArtifactPaths,
    tables: TABLES.reduce((count, table) => count + ((rowsByTable.get(table)?.length ?? 0) > 0 ? 1 : 0), 0),
    rows: totalRows,
    warnings,
    authenticity: validation.authenticity.result,
  };
}

function registeredTableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function existingRegisteredTables(db: Database.Database, ...classes: Parameters<typeof registeredTablesOfClass>): string[] {
  return registeredTablesOfClass(...classes).filter((table) => registeredTableExists(db, table));
}

/** Host-local and privacy-omitted state that `replaceExisting` must carry over instead of dropping with the project. */
interface PreservedHostState {
  settings: Record<string, unknown>[];
  privateRows: Array<{ table: string; rows: Record<string, unknown>[] }>;
  regressionRuns: Record<string, unknown>[];
}

function captureHostState(db: Database.Database, projectId: string): PreservedHostState {
  const settings = db
    .prepare(
      `SELECT ${preservedTableColumns(KNOWLEDGE_ARCHIVE_SETTINGS_TABLE).join(', ')} FROM ${KNOWLEDGE_ARCHIVE_SETTINGS_TABLE} ` +
        'WHERE project_id = ? AND substr(setting_key, 1, ?) = ?',
    )
    .all(projectId, KNOWLEDGE_HOST_SETTING_PREFIX.length, KNOWLEDGE_HOST_SETTING_PREFIX) as Record<string, unknown>[];
  const privateRows = existingRegisteredTables(db, 'privacy-omitted')
    .filter((table) => table !== KNOWLEDGE_ARCHIVE_SETTINGS_TABLE)
    .map((table) => ({ table, rows: preservedRowsFor(db, table, projectId) }))
    .filter((entry) => entry.rows.length > 0);
  const regressionRuns = registeredTableExists(db, 'knowledge_search_regression_runs')
    ? preservedRowsFor(db, 'knowledge_search_regression_runs', projectId)
    : [];
  return { settings, privateRows, regressionRuns };
}

function preservedRowsFor(db: Database.Database, table: string, projectId: string): Record<string, unknown>[] {
  const columns = preservedTableColumns(table);
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE project_id = ?`).all(projectId) as Record<string, unknown>[];
}

function clearRebuildableProjectState(db: Database.Database, projectId: string): void {
  for (const table of existingRegisteredTables(db, 'derived-rebuild', 'host-local')) {
    db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
  }
}

function insertPreservedRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = preservedTableColumns(table);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(
    Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
  );
}

function restoreHostState(db: Database.Database, preserved: PreservedHostState, importedSettingIds: ReadonlySet<string>): void {
  const usedIds = new Set(importedSettingIds);
  for (const setting of preserved.settings) {
    let id = String(setting.id);
    if (usedIds.has(id)) {
      id = `host_setting_${createHash('sha256').update(`${String(setting.project_id)}:${String(setting.setting_key)}`).digest('hex').slice(0, 24)}`;
    }
    usedIds.add(id);
    insertPreservedRow(db, KNOWLEDGE_ARCHIVE_SETTINGS_TABLE, { ...setting, id });
  }
  for (const { table, rows } of preserved.privateRows) {
    for (const row of rows) {
      insertPreservedRow(db, table, row);
    }
  }
  for (const row of preserved.regressionRuns) {
    insertPreservedRow(db, 'knowledge_search_regression_runs', row);
  }
}

export function importKnowledgeProject(
  db: Database.Database,
  archive: KnowledgeArchive,
  options: ImportKnowledgeProjectOptions,
): ImportResult {
  const plan = buildImportPlan(db, archive, options);
  let fileCommit: { finalize: () => void; rollback: () => void } | null = null;
  let transactionOpen = false;
  let committed = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const existing = db.prepare('SELECT id FROM knowledge_projects WHERE id = ?').get(plan.projectId);
    let preserved: PreservedHostState = { settings: [], privateRows: [], regressionRuns: [] };
    if (existing) {
      preserved = captureHostState(db, plan.projectId);
      clearRebuildableProjectState(db, plan.projectId);
      db.prepare('DELETE FROM knowledge_projects WHERE id = ?').run(plan.projectId);
    }
    let rows = 0;
    let tables = 0;
    for (const table of TABLES) {
      const schema = TABLE_SCHEMA_BY_NAME.get(table);
      if (!schema) {
        throw new Error(`Missing archive schema for table ${table}`);
      }
      const inserted = insertStatementsForTable(db, schema, plan.rowsByTable.get(table) ?? []);
      rows += inserted.rows;
      tables += inserted.tables;
    }
    const importedSettingIds = new Set((plan.rowsByTable.get('knowledge_settings') ?? []).map((row) => String(row.id)));
    restoreHostState(db, preserved, importedSettingIds);
    fileCommit = commitArchiveFiles(plan.workspaceRoot, plan.materializedFiles, plan.staleArtifactPaths);
    db.exec('COMMIT');
    transactionOpen = false;
    committed = true;
    fileCommit.finalize();
    return {
      projectId: plan.projectId,
      tables,
      rows,
      files: plan.files,
      warnings: [
        ...plan.warnings,
        {
          code: 'derived_data_rebuild_required',
          message: 'Derived search data is not imported; rebuild the search index and semantic model locally.',
        },
      ],
      postImport: { rebuildRequired: rebuildTargetsAfterImport() },
      authenticity: plan.authenticity,
    };
  } catch (error) {
    if (fileCommit && !committed) {
      try {
        fileCommit.rollback();
      } catch {
        // Best-effort cleanup while preserving the original import failure.
      }
    }
    if (transactionOpen) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
