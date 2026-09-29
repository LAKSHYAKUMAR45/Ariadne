import type Database from 'better-sqlite3';
import { toPersistedCitation } from './KnowledgeCitationContext.js';
import type { KnowledgeGenerationGateway } from './KnowledgeGenerationGateway.js';
import { KNOWLEDGE_HOST_SETTING_KEYS } from './KnowledgeHostSettingsStore.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import { providerFallbackWarning, type ProviderFallbackWarning } from './KnowledgeProviderFallback.js';
import { redactKnowledgeProviderPayload, type KnowledgeRedactionHook } from './KnowledgeProviders.js';
import {
  buildPageVersionDraft,
  buildProjectDraft,
  buildSourceVersionDraft,
  KnowledgeSummaryScopeNotFoundError,
  type SummaryDraft,
} from './KnowledgeSemanticSummaryEvidence.js';
import {
  parseBoundedSummaryJson,
  parseSemanticSummaryPayload,
  parseSemanticSummaryWarnings,
} from './KnowledgeSemanticSummaryPersistence.js';
import {
  SUMMARY_SYSTEM_PROMPT,
  serializeSummaryRequest,
  validateSummaryResponse,
  type ValidatedProviderSummary,
} from './KnowledgeSemanticSummaryProvider.js';
import {
  KNOWLEDGE_SUMMARY_SCOPE_KINDS,
  KNOWLEDGE_SUMMARY_STRATEGIES,
  type BuildKnowledgeSemanticSummaryInput,
  type KnowledgeSemanticSummaryRecord,
  type KnowledgeSemanticSummaryService,
  type KnowledgeSemanticSummaryWarning,
  type KnowledgeSummaryScopeKind,
  type KnowledgeSummaryStrategy,
  type PersistedSemanticSummaryPayload,
} from './KnowledgeSemanticSummaryTypes.js';
import type { TextRedactor } from './KnowledgeSynthesisEvidence.js';

export interface KnowledgeSemanticSummaryStoreOptions {
  db: Database.Database;
  /** Required only for `providerMode: 'if-available'`; without it the provider path reports `no_profile`. */
  gateway?: KnowledgeGenerationGateway;
  redact?: KnowledgeRedactionHook;
  now?: () => string;
}

interface SummaryRow {
  id: string;
  project_id: string;
  scope_kind: string;
  scope_id: string;
  strategy: string;
  provider_profile_name: string | null;
  summary_json: string;
  warnings_json: string;
  created_at: string;
  updated_at: string;
}

type ProviderOutcome =
  | { ok: true; value: ValidatedProviderSummary; profileName: string }
  | { ok: false; warning: ProviderFallbackWarning };

/**
 * Deterministic source/page/project summaries with optional single-shot provider refinement. Only the accepted, grounded
 * result and bounded warnings are stored; prompts, responses, evidence text, and provider configuration never are.
 */
export class KnowledgeSemanticSummaryStore implements KnowledgeSemanticSummaryService {
  private readonly redactText: TextRedactor;
  private readonly now: () => string;

  public constructor(private readonly options: KnowledgeSemanticSummaryStoreOptions) {
    this.redactText = (value) => redactKnowledgeProviderPayload(value, options.redact);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async build(input: BuildKnowledgeSemanticSummaryInput): Promise<KnowledgeSemanticSummaryRecord> {
    if (!this.tableExists()) throw new Error('Knowledge semantic summaries are unavailable until the database is migrated');
    const draft = this.buildDraft(input);
    if (input.providerMode !== 'if-available') return this.persist(input, draft, 'deterministic', null, []);

    const outcome = await this.refine(input, draft);
    if (!outcome.ok) return this.persist(input, draft, 'fallback_warning', null, [outcome.warning]);
    const refined: SummaryDraft = {
      title: outcome.value.title,
      summary: outcome.value.summary,
      bullets: outcome.value.bullets,
      bulletEvidenceIds: outcome.value.bulletEvidenceIds,
      evidence: draft.evidence.filter((entry) => outcome.value.bulletEvidenceIds.some((ids) => ids.includes(entry.id))),
    };
    return this.persist(input, refined, 'provider_refined', outcome.profileName, []);
  }

  public getLatest(
    projectId: string,
    scopeKind: KnowledgeSummaryScopeKind,
    scopeId: string,
  ): KnowledgeSemanticSummaryRecord | null {
    if (!this.tableExists()) return null;
    const row = this.options.db
      .prepare(
        `SELECT * FROM knowledge_semantic_summaries
         WHERE project_id = ? AND scope_kind = ? AND scope_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(projectId, scopeKind, scopeId) as SummaryRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  private tableExists(): boolean {
    return (
      this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_semantic_summaries'").get() !==
      undefined
    );
  }

  private buildDraft(input: BuildKnowledgeSemanticSummaryInput): SummaryDraft {
    const { db } = this.options;
    if (input.scopeKind === 'source_version') return buildSourceVersionDraft(db, input.projectId, input.scopeId, this.redactText);
    if (input.scopeKind === 'page_version') return buildPageVersionDraft(db, input.projectId, input.scopeId, this.redactText);
    if (input.scopeKind === 'project' && input.scopeId === input.projectId) return buildProjectDraft(db, input.projectId, this.redactText);
    throw new KnowledgeSummaryScopeNotFoundError(input.scopeKind);
  }

  private async refine(input: BuildKnowledgeSemanticSummaryInput, draft: SummaryDraft): Promise<ProviderOutcome> {
    const gateway = this.options.gateway;
    if (gateway === undefined) return { ok: false, warning: providerFallbackWarning('no_profile') };
    const prompt = serializeSummaryRequest(input.scopeKind, draft);
    if (prompt === null) return { ok: false, warning: providerFallbackWarning('provider_error') };
    const outcome = await gateway.requestJson({
      projectId: input.projectId,
      explicitProfileName: input.providerProfileName ?? null,
      settingKey: KNOWLEDGE_HOST_SETTING_KEYS.providerSummaryProfile,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      prompt,
      signal: input.signal,
    });
    if (!outcome.ok) return outcome;
    const validated = validateSummaryResponse(outcome.value, draft.evidence, this.redactText);
    if (!validated.ok) return { ok: false, warning: providerFallbackWarning('invalid_response') };
    return { ok: true, value: validated.value, profileName: outcome.profileName };
  }

  private persist(
    input: BuildKnowledgeSemanticSummaryInput,
    draft: SummaryDraft,
    strategy: KnowledgeSummaryStrategy,
    profileName: string | null,
    warnings: KnowledgeSemanticSummaryWarning[],
  ): KnowledgeSemanticSummaryRecord {
    const payload: PersistedSemanticSummaryPayload = {
      title: draft.title,
      summary: draft.summary,
      bullets: draft.bullets,
      evidence: draft.evidence.map((entry) => ({
        evidenceId: entry.id,
        citation: entry.citation === null ? null : toPersistedCitation(entry.citation),
      })),
      bulletEvidenceIds: draft.bulletEvidenceIds,
    };
    const validated = parseSemanticSummaryPayload(payload);
    const createdAt = this.nextCreatedAt(input);
    const row: SummaryRow = {
      id: createKnowledgeId('summary'),
      project_id: input.projectId,
      scope_kind: input.scopeKind,
      scope_id: input.scopeId,
      strategy,
      provider_profile_name: profileName,
      summary_json: JSON.stringify(validated),
      warnings_json: JSON.stringify(parseSemanticSummaryWarnings(warnings)),
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.options.db
      .prepare(
        `INSERT INTO knowledge_semantic_summaries
         (id, project_id, scope_kind, scope_id, strategy, provider_profile_name, summary_json, warnings_json, created_at, updated_at)
         VALUES (@id, @project_id, @scope_kind, @scope_id, @strategy, @provider_profile_name, @summary_json, @warnings_json, @created_at, @updated_at)`,
      )
      .run(row);
    return rowToRecord(row);
  }

  /** `created_at` is part of the uniqueness key, so a repeated build in the same instant is moved just past the latest row. */
  private nextCreatedAt(input: BuildKnowledgeSemanticSummaryInput): string {
    const requested = this.now();
    const latest = this.options.db
      .prepare(
        `SELECT MAX(created_at) AS created_at FROM knowledge_semantic_summaries
         WHERE project_id = ? AND scope_kind = ? AND scope_id = ?`,
      )
      .get(input.projectId, input.scopeKind, input.scopeId) as { created_at: string | null };
    if (latest.created_at === null || requested > latest.created_at) return requested;
    return new Date(Date.parse(latest.created_at) + 1).toISOString();
  }
}

function rowToRecord(row: SummaryRow): KnowledgeSemanticSummaryRecord {
  if (!KNOWLEDGE_SUMMARY_SCOPE_KINDS.includes(row.scope_kind as KnowledgeSummaryScopeKind)) {
    throw new Error('Knowledge semantic summary scope kind is not supported');
  }
  if (!KNOWLEDGE_SUMMARY_STRATEGIES.includes(row.strategy as KnowledgeSummaryStrategy)) {
    throw new Error('Knowledge semantic summary strategy is not supported');
  }
  const payload = parseSemanticSummaryPayload(parseBoundedSummaryJson(row.summary_json, 'summary_json'));
  return {
    id: row.id,
    projectId: row.project_id,
    scopeKind: row.scope_kind as KnowledgeSummaryScopeKind,
    scopeId: row.scope_id,
    strategy: row.strategy as KnowledgeSummaryStrategy,
    title: payload.title,
    summary: payload.summary,
    bullets: payload.bullets,
    evidence: payload.evidence,
    bulletEvidenceIds: payload.bulletEvidenceIds,
    providerProfileName: row.provider_profile_name,
    warnings: parseSemanticSummaryWarnings(parseBoundedSummaryJson(row.warnings_json, 'warnings_json')),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
