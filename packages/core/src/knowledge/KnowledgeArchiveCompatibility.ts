import { createHash } from 'node:crypto';
import { KNOWLEDGE_HOST_SETTING_PREFIX } from './knowledgeSchema.js';

export type KnowledgeArchiveTableClass = 'required' | 'optional' | 'derived-rebuild' | 'host-local' | 'privacy-omitted';
export type KnowledgeArchiveOmissionReason = 'secret_omitted' | 'privacy_omitted' | 'host_local_only' | 'derived_rebuild';
export type KnowledgeArchiveRebuildTarget = 'search_index' | 'semantic_model';

export interface KnowledgeArchiveRowFilter {
  column: string;
  prefix: string;
}

export interface KnowledgeArchiveCompatibilityBlock {
  minimumReaderArchiveVersion: number;
  producedBy: {
    packageVersion: string | null;
    knowledgeSchemaVersion: number | null;
  };
  requiredFeatures: string[];
  optionalFeatures: string[];
  tableFingerprints: Array<{
    table: string;
    sha256: string;
    rowCount: number;
  }>;
  omissions: Array<{
    table: string;
    reason: KnowledgeArchiveOmissionReason;
    rowFilter?: KnowledgeArchiveRowFilter;
  }>;
}

export interface KnowledgeArchiveAuthenticity {
  algorithm: 'ed25519-detached';
  keyId: string;
  signerHint: string | null;
  signedManifestSha256: string;
  signatureBase64: string;
  signedAt: string;
}

export interface KnowledgeArchiveAuthenticitySigner {
  keyId: string;
  signerHint?: string | null;
  signManifestSha256(sha256: string): string;
}

export interface KnowledgeArchiveAuthenticityVerifier {
  verify(input: KnowledgeArchiveAuthenticity, manifestSha256: string): 'verified' | 'invalid' | 'unverified';
}

export interface KnowledgeArchiveCompatibilityPolicy {
  maxSupportedArchiveVersion: number;
  acceptedOptionalFeatures?: ReadonlySet<string>;
}

export interface KnowledgeArchiveWarning {
  code: string;
  message: string;
}

export type KnowledgeArchiveAuthenticityResult =
  | { state: 'absent' }
  | { state: 'verified'; keyId: string }
  | { state: 'unverified'; keyId: string }
  | { state: 'invalid'; keyId: string };

export interface KnowledgeArchiveTableRegistration {
  readonly class: KnowledgeArchiveTableClass;
  readonly feature?: string;
  readonly omissionReason?: KnowledgeArchiveOmissionReason;
  readonly rebuild?: KnowledgeArchiveRebuildTarget;
}

export const KNOWLEDGE_ARCHIVE_READER_VERSION = 2;
export const KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2 = 'knowledge-chat-payload-v2';
export const KNOWLEDGE_ARCHIVE_SETTINGS_TABLE = 'knowledge_settings';
export const KNOWLEDGE_ARCHIVE_PROVIDER_PROFILES_TABLE = 'knowledge_provider_profiles';
export const KNOWLEDGE_ARCHIVE_HOST_SETTING_ROW_FILTER: Readonly<KnowledgeArchiveRowFilter> = Object.freeze({
  column: 'setting_key',
  prefix: KNOWLEDGE_HOST_SETTING_PREFIX,
});

interface KnowledgeArchiveFeatureDefinition {
  readonly kind: 'required' | 'optional';
  readonly implemented: boolean;
}

/**
 * Features this reader can round-trip losslessly. A feature backed by tables that do not exist yet stays
 * `implemented: false` until the slice that owns those tables registers them in the archive table list.
 */
const FEATURES: ReadonlyMap<string, KnowledgeArchiveFeatureDefinition> = new Map([
  ['knowledge-analysis-coverage-v1', { kind: 'required', implemented: true }],
  [KNOWLEDGE_ARCHIVE_FEATURE_CHAT_PAYLOAD_V2, { kind: 'required', implemented: true }],
  ['knowledge-graph-reports-v1', { kind: 'optional', implemented: true }],
  ['knowledge-semantic-summaries-v1', { kind: 'optional', implemented: false }],
]);

const required = (feature?: string): KnowledgeArchiveTableRegistration => ({ class: 'required', ...(feature ? { feature } : {}) });
const optional = (feature: string): KnowledgeArchiveTableRegistration => ({ class: 'optional', feature });
const derived = (rebuild: KnowledgeArchiveRebuildTarget): KnowledgeArchiveTableRegistration => ({
  class: 'derived-rebuild',
  omissionReason: 'derived_rebuild',
  rebuild,
});
const hostLocal = (): KnowledgeArchiveTableRegistration => ({ class: 'host-local', omissionReason: 'host_local_only' });
const privacyOmitted = (omissionReason: 'secret_omitted' | 'privacy_omitted'): KnowledgeArchiveTableRegistration => ({
  class: 'privacy-omitted',
  omissionReason,
});

/** Single source of truth for how every knowledge table travels (or does not travel) in an archive. */
export const KNOWLEDGE_ARCHIVE_TABLE_REGISTRY: Readonly<Record<string, KnowledgeArchiveTableRegistration>> = Object.freeze({
  knowledge_projects: required(),
  knowledge_project_roots: required(),
  knowledge_settings: required(),
  knowledge_provider_profiles: privacyOmitted('secret_omitted'),
  knowledge_schema_versions: required(),
  knowledge_sources: required(),
  knowledge_source_versions: required(),
  knowledge_source_assets: required(),
  knowledge_source_spans: required(),
  knowledge_extractions: required(),
  knowledge_pages: required(),
  knowledge_page_versions: required(),
  knowledge_page_sources: required(),
  knowledge_page_provenance: required(),
  knowledge_page_aliases: required(),
  knowledge_page_links: required(),
  knowledge_graph_nodes: required(),
  knowledge_graph_edges: required(),
  knowledge_graph_snapshots: required(),
  knowledge_communities: required(),
  knowledge_insights: required(),
  knowledge_jobs: required(),
  knowledge_job_events: required(),
  knowledge_reviews: required(),
  knowledge_review_actions: required(),
  knowledge_research_runs: required(),
  knowledge_research_results: required(),
  knowledge_conversations: required(),
  knowledge_messages: required(),
  knowledge_outputs: required(),
  knowledge_operation_log: required(),
  knowledge_search_indexes: derived('search_index'),
  knowledge_search_index_fields: derived('search_index'),
  knowledge_search_index_tokens: derived('search_index'),
  knowledge_search_semantic_models: derived('semantic_model'),
  knowledge_search_semantic_vectors: derived('semantic_model'),
  knowledge_search_semantic_neighbors: derived('semantic_model'),
  knowledge_source_freshness: hostLocal(),
  knowledge_project_watchers: hostLocal(),
  knowledge_search_regression_runs: hostLocal(),
  knowledge_analysis_coverage: required('knowledge-analysis-coverage-v1'),
  knowledge_deferred_relationships: required('knowledge-analysis-coverage-v1'),
  knowledge_graph_reports: optional('knowledge-graph-reports-v1'),
  knowledge_graph_ambiguities: optional('knowledge-graph-reports-v1'),
  knowledge_semantic_summaries: optional('knowledge-semantic-summaries-v1'),
  knowledge_search_feedback: privacyOmitted('privacy_omitted'),
  knowledge_query_analytics_daily: privacyOmitted('privacy_omitted'),
});

/**
 * Explicit columns for every table whose rows `replaceExisting` reads and re-inserts (host-local settings and
 * privacy-omitted tables). Preserved-row SQL is built only from these lists, never from row keys or `SELECT *`.
 */
export const KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [KNOWLEDGE_ARCHIVE_SETTINGS_TABLE]: Object.freeze(['id', 'project_id', 'setting_key', 'setting_value', 'created_at', 'updated_at']),
  [KNOWLEDGE_ARCHIVE_PROVIDER_PROFILES_TABLE]: Object.freeze([
    'id',
    'project_id',
    'provider_kind',
    'profile_name',
    'configuration_json',
    'created_at',
    'updated_at',
  ]),
  knowledge_search_feedback: Object.freeze([
    'id',
    'project_id',
    'query_fingerprint',
    'search_mode',
    'result_kind',
    'result_ref',
    'feedback_kind',
    'rank_position',
    'ambiguity_state',
    'citation_present',
    'feedback_count',
    'first_day',
    'last_day',
  ]),
  knowledge_query_analytics_daily: Object.freeze([
    'id',
    'project_id',
    'day',
    'search_mode',
    'total_queries',
    'zero_result_queries',
    'ambiguous_top_results',
    'citationless_top_results',
    'accepted_result_count',
    'rejected_result_count',
    'total_result_count',
    'created_at',
    'updated_at',
  ]),
});

export function preservedTableColumns(table: string): readonly string[] {
  const columns = Object.hasOwn(KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS, table)
    ? KNOWLEDGE_ARCHIVE_PRESERVED_TABLE_COLUMNS[table]
    : undefined;
  if (!columns) {
    throw new Error(`Knowledge archive import has no preserved-column allowlist for ${table}.`);
  }
  return columns;
}

const REGISTERED_TABLE_NAMES: readonly string[] = Object.freeze(Object.keys(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY));
const TABLE_IDENTIFIER_PATTERN = /^knowledge_[a-z_]+$/;

export function getKnowledgeArchiveRegistration(table: string): KnowledgeArchiveTableRegistration | undefined {
  return Object.hasOwn(KNOWLEDGE_ARCHIVE_TABLE_REGISTRY, table) ? KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table] : undefined;
}

/** Registry tables of the given classes; the only source of table identifiers interpolated into SQL. */
export function registeredTablesOfClass(...classes: KnowledgeArchiveTableClass[]): string[] {
  return REGISTERED_TABLE_NAMES.filter((table) => {
    const registration = KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table];
    return classes.includes(registration.class) && TABLE_IDENTIFIER_PATTERN.test(table);
  });
}

export function rebuildTargetsAfterImport(): KnowledgeArchiveRebuildTarget[] {
  const targets = new Set<KnowledgeArchiveRebuildTarget>();
  for (const table of registeredTablesOfClass('derived-rebuild')) {
    const rebuild = KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table].rebuild;
    if (rebuild) targets.add(rebuild);
  }
  return [...targets].sort();
}

export function importRejected(reason: string): Error {
  return new Error(`Knowledge archive import rejected: ${reason}`);
}

export function manifestVersionIncompatible(reason: string): Error {
  return Object.assign(new Error(`Knowledge archive export rejected: manifest_version_incompatible: ${reason}`), {
    code: 'manifest_version_incompatible',
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_FEATURES = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_SIGNATURE_LENGTH = 4096;

export function isImplementedRequiredFeature(feature: string): boolean {
  const definition = FEATURES.get(feature);
  return definition?.kind === 'required' && definition.implemented;
}

export function isImplementedOptionalFeature(feature: string): boolean {
  const definition = FEATURES.get(feature);
  return definition?.kind === 'optional' && definition.implemented;
}

export function featuresForTables(tables: Iterable<string>): { required: string[]; optional: string[] } {
  const requiredFeatures = new Set<string>();
  const optionalFeatures = new Set<string>();
  for (const table of tables) {
    const registration = getKnowledgeArchiveRegistration(table);
    if (!registration?.feature) continue;
    (registration.class === 'optional' ? optionalFeatures : requiredFeatures).add(registration.feature);
  }
  return { required: [...requiredFeatures].sort(), optional: [...optionalFeatures].sort() };
}

export function expectedOmissions(): KnowledgeArchiveCompatibilityBlock['omissions'] {
  const omissions: KnowledgeArchiveCompatibilityBlock['omissions'] = [];
  for (const table of registeredTablesOfClass('derived-rebuild', 'host-local', 'privacy-omitted')) {
    const reason = KNOWLEDGE_ARCHIVE_TABLE_REGISTRY[table].omissionReason;
    if (reason) omissions.push({ table, reason });
  }
  omissions.push({
    table: KNOWLEDGE_ARCHIVE_SETTINGS_TABLE,
    reason: 'host_local_only',
    rowFilter: { ...KNOWLEDGE_ARCHIVE_HOST_SETTING_ROW_FILTER },
  });
  return omissions;
}

function parseFeatureList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FEATURES) {
    throw importRejected(`compatibility.${label} must be an array of at most ${MAX_FEATURES} feature identifiers.`);
  }
  const seen = new Set<string>();
  for (const feature of value) {
    if (typeof feature !== 'string' || feature.length === 0 || feature.length > MAX_IDENTIFIER_LENGTH || seen.has(feature)) {
      throw importRejected(`compatibility.${label} must contain unique non-empty feature identifiers.`);
    }
    seen.add(feature);
  }
  return [...seen];
}

function parseCompatibilityBlock(value: unknown): KnowledgeArchiveCompatibilityBlock {
  if (!isPlainObject(value)) {
    throw importRejected('manifest compatibility block is required for version 2 archives.');
  }
  const minimum = value.minimumReaderArchiveVersion;
  if (typeof minimum !== 'number' || !Number.isInteger(minimum) || minimum < 1) {
    throw importRejected('compatibility.minimumReaderArchiveVersion must be a positive integer.');
  }
  const producedBy = value.producedBy;
  if (
    !isPlainObject(producedBy) ||
    !(producedBy.packageVersion === null || typeof producedBy.packageVersion === 'string') ||
    !(producedBy.knowledgeSchemaVersion === null || (typeof producedBy.knowledgeSchemaVersion === 'number' && Number.isInteger(producedBy.knowledgeSchemaVersion)))
  ) {
    throw importRejected('compatibility.producedBy must describe a package version and knowledge schema version.');
  }
  if (!Array.isArray(value.tableFingerprints) || value.tableFingerprints.length > REGISTERED_TABLE_NAMES.length * 2) {
    throw importRejected('compatibility.tableFingerprints must be an array of table fingerprints.');
  }
  const tableFingerprints = value.tableFingerprints.map((entry: unknown) => {
    if (
      !isPlainObject(entry) ||
      typeof entry.table !== 'string' ||
      entry.table.length === 0 ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.sha256) ||
      typeof entry.rowCount !== 'number' ||
      !Number.isInteger(entry.rowCount) ||
      entry.rowCount < 0
    ) {
      throw importRejected('compatibility.tableFingerprints entries must include a table, a sha256 fingerprint, and a row count.');
    }
    return { table: entry.table, sha256: entry.sha256, rowCount: entry.rowCount };
  });
  if (!Array.isArray(value.omissions) || value.omissions.length > REGISTERED_TABLE_NAMES.length * 2) {
    throw importRejected('compatibility.omissions must be an array of omission declarations.');
  }
  const omissions = value.omissions.map((entry: unknown) => {
    if (!isPlainObject(entry) || typeof entry.table !== 'string' || typeof entry.reason !== 'string') {
      throw importRejected('compatibility.omissions entries must include a table and a reason.');
    }
    const rowFilter = entry.rowFilter;
    if (rowFilter !== undefined && (!isPlainObject(rowFilter) || typeof rowFilter.column !== 'string' || typeof rowFilter.prefix !== 'string')) {
      throw importRejected('compatibility.omissions rowFilter must include a column and a prefix.');
    }
    return {
      table: entry.table,
      reason: entry.reason as KnowledgeArchiveOmissionReason,
      ...(rowFilter ? { rowFilter: { column: rowFilter.column as string, prefix: rowFilter.prefix as string } } : {}),
    };
  });
  return {
    minimumReaderArchiveVersion: minimum,
    producedBy: {
      packageVersion: producedBy.packageVersion as string | null,
      knowledgeSchemaVersion: producedBy.knowledgeSchemaVersion as number | null,
    },
    requiredFeatures: parseFeatureList(value.requiredFeatures, 'requiredFeatures'),
    optionalFeatures: parseFeatureList(value.optionalFeatures, 'optionalFeatures'),
    tableFingerprints,
    omissions,
  };
}

function assertOmissionsAreDeclaredHonestly(omissions: KnowledgeArchiveCompatibilityBlock['omissions']): void {
  for (const omission of omissions) {
    const registration = getKnowledgeArchiveRegistration(omission.table);
    if (!registration) {
      throw importRejected('omission declares a table without an archive classification.');
    }
    if (omission.table === KNOWLEDGE_ARCHIVE_SETTINGS_TABLE) {
      const filter = omission.rowFilter;
      if (
        omission.reason !== 'host_local_only' ||
        filter?.column !== KNOWLEDGE_ARCHIVE_HOST_SETTING_ROW_FILTER.column ||
        filter.prefix !== KNOWLEDGE_ARCHIVE_HOST_SETTING_ROW_FILTER.prefix
      ) {
        throw importRejected('omission of knowledge_settings must be the host-local row filter.');
      }
      continue;
    }
    if (registration.omissionReason === undefined || omission.reason !== registration.omissionReason || omission.rowFilter !== undefined) {
      throw importRejected(`omission for ${omission.table} does not match its archive classification.`);
    }
  }
}

export interface KnowledgeArchiveCompatibilityAssessment {
  version: 1 | 2;
  block: KnowledgeArchiveCompatibilityBlock | null;
  warnings: KnowledgeArchiveWarning[];
}

export function assessManifestCompatibility(
  manifest: { archiveVersion: unknown; compatibility?: unknown; authenticity?: unknown },
  policy: KnowledgeArchiveCompatibilityPolicy | undefined,
): KnowledgeArchiveCompatibilityAssessment {
  const supported = Math.min(policy?.maxSupportedArchiveVersion ?? KNOWLEDGE_ARCHIVE_READER_VERSION, KNOWLEDGE_ARCHIVE_READER_VERSION);
  const version = manifest.archiveVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > supported) {
    throw new Error(`Unsupported knowledge archive version: ${String(version)}`);
  }
  if (version === 1) {
    if (manifest.compatibility !== undefined || manifest.authenticity !== undefined) {
      throw importRejected('version 1 manifests must not declare compatibility or authenticity metadata.');
    }
    return { version: 1, block: null, warnings: [] };
  }

  const block = parseCompatibilityBlock(manifest.compatibility);
  if (block.minimumReaderArchiveVersion > supported) {
    throw importRejected('archive requires a newer reader than this build supports.');
  }
  const warnings: KnowledgeArchiveWarning[] = [];
  for (const feature of block.requiredFeatures) {
    if (!isImplementedRequiredFeature(feature)) {
      throw importRejected(`archive requires an unsupported required feature: ${feature}.`);
    }
  }
  for (const feature of block.optionalFeatures) {
    if (!isImplementedOptionalFeature(feature) && !policy?.acceptedOptionalFeatures?.has(feature)) {
      warnings.push({ code: 'optional_feature_ignored', message: `Optional archive feature ${feature} is not applied by this reader.` });
    }
  }
  assertOmissionsAreDeclaredHonestly(block.omissions);
  return { version: 2, block, warnings };
}

const DATA_FILE_PATTERN = /^data\/([^/]+)\.json$/;

export interface KnowledgeArchiveDataFileReview {
  tables: Set<string>;
  ignoredOptionalTables: Set<string>;
  warnings: KnowledgeArchiveWarning[];
}

/** Classifies every `data/` file so an archive can never smuggle in a table the registry does not allow. */
export function reviewArchiveDataFiles(
  filePaths: readonly string[],
  version: 1 | 2,
  supportedTables: ReadonlySet<string>,
): KnowledgeArchiveDataFileReview {
  const tables = new Set<string>();
  const ignoredOptionalTables = new Set<string>();
  const warnings: KnowledgeArchiveWarning[] = [];
  for (const filePath of filePaths) {
    if (!filePath.startsWith('data/')) continue;
    const table = DATA_FILE_PATTERN.exec(filePath)?.[1];
    const registration = table === undefined ? undefined : getKnowledgeArchiveRegistration(table);
    if (table === undefined || registration === undefined) {
      throw importRejected(`data file ${filePath} has no archive classification.`);
    }
    switch (registration.class) {
      case 'host-local':
        throw importRejected(`table ${table} is host-local and must not appear in an archive.`);
      case 'derived-rebuild':
        throw importRejected(`table ${table} is derived data that is rebuilt locally and must not appear in an archive.`);
      case 'privacy-omitted':
        if (table === KNOWLEDGE_ARCHIVE_PROVIDER_PROFILES_TABLE && version === 1) continue;
        throw importRejected(`table ${table} is privacy-omitted (${registration.omissionReason}) and must not appear in an archive.`);
      case 'optional':
        if (!supportedTables.has(table)) {
          warnings.push({ code: 'optional_table_unsupported', message: `Optional archive table ${table} is not supported by this reader and was ignored.` });
          ignoredOptionalTables.add(table);
          continue;
        }
        break;
      case 'required':
        if (!supportedTables.has(table)) {
          throw importRejected(`table ${table} requires a newer reader.`);
        }
        break;
    }
    tables.add(table);
  }
  return { tables, ignoredOptionalTables, warnings };
}

export function assertTableFingerprints(
  block: KnowledgeArchiveCompatibilityBlock,
  archiveTables: ReadonlyMap<string, { sha256: string; rowCount: number }>,
  ignoredOptionalTables: ReadonlyMap<string, { sha256: string }> = new Map(),
): void {
  const declared = new Map<string, { sha256: string; rowCount: number }>();
  for (const fingerprint of block.tableFingerprints) {
    if (declared.has(fingerprint.table)) {
      throw importRejected(`compatibility.tableFingerprints declares ${fingerprint.table} more than once.`);
    }
    declared.set(fingerprint.table, fingerprint);
  }
  for (const [table, actual] of archiveTables) {
    const fingerprint = declared.get(table);
    if (!fingerprint) {
      throw importRejected(`table ${table} has no table fingerprint.`);
    }
    if (fingerprint.sha256 !== actual.sha256 || fingerprint.rowCount !== actual.rowCount) {
      throw importRejected(`table fingerprint mismatch for ${table}.`);
    }
  }
  for (const [table, fingerprint] of declared) {
    const ignored = ignoredOptionalTables.get(table);
    if (ignored) {
      // The reader cannot parse an unsupported table, so only the file hash is verifiable.
      if (fingerprint.sha256 !== ignored.sha256) {
        throw importRejected(`table fingerprint mismatch for ${table}.`);
      }
      continue;
    }
    if (!archiveTables.has(table)) {
      throw importRejected(`table fingerprint declared for ${table}, which is not an imported archive table.`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical manifest with the `authenticity` field excluded. */
export function manifestSha256(manifest: object): string {
  const { authenticity: _authenticity, ...unsigned } = manifest as Record<string, unknown>;
  return createHash('sha256').update(canonicalJson(unsigned), 'utf8').digest('hex');
}

export function assertSignatureBase64(value: unknown, reject: (reason: string) => Error): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SIGNATURE_LENGTH || !BASE64_PATTERN.test(value)) {
    throw reject('authenticity signature must be a non-empty base64 string.');
  }
  return value;
}

export function signKnowledgeArchiveManifest(
  manifest: object,
  signer: KnowledgeArchiveAuthenticitySigner,
  signedAt: string,
): KnowledgeArchiveAuthenticity {
  if (typeof signer.keyId !== 'string' || signer.keyId.length === 0 || signer.keyId.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error('Knowledge archive export rejected: authenticity signer keyId must be a non-empty string.');
  }
  const digest = manifestSha256(manifest);
  return {
    algorithm: 'ed25519-detached',
    keyId: signer.keyId,
    signerHint: signer.signerHint ?? null,
    signedManifestSha256: digest,
    signatureBase64: assertSignatureBase64(signer.signManifestSha256(digest), (reason) => new Error(`Knowledge archive export rejected: ${reason}`)),
    signedAt,
  };
}

function parseAuthenticity(value: unknown): KnowledgeArchiveAuthenticity {
  if (!isPlainObject(value)) {
    throw importRejected('authenticity metadata must be an object.');
  }
  if (value.algorithm !== 'ed25519-detached') {
    throw importRejected('authenticity metadata declares an unsupported algorithm.');
  }
  if (typeof value.keyId !== 'string' || value.keyId.length === 0 || value.keyId.length > MAX_IDENTIFIER_LENGTH) {
    throw importRejected('authenticity metadata keyId must be a non-empty string.');
  }
  if (value.signerHint !== null && value.signerHint !== undefined && (typeof value.signerHint !== 'string' || value.signerHint.length > MAX_IDENTIFIER_LENGTH)) {
    throw importRejected('authenticity metadata signerHint must be a string or null.');
  }
  if (typeof value.signedManifestSha256 !== 'string' || !SHA256_PATTERN.test(value.signedManifestSha256)) {
    throw importRejected('authenticity metadata signedManifestSha256 must be a sha256 hex digest.');
  }
  if (typeof value.signedAt !== 'string' || value.signedAt.length === 0 || value.signedAt.length > MAX_IDENTIFIER_LENGTH) {
    throw importRejected('authenticity metadata signedAt must be a non-empty string.');
  }
  return {
    algorithm: 'ed25519-detached',
    keyId: value.keyId,
    signerHint: (value.signerHint as string | null | undefined) ?? null,
    signedManifestSha256: value.signedManifestSha256,
    signatureBase64: assertSignatureBase64(value.signatureBase64, importRejected),
    signedAt: value.signedAt,
  };
}

export function assessAuthenticity(
  manifest: object & { authenticity?: unknown },
  verifier: KnowledgeArchiveAuthenticityVerifier | undefined,
): { result: KnowledgeArchiveAuthenticityResult; warnings: KnowledgeArchiveWarning[] } {
  if (manifest.authenticity === undefined) {
    return {
      result: { state: 'absent' },
      warnings: [{ code: 'authenticity_absent', message: 'Archive carries no authenticity metadata; integrity relies on manifest checksums only.' }],
    };
  }
  const authenticity = parseAuthenticity(manifest.authenticity);
  if (authenticity.signedManifestSha256 !== manifestSha256(manifest)) {
    throw importRejected('authenticity metadata does not match the manifest contents.');
  }
  let outcome: 'verified' | 'invalid' | 'unverified' = 'unverified';
  if (verifier) {
    try {
      outcome = verifier.verify(authenticity, authenticity.signedManifestSha256);
    } catch {
      outcome = 'invalid';
    }
  }
  if (outcome === 'invalid') {
    throw importRejected('authenticity verification failed.');
  }
  if (outcome === 'verified') {
    return { result: { state: 'verified', keyId: authenticity.keyId }, warnings: [] };
  }
  return {
    result: { state: 'unverified', keyId: authenticity.keyId },
    warnings: [{ code: 'authenticity_unverified', message: 'Archive authenticity metadata is present but could not be verified locally.' }],
  };
}
