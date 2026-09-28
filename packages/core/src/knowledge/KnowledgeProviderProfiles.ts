import net from 'node:net';
import type Database from 'better-sqlite3';
import { redact } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import { classifyProviderEndpointIp, tryParseCanonicalIpLiteral } from './ProviderEndpointIpPolicy.js';
import type { KnowledgeProviderCapability } from './KnowledgeProviders.js';

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_LABEL_PATTERN = /^[A-Za-z0-9-]{1,63}$/;
const SUPPORTED_PROFILE_CAPABILITIES = new Set<KnowledgeProviderCapability>(['analysis', 'generation']);
const MAX_MODEL_LENGTH = 256;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_LENGTH = 280;
const KNOWLEDGE_PROVIDER_ENVIRONMENT_PREFIX = 'ARIADNE_KNOWLEDGE_PROVIDER_';
const TRUNCATION_SUFFIX = ' …[truncated]';

export interface KnowledgeProviderProfile {
  id: string;
  projectId: string;
  providerKind: 'openai-compatible';
  profileName: string;
  endpoint: string;
  model: string;
  capabilities: KnowledgeProviderCapability[];
  timeoutMs: number;
  apiKeyEnv: string | null;
  enabled: boolean;
}

export interface CreateKnowledgeProviderProfileInput {
  projectId: string;
  profileName: string;
  endpoint: string;
  model: string;
  capabilities: KnowledgeProviderCapability[];
  timeoutMs: number;
  apiKeyEnv?: string | null;
  enabled?: boolean;
}

export interface KnowledgeProviderDiagnostic {
  code: string;
  message: string;
}

export interface KnowledgeProviderTestAdapterResult {
  success: boolean;
  warnings?: readonly KnowledgeProviderDiagnostic[];
  diagnostics?: readonly string[];
}

export interface KnowledgeProviderTestAdapterInput {
  profile: KnowledgeProviderProfile;
  environment: NodeJS.ProcessEnv;
  apiKey: string | null;
}

export interface KnowledgeProviderTestAdapter {
  testProfile(input: KnowledgeProviderTestAdapterInput): Promise<KnowledgeProviderTestAdapterResult>;
}

export type KnowledgeProviderProfileTestAdapter = KnowledgeProviderTestAdapter;

export interface KnowledgeProviderTestResult {
  success: boolean;
  profile: KnowledgeProviderProfile;
  warnings: KnowledgeProviderDiagnostic[];
  diagnostics: string[];
}

export interface ResolveKnowledgeProviderApiKeyResult {
  apiKey: string | null;
  warnings: KnowledgeProviderDiagnostic[];
}

export interface KnowledgeProviderCredentialPolicy {
  allowedEnvironmentVariables?: ReadonlySet<string>;
  allowedLegacyEnvironmentVariables?: ReadonlySet<string>;
  resolveApiKey?: (input: {
    profile: KnowledgeProviderProfile;
    environment: NodeJS.ProcessEnv;
    envName: string;
  }) => string | null;
}

export interface KnowledgeProviderProfileListResult {
  profiles: KnowledgeProviderProfile[];
  warnings: KnowledgeProviderDiagnostic[];
}

export interface KnowledgeProviderProfileStoreOptions {
  now?: () => string;
  adapter?: KnowledgeProviderTestAdapter;
  credentialPolicy?: KnowledgeProviderCredentialPolicy;
}

interface ProviderProfileConfiguration {
  endpoint: string;
  model: string;
  capabilities: KnowledgeProviderCapability[];
  timeoutMs: number;
  apiKeyEnv: string | null;
  enabled: boolean;
}

interface ProviderProfileRow {
  id: string;
  project_id: string;
  provider_kind: string;
  profile_name: string;
  configuration_json: string;
}

interface ProfileCompatibilityResult {
  profile: KnowledgeProviderProfile | null;
  warning: KnowledgeProviderDiagnostic | null;
}

function requireNonEmptyString(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Knowledge provider ${label} must not be empty`);
  }
  return trimmed;
}

function sanitizeDiagnostic(value: string): string {
  const redacted = redact(value)
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'Authorization: Bearer ***')
    .replace(/\bbearer\s+\S+/gi, 'Bearer ***')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim();
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
}

function canonicalizeHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function extractRawHostnameToken(endpoint: string): string | null {
  const schemeSeparator = endpoint.indexOf('://');
  if (schemeSeparator < 0) {
    return null;
  }
  const afterScheme = endpoint.slice(schemeSeparator + 3);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (authority.length === 0 || authority.includes('@')) {
    return null;
  }
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    return closingBracket === -1 ? null : authority.slice(0, closingBracket + 1);
  }
  const portSeparator = authority.lastIndexOf(':');
  if (portSeparator === -1) {
    return authority;
  }
  return authority.slice(0, portSeparator);
}

function validateProfileName(profileName: string): string {
  const trimmed = requireNonEmptyString(profileName, 'profile name');
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new Error('Knowledge provider profile name must use letters, numbers, dots, dashes, or underscores');
  }
  return trimmed;
}

function validateModel(model: string): string {
  const trimmed = requireNonEmptyString(model, 'model');
  if (trimmed.length > MAX_MODEL_LENGTH) {
    throw new Error(`Knowledge provider model must not exceed ${MAX_MODEL_LENGTH} characters`);
  }
  return trimmed;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Knowledge provider timeout must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}ms`);
  }
  return timeoutMs;
}

function isValidHostname(hostname: string): boolean {
  const normalized = canonicalizeHostname(hostname);
  if (normalized.length === 0 || normalized.length > 253) {
    return false;
  }
  if (net.isIP(normalized) > 0) {
    return true;
  }
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }
  const labels = normalized.split('.');
  if (labels.some((label) => label.length === 0 || !HOST_LABEL_PATTERN.test(label))) {
    return false;
  }
  return labels.every((label) => !label.startsWith('-') && !label.endsWith('-'));
}

export function normalizeOpenAICompatibleEndpoint(endpoint: string): string {
  const trimmed = requireNonEmptyString(endpoint, 'endpoint');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Knowledge provider endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Knowledge provider endpoint must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Knowledge provider endpoint must not include credentials');
  }
  if (parsed.search) {
    throw new Error('Knowledge provider endpoint must not include a query string');
  }
  if (parsed.hash) {
    throw new Error('Knowledge provider endpoint must not include a URL fragment');
  }
  if (!isValidHostname(parsed.hostname)) {
    throw new Error('Knowledge provider endpoint hostname is malformed');
  }
  if (parsed.port) {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Knowledge provider endpoint port must be between 1 and 65535');
    }
  }
  const normalizedHostname = canonicalizeHostname(parsed.hostname).toLowerCase();
  const literalHostname = tryParseCanonicalIpLiteral(normalizedHostname);
  const rawHostnameToken = extractRawHostnameToken(trimmed);
  if (parsed.protocol === 'http:' && literalHostname === null) {
    throw new Error('Knowledge provider http endpoints must use explicit loopback IP literals');
  }
  if (
    parsed.protocol === 'https:' &&
    (normalizedHostname === 'localhost' || normalizedHostname.endsWith('.localhost'))
  ) {
    throw new Error('Knowledge provider https endpoints must not target localhost or private IP / special-use ranges');
  }
  if (parsed.protocol === 'http:') {
    if (rawHostnameToken !== '127.0.0.1' && rawHostnameToken !== '[::1]') {
      throw new Error('Knowledge provider http endpoints are limited to the exact loopback literals 127.0.0.1 and ::1');
    }
    const classification = classifyProviderEndpointIp(normalizedHostname);
    if (!classification.isExactLoopbackLiteral) {
      throw new Error('Knowledge provider http endpoints are limited to the exact loopback literals 127.0.0.1 and ::1');
    }
  }
  if (parsed.protocol === 'https:' && literalHostname !== null) {
    const classification = classifyProviderEndpointIp(normalizedHostname);
    if (!classification.isGlobalDestination) {
      throw new Error('Knowledge provider https endpoints must not target localhost or private IP / special-use ranges');
    }
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/g, '');
  return `${parsed.origin}${normalizedPath === '' || normalizedPath === '/' ? '' : normalizedPath}`;
}

function validateCapabilities(capabilities: readonly KnowledgeProviderCapability[]): KnowledgeProviderCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > SUPPORTED_PROFILE_CAPABILITIES.size) {
    throw new Error('Knowledge provider capabilities must contain one or two supported entries');
  }
  const normalized: KnowledgeProviderCapability[] = [];
  for (const capability of capabilities) {
    if (!SUPPORTED_PROFILE_CAPABILITIES.has(capability)) {
      throw new Error(`Knowledge provider capability is unsupported for profiles: ${capability}`);
    }
    if (normalized.includes(capability)) {
      throw new Error(`Knowledge provider capability is duplicated: ${capability}`);
    }
    normalized.push(capability);
  }
  return normalized;
}

function validateEnvironmentVariableName(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = requireNonEmptyString(value, 'API key environment variable');
  if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
    throw new Error('Knowledge provider API key must be stored as an environment-variable name only');
  }
  if (!trimmed.startsWith(KNOWLEDGE_PROVIDER_ENVIRONMENT_PREFIX)) {
    throw new Error(
      `Knowledge provider API key environment variables must use the ${KNOWLEDGE_PROVIDER_ENVIRONMENT_PREFIX} prefix`,
    );
  }
  return trimmed;
}

function validatePersistedEnvironmentVariableName(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = requireNonEmptyString(value, 'API key environment variable');
  if (!ENVIRONMENT_VARIABLE_PATTERN.test(trimmed)) {
    throw new Error('Knowledge provider API key must be stored as an environment-variable name only');
  }
  return trimmed;
}

function parseConfiguration(configurationJson: string): ProviderProfileConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configurationJson);
  } catch {
    throw new Error('Knowledge provider profile configuration is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Knowledge provider profile configuration must be an object');
  }
  const candidate = parsed as Record<string, unknown>;
  const expectedKeys = ['endpoint', 'model', 'capabilities', 'timeoutMs', 'apiKeyEnv', 'enabled'];
  const candidateKeys = Object.keys(candidate).sort();
  if (JSON.stringify(candidateKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error('Knowledge provider profile configuration contains unsupported keys');
  }
  if (!Array.isArray(candidate.capabilities)) {
    throw new Error('Knowledge provider capabilities must be an array');
  }
  if (typeof candidate.enabled !== 'boolean') {
    throw new Error('Knowledge provider enabled flag must be a boolean');
  }
  if (typeof candidate.endpoint !== 'string') {
    throw new Error('Knowledge provider endpoint must be a string');
  }
  if (typeof candidate.model !== 'string') {
    throw new Error('Knowledge provider model must be a string');
  }
  if (typeof candidate.timeoutMs !== 'number') {
    throw new Error('Knowledge provider timeout must be a number');
  }
  if (candidate.apiKeyEnv !== null && candidate.apiKeyEnv !== undefined && typeof candidate.apiKeyEnv !== 'string') {
    throw new Error('Knowledge provider API key environment variable must be a string or null');
  }
  return {
    endpoint: normalizeOpenAICompatibleEndpoint(candidate.endpoint),
    model: validateModel(candidate.model),
    capabilities: validateCapabilities(candidate.capabilities as KnowledgeProviderCapability[]),
    timeoutMs: validateTimeout(candidate.timeoutMs),
    apiKeyEnv: validatePersistedEnvironmentVariableName(candidate.apiKeyEnv),
    enabled: candidate.enabled,
  };
}

function configurationJson(profile: ProviderProfileConfiguration): string {
  return JSON.stringify({
    endpoint: profile.endpoint,
    model: profile.model,
    capabilities: profile.capabilities,
    timeoutMs: profile.timeoutMs,
    apiKeyEnv: profile.apiKeyEnv,
    enabled: profile.enabled,
  });
}

export function resolveKnowledgeProviderApiKey(
  profile: KnowledgeProviderProfile,
  environment: NodeJS.ProcessEnv,
  policy: KnowledgeProviderCredentialPolicy = {},
): ResolveKnowledgeProviderApiKeyResult {
  if (profile.apiKeyEnv === null) {
    return { apiKey: null, warnings: [] };
  }
  const usesDedicatedProviderPrefix = profile.apiKeyEnv.startsWith(KNOWLEDGE_PROVIDER_ENVIRONMENT_PREFIX);
  const legacyEnvAllowlisted = policy.allowedLegacyEnvironmentVariables?.has(profile.apiKeyEnv) === true;
  if (!usesDedicatedProviderPrefix && !legacyEnvAllowlisted) {
    return {
      apiKey: null,
      warnings: [
        {
          code: 'provider_api_key_not_allowed',
          message: sanitizeDiagnostic(
            `Provider profile "${profile.profileName}" references legacy environment variable "${profile.apiKeyEnv}", but the host did not explicitly allowlist it. Resolution was skipped.`,
          ),
        },
      ],
    };
  }
  if (policy.resolveApiKey) {
    const candidate = environment[profile.apiKeyEnv];
    const resolverEnvironment: NodeJS.ProcessEnv = typeof candidate === 'string' ? { [profile.apiKeyEnv]: candidate } : {};
    const resolved = policy.resolveApiKey({
      profile,
      environment: resolverEnvironment,
      envName: profile.apiKeyEnv,
    });
    if (typeof resolved !== 'string' || resolved.trim().length === 0) {
      return {
        apiKey: null,
        warnings: [
          {
            code: 'provider_missing_api_key',
            message: sanitizeDiagnostic(
              `Provider profile "${profile.profileName}" expects environment variable "${profile.apiKeyEnv}" but it is not set.`,
            ),
          },
        ],
      };
    }
    return { apiKey: resolved, warnings: [] };
  }
  if (!policy.allowedEnvironmentVariables?.has(profile.apiKeyEnv) && !legacyEnvAllowlisted) {
    return {
      apiKey: null,
      warnings: [
        {
          code: 'provider_api_key_not_allowed',
          message: sanitizeDiagnostic(
            `Provider profile "${profile.profileName}" references environment variable "${profile.apiKeyEnv}", but the host did not approve it.`,
          ),
        },
      ],
    };
  }
  const candidate = environment[profile.apiKeyEnv];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return {
      apiKey: null,
      warnings: [
        {
          code: 'provider_missing_api_key',
          message: sanitizeDiagnostic(
            `Provider profile "${profile.profileName}" expects environment variable "${profile.apiKeyEnv}" but it is not set.`,
          ),
        },
      ],
    };
  }
  return { apiKey: candidate, warnings: [] };
}

export class KnowledgeProviderProfileStore {
  private readonly now: () => string;
  private readonly adapter?: KnowledgeProviderTestAdapter;
  private readonly credentialPolicy: KnowledgeProviderCredentialPolicy;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeProviderProfileStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.adapter = options.adapter;
    this.credentialPolicy = options.credentialPolicy ?? {};
  }

  public create(input: CreateKnowledgeProviderProfileInput): KnowledgeProviderProfile {
    const projectId = requireNonEmptyString(input.projectId, 'project ID');
    const profileName = validateProfileName(input.profileName);
    this.ensureProjectExists(projectId);
    this.ensureUniqueProfileName(projectId, profileName);
    const configuration: ProviderProfileConfiguration = {
      endpoint: normalizeOpenAICompatibleEndpoint(input.endpoint),
      model: validateModel(input.model),
      capabilities: validateCapabilities(input.capabilities),
      timeoutMs: validateTimeout(input.timeoutMs),
      apiKeyEnv: validateEnvironmentVariableName(input.apiKeyEnv),
      enabled: input.enabled ?? false,
    };
    const createdAt = this.now();
    const id = createKnowledgeId('provider-profile', `${projectId}:${profileName}`);
    this.db
      .prepare(
        `INSERT INTO knowledge_provider_profiles
         (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
         VALUES (@id, @projectId, 'openai-compatible', @profileName, @configurationJson, @createdAt, @updatedAt)`,
      )
      .run({
        id,
        projectId,
        profileName,
        configurationJson: configurationJson(configuration),
        createdAt,
        updatedAt: createdAt,
      });
    return this.get(projectId, profileName)!;
  }

  public list(projectId: string): KnowledgeProviderProfile[] {
    return this.listWithDiagnostics(projectId).profiles;
  }

  public listWithDiagnostics(projectId: string): KnowledgeProviderProfileListResult {
    const rows = (
      this.db
        .prepare(
          `SELECT id, project_id, provider_kind, profile_name, configuration_json
           FROM knowledge_provider_profiles
           WHERE project_id = ?
           ORDER BY lower(profile_name) ASC, profile_name ASC`,
        )
        .all(requireNonEmptyString(projectId, 'project ID')) as ProviderProfileRow[]
    );
    const profiles: KnowledgeProviderProfile[] = [];
    const warnings: KnowledgeProviderDiagnostic[] = [];
    for (const row of rows) {
      const result = this.rowToProfileSafely(row);
      if (result.profile) {
        profiles.push(result.profile);
      }
      if (result.warning) {
        warnings.push(result.warning);
      }
    }
    return { profiles, warnings };
  }

  public get(projectId: string, profileName: string): KnowledgeProviderProfile | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, provider_kind, profile_name, configuration_json
         FROM knowledge_provider_profiles
         WHERE project_id = ? AND lower(profile_name) = lower(?)
         LIMIT 1`,
      )
      .get(requireNonEmptyString(projectId, 'project ID'), validateProfileName(profileName)) as ProviderProfileRow | undefined;
    return row ? this.rowToProfileSafely(row).profile : null;
  }

  public selectEnabledProfile(projectId: string, capability: KnowledgeProviderCapability): KnowledgeProviderProfile | null {
    return this.list(projectId).find((profile) => profile.enabled && profile.capabilities.includes(capability)) ?? null;
  }

  public setEnabled(projectId: string, profileName: string, enabled: boolean): KnowledgeProviderProfile {
    const current = this.requireProfile(projectId, profileName);
    const next: ProviderProfileConfiguration = {
      endpoint: current.endpoint,
      model: current.model,
      capabilities: current.capabilities,
      timeoutMs: current.timeoutMs,
      apiKeyEnv: current.apiKeyEnv,
      enabled,
    };
    this.db
      .prepare(
        `UPDATE knowledge_provider_profiles
         SET configuration_json = ?, updated_at = ?
         WHERE project_id = ? AND id = ?`,
      )
      .run(configurationJson(next), this.now(), current.projectId, current.id);
    return this.requireProfile(projectId, profileName);
  }

  public remove(projectId: string, profileName: string): boolean {
    const removed = this.db
      .prepare(
        `DELETE FROM knowledge_provider_profiles
         WHERE project_id = ? AND lower(profile_name) = lower(?)`,
      )
      .run(requireNonEmptyString(projectId, 'project ID'), validateProfileName(profileName));
    return removed.changes > 0;
  }

  public async test(projectId: string, profileName: string, environment: NodeJS.ProcessEnv): Promise<KnowledgeProviderTestResult> {
    if (!this.adapter) {
      throw new Error('Knowledge provider test adapter is not configured');
    }
    const profile = this.requireProfile(projectId, profileName);
    const resolved = resolveKnowledgeProviderApiKey(profile, environment, this.credentialPolicy);
    const adapterEnvironment: NodeJS.ProcessEnv =
      profile.apiKeyEnv !== null && resolved.apiKey !== null
        ? { [profile.apiKeyEnv]: resolved.apiKey }
        : {};
    try {
      const result = await this.adapter.testProfile({
        profile,
        environment: adapterEnvironment,
        apiKey: resolved.apiKey,
      });
      return {
        success: result.success,
        profile,
        warnings: [...resolved.warnings, ...(result.warnings ?? [])].map((warning) => ({
          code: sanitizeDiagnostic(warning.code),
          message: sanitizeDiagnostic(warning.message),
        })),
        diagnostics: (result.diagnostics ?? []).map((diagnostic) => sanitizeDiagnostic(diagnostic)),
      };
    } catch (error) {
      return {
        success: false,
        profile,
        warnings: resolved.warnings,
        diagnostics: [sanitizeDiagnostic(error instanceof Error ? error.message : String(error))],
      };
    }
  }

  private requireProfile(projectId: string, profileName: string): KnowledgeProviderProfile {
    const profile = this.get(projectId, profileName);
    if (!profile) {
      throw new Error(`Knowledge provider profile not found: ${profileName}`);
    }
    return profile;
  }

  private ensureProjectExists(projectId: string): void {
    const project = this.db.prepare('SELECT id FROM knowledge_projects WHERE id = ?').get(projectId) as { id: string } | undefined;
    if (!project) {
      throw new Error(`Knowledge project not found: ${projectId}`);
    }
  }

  private ensureUniqueProfileName(projectId: string, profileName: string): void {
    const existing = this.db
      .prepare(
        `SELECT id
         FROM knowledge_provider_profiles
         WHERE project_id = ? AND lower(profile_name) = lower(?)
         LIMIT 1`,
      )
      .get(projectId, profileName) as { id: string } | undefined;
    if (existing) {
      throw new Error(`Knowledge provider profile "${profileName}" already exists in project ${projectId}`);
    }
  }

  private rowToProfile(row: ProviderProfileRow): KnowledgeProviderProfile {
    if (row.provider_kind !== 'openai-compatible') {
      throw new Error(`Unsupported knowledge provider kind: ${row.provider_kind}`);
    }
    const configuration = parseConfiguration(row.configuration_json);
    return {
      id: row.id,
      projectId: row.project_id,
      providerKind: 'openai-compatible',
      profileName: row.profile_name,
      endpoint: configuration.endpoint,
      model: configuration.model,
      capabilities: [...configuration.capabilities],
      timeoutMs: configuration.timeoutMs,
      apiKeyEnv: configuration.apiKeyEnv,
      enabled: configuration.enabled,
    };
  }

  private rowToProfileSafely(row: ProviderProfileRow): ProfileCompatibilityResult {
    try {
      return {
        profile: this.rowToProfile(row),
        warning: null,
      };
    } catch (error) {
      return {
        profile: null,
        warning: {
          code: row.provider_kind === 'openai-compatible' ? 'provider_profile_invalid' : 'provider_profile_legacy_unsupported',
          message: sanitizeDiagnostic(
            `Skipped knowledge provider profile "${row.profile_name}" (${row.provider_kind}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        },
      };
    }
  }
}
