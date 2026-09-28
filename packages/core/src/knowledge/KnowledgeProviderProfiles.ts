import net from 'node:net';
import type Database from 'better-sqlite3';
import { redact } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgeProviderCapability } from './KnowledgeProviders.js';

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_LABEL_PATTERN = /^[A-Za-z0-9-]{1,63}$/;
const SUPPORTED_PROFILE_CAPABILITIES = new Set<KnowledgeProviderCapability>(['analysis', 'generation']);
const MAX_MODEL_LENGTH = 256;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_LENGTH = 280;
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

export interface KnowledgeProviderProfileStoreOptions {
  now?: () => string;
  adapter?: KnowledgeProviderTestAdapter;
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = canonicalizeHostname(hostname);
  return normalized === 'localhost' || normalized.endsWith('.localhost') || net.isIP(normalized) > 0 && (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  );
}

function isPrivateOrReservedIp(hostname: string): boolean {
  const normalized = canonicalizeHostname(hostname);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const octets = normalized.split('.').map((segment) => Number(segment));
    const [first = 0, second = 0] = octets;
    const [third = 0] = octets.slice(2);
    if (first === 0 || first === 10 || first === 127) {
      return true;
    }
    if (first === 169 && second === 254) {
      return true;
    }
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
    if (first === 192 && second === 168) {
      return true;
    }
    if (first === 100 && second >= 64 && second <= 127) {
      return true;
    }
    if (first === 192 && second === 0 && third <= 2) {
      return true;
    }
    if (first === 192 && second === 0 && third === 0) {
      return true;
    }
    if (first === 198 && (second === 18 || second === 19)) {
      return true;
    }
    if (first === 198 && second === 51 && third === 100) {
      return true;
    }
    if (first === 203 && second === 0 && third === 113) {
      return true;
    }
    return first >= 224;
  }
  if (ipVersion === 6) {
    const lowered = normalized.toLowerCase();
    return (
      lowered === '::' ||
      lowered === '::1' ||
      lowered.startsWith('fc') ||
      lowered.startsWith('fd') ||
      lowered.startsWith('fe8') ||
      lowered.startsWith('fe9') ||
      lowered.startsWith('fea') ||
      lowered.startsWith('feb') ||
      lowered.startsWith('2001:db8')
    );
  }
  return false;
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
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error('Knowledge provider http endpoints are limited to loopback or localhost addresses');
  }
  const normalizedHostname = canonicalizeHostname(parsed.hostname);
  if (
    parsed.protocol === 'https:' &&
    (normalizedHostname === 'localhost' ||
      normalizedHostname.endsWith('.localhost') ||
      isPrivateOrReservedIp(normalizedHostname))
  ) {
    throw new Error('Knowledge provider https endpoints must not target localhost or private IP ranges');
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
  return {
    endpoint: normalizeOpenAICompatibleEndpoint(String(candidate.endpoint)),
    model: validateModel(String(candidate.model)),
    capabilities: validateCapabilities(candidate.capabilities as KnowledgeProviderCapability[]),
    timeoutMs: validateTimeout(Number(candidate.timeoutMs)),
    apiKeyEnv: validateEnvironmentVariableName(candidate.apiKeyEnv as string | null | undefined),
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
): ResolveKnowledgeProviderApiKeyResult {
  if (profile.apiKeyEnv === null) {
    return { apiKey: null, warnings: [] };
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

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeProviderProfileStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.adapter = options.adapter;
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
    return (
      this.db
        .prepare(
          `SELECT id, project_id, provider_kind, profile_name, configuration_json
           FROM knowledge_provider_profiles
           WHERE project_id = ?
           ORDER BY lower(profile_name) ASC, profile_name ASC`,
        )
        .all(requireNonEmptyString(projectId, 'project ID')) as ProviderProfileRow[]
    ).map((row) => this.rowToProfile(row));
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
    return row ? this.rowToProfile(row) : null;
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
    const resolved = resolveKnowledgeProviderApiKey(profile, environment);
    try {
      const result = await this.adapter.testProfile({
        profile,
        environment,
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
}
