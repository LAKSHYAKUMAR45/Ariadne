import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import { KNOWLEDGE_HOST_SETTING_PREFIX } from './knowledgeSchema.js';

export const KNOWLEDGE_WORKER_CONCURRENCY_DEFAULT = 1;
export const KNOWLEDGE_WORKER_CONCURRENCY_MIN = 1;
export const KNOWLEDGE_WORKER_CONCURRENCY_MAX = 8;

export const KNOWLEDGE_HOST_SETTING_KEYS = {
  workerConcurrency: `${KNOWLEDGE_HOST_SETTING_PREFIX}worker.concurrency`,
  hybridSearchEnabled: `${KNOWLEDGE_HOST_SETTING_PREFIX}search.hybrid.enabled`,
  analyticsEnabled: `${KNOWLEDGE_HOST_SETTING_PREFIX}analytics.enabled`,
  analyticsSalt: `${KNOWLEDGE_HOST_SETTING_PREFIX}analytics.salt`,
  providerSynthesisProfile: `${KNOWLEDGE_HOST_SETTING_PREFIX}provider.synthesis_profile`,
  providerSummaryProfile: `${KNOWLEDGE_HOST_SETTING_PREFIX}provider.summary_profile`,
} as const;

export type KnowledgeHostSettingKey = (typeof KNOWLEDGE_HOST_SETTING_KEYS)[keyof typeof KNOWLEDGE_HOST_SETTING_KEYS];

const BOOLEAN_PATTERN = /^(?:true|false)$/;
const CONCURRENCY_PATTERN = /^[1-9]$/;
const SALT_PATTERN = /^[0-9a-f]{16,128}$/;
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function isConcurrencyValue(value: string): boolean {
  return CONCURRENCY_PATTERN.test(value) && Number(value) <= KNOWLEDGE_WORKER_CONCURRENCY_MAX;
}

const VALIDATORS: Readonly<Record<KnowledgeHostSettingKey, (value: string) => boolean>> = {
  [KNOWLEDGE_HOST_SETTING_KEYS.workerConcurrency]: isConcurrencyValue,
  [KNOWLEDGE_HOST_SETTING_KEYS.hybridSearchEnabled]: (value) => BOOLEAN_PATTERN.test(value),
  [KNOWLEDGE_HOST_SETTING_KEYS.analyticsEnabled]: (value) => BOOLEAN_PATTERN.test(value),
  [KNOWLEDGE_HOST_SETTING_KEYS.analyticsSalt]: (value) => SALT_PATTERN.test(value),
  [KNOWLEDGE_HOST_SETTING_KEYS.providerSynthesisProfile]: (value) => PROFILE_NAME_PATTERN.test(value),
  [KNOWLEDGE_HOST_SETTING_KEYS.providerSummaryProfile]: (value) => PROFILE_NAME_PATTERN.test(value),
};

export interface KnowledgeHostSettingsStoreOptions {
  now?: () => string;
}

/**
 * Typed access to the host-local `host.` namespace of `knowledge_settings`. Values never leave this host:
 * error messages name only registered keys and never include a value.
 */
export class KnowledgeHostSettingsStore {
  private readonly now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeHostSettingsStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public get(projectId: string, key: string): string | null {
    const scopedProjectId = requireProjectId(projectId);
    const registered = requireRegisteredKey(key);
    const row = this.db
      .prepare('SELECT setting_value FROM knowledge_settings WHERE project_id = ? AND setting_key = ?')
      .get(scopedProjectId, registered) as { setting_value: string } | undefined;
    if (!row) {
      return null;
    }
    if (!VALIDATORS[registered](row.setting_value)) {
      throw new Error(`Invalid stored value for host setting ${registered}`);
    }
    return row.setting_value;
  }

  public set(projectId: string, key: string, value: string): void {
    const scopedProjectId = requireProjectId(projectId);
    const registered = requireRegisteredKey(key);
    if (typeof value !== 'string' || !VALIDATORS[registered](value)) {
      throw new Error(`Invalid value for host setting ${registered}`);
    }
    const project = this.db.prepare('SELECT 1 AS present FROM knowledge_projects WHERE id = ?').get(scopedProjectId);
    if (!project) {
      throw new Error(`Knowledge project not found: ${scopedProjectId}`);
    }
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
         VALUES (@id, @projectId, @key, @value, @timestamp, @timestamp)
         ON CONFLICT (project_id, setting_key) DO UPDATE
         SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
      )
      .run({
        id: createKnowledgeId('host-setting', `${scopedProjectId}:${registered}`),
        projectId: scopedProjectId,
        key: registered,
        value,
        timestamp,
      });
  }

  public delete(projectId: string, key: string): boolean {
    const scopedProjectId = requireProjectId(projectId);
    const registered = requireRegisteredKey(key);
    return (
      this.db
        .prepare('DELETE FROM knowledge_settings WHERE project_id = ? AND setting_key = ?')
        .run(scopedProjectId, registered).changes > 0
    );
  }
}

export interface KnowledgeWorkerSettingsStoreLike {
  getConcurrency(projectId: string): number | null;
  setConcurrency(projectId: string, concurrency: number): void;
}

export class KnowledgeWorkerSettingsStore implements KnowledgeWorkerSettingsStoreLike {
  public constructor(private readonly settings: KnowledgeHostSettingsStore) {}

  public getConcurrency(projectId: string): number | null {
    const stored = this.settings.get(projectId, KNOWLEDGE_HOST_SETTING_KEYS.workerConcurrency);
    return stored === null ? null : Number(stored);
  }

  public setConcurrency(projectId: string, concurrency: number): void {
    this.settings.set(
      projectId,
      KNOWLEDGE_HOST_SETTING_KEYS.workerConcurrency,
      String(validateKnowledgeWorkerConcurrency(concurrency)),
    );
  }

  public clearConcurrency(projectId: string): boolean {
    return this.settings.delete(projectId, KNOWLEDGE_HOST_SETTING_KEYS.workerConcurrency);
  }
}

export type KnowledgeSemanticRetrievalOption = 'off' | 'if-available';

export interface KnowledgeSearchSettingsStoreLike {
  getHybridEnabled(projectId: string): boolean | null;
}

export class KnowledgeSearchSettingsStore implements KnowledgeSearchSettingsStoreLike {
  public constructor(private readonly settings: KnowledgeHostSettingsStore) {}

  public getHybridEnabled(projectId: string): boolean | null {
    const stored = this.settings.get(projectId, KNOWLEDGE_HOST_SETTING_KEYS.hybridSearchEnabled);
    return stored === null ? null : stored === 'true';
  }

  public setHybridEnabled(projectId: string, enabled: boolean): void {
    this.settings.set(projectId, KNOWLEDGE_HOST_SETTING_KEYS.hybridSearchEnabled, enabled ? 'true' : 'false');
  }

  public clearHybridEnabled(projectId: string): boolean {
    return this.settings.delete(projectId, KNOWLEDGE_HOST_SETTING_KEYS.hybridSearchEnabled);
  }
}

export interface ResolvedKnowledgeSemanticRetrieval {
  enabled: boolean;
  source: 'default' | 'host-setting' | 'option';
}

/** Precedence: the per-call option, then the host-local setting, then off. Never reads the setting when an option is given. */
export function resolveKnowledgeSemanticRetrieval(
  settings: KnowledgeSearchSettingsStoreLike,
  projectId: string,
  option?: KnowledgeSemanticRetrievalOption,
): ResolvedKnowledgeSemanticRetrieval {
  if (option !== undefined) {
    if (option !== 'off' && option !== 'if-available') {
      throw new Error("semanticRetrieval must be 'off' or 'if-available'");
    }
    return { enabled: option === 'if-available', source: 'option' };
  }
  const stored = settings.getHybridEnabled(projectId);
  return stored === null ? { enabled: false, source: 'default' } : { enabled: stored, source: 'host-setting' };
}

export interface ResolvedKnowledgeWorkerConcurrency {
  value: number;
  source: 'default' | 'host-setting' | 'override';
}

export function validateKnowledgeWorkerConcurrency(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < KNOWLEDGE_WORKER_CONCURRENCY_MIN ||
    value > KNOWLEDGE_WORKER_CONCURRENCY_MAX
  ) {
    throw new Error(
      `Knowledge worker concurrency must be an integer between ${KNOWLEDGE_WORKER_CONCURRENCY_MIN} and ${KNOWLEDGE_WORKER_CONCURRENCY_MAX}`,
    );
  }
  return value;
}

/** Precedence: explicit override, then the host-local setting, then the default. Never clamps. */
export function resolveKnowledgeWorkerConcurrency(
  settings: Pick<KnowledgeWorkerSettingsStoreLike, 'getConcurrency'>,
  projectId: string,
  override?: number,
): ResolvedKnowledgeWorkerConcurrency {
  if (override !== undefined) {
    return { value: validateKnowledgeWorkerConcurrency(override), source: 'override' };
  }
  const stored = settings.getConcurrency(projectId);
  if (stored !== null) {
    return { value: validateKnowledgeWorkerConcurrency(stored), source: 'host-setting' };
  }
  return { value: KNOWLEDGE_WORKER_CONCURRENCY_DEFAULT, source: 'default' };
}

function requireProjectId(projectId: string): string {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('Knowledge host setting project ID must not be empty');
  }
  return trimmed;
}

function requireRegisteredKey(key: string): KnowledgeHostSettingKey {
  if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(VALIDATORS, key)) {
    return key as KnowledgeHostSettingKey;
  }
  throw new Error('Unknown host setting key');
}
