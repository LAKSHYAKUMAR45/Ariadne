import type Database from 'better-sqlite3';
import type { KnowledgeGenerationGateway } from './KnowledgeGenerationGateway.js';
import { KNOWLEDGE_HOST_SETTING_KEYS } from './KnowledgeHostSettingsStore.js';
import { providerFallbackWarning, type ProviderFallbackWarning } from './KnowledgeProviderFallback.js';
import { redactKnowledgeProviderPayload, type KnowledgeRedactionHook } from './KnowledgeProviders.js';
import { buildKnowledgeSearchContext, searchKnowledge, type KnowledgeSearchMode } from './KnowledgeSearch.js';
import {
  buildAmbiguitySection,
  collectCitations,
  findLeadAmbiguity,
  renderAnswerMarkdown,
  synthesizeDeterministically,
  type LeadAmbiguity,
} from './KnowledgeSynthesisDeterministic.js';
import { buildEvidencePack, type EvidencePack, type TextRedactor } from './KnowledgeSynthesisEvidence.js';
import {
  SYNTHESIS_SYSTEM_PROMPT,
  serializeProviderRequest,
  validateProviderResponse,
} from './KnowledgeSynthesisProvider.js';
import type {
  KnowledgeAnswerSynthesisService,
  KnowledgeSynthesisProviderRequest,
  KnowledgeSynthesisResult,
  SynthesizeKnowledgeAnswerInput,
} from './KnowledgeSynthesisTypes.js';

export interface KnowledgeAnswerSynthesizerOptions {
  db: Database.Database;
  /** Required only for `providerStrategy: 'if-available'`; without it the provider path reports `no_profile`. */
  gateway?: KnowledgeGenerationGateway;
  redact?: KnowledgeRedactionHook;
}

const DEFAULT_MODE: KnowledgeSearchMode = 'hybrid';

/**
 * Deterministic cross-file answer synthesis over `searchKnowledge(...)`, with an optional single-shot provider rewrite
 * that is accepted only when every claim stays grounded in the known evidence.
 */
export class KnowledgeAnswerSynthesizer implements KnowledgeAnswerSynthesisService {
  private readonly redactText: TextRedactor;

  public constructor(private readonly options: KnowledgeAnswerSynthesizerOptions) {
    this.redactText = (value) => redactKnowledgeProviderPayload(value, options.redact);
  }

  public async synthesize(input: SynthesizeKnowledgeAnswerInput): Promise<KnowledgeSynthesisResult> {
    const mode = input.mode ?? DEFAULT_MODE;
    const results = searchKnowledge(input.query, {
      db: this.options.db,
      projectId: input.projectId,
      mode,
      taskStore: input.taskStore,
      limit: input.limit,
      maxGraphExpansions: input.maxGraphExpansions,
    });
    const context = buildKnowledgeSearchContext(results, { tokenBudget: input.tokenBudget });
    const pack = buildEvidencePack(
      this.options.db,
      input.projectId,
      context.results,
      this.redactText,
      (context.truncated.results ?? 0) > 0,
    );
    const lead = findLeadAmbiguity(results);
    const deterministic = synthesizeDeterministically({ query: input.query, mode, pack, lead, redactText: this.redactText });
    if (input.providerStrategy !== 'if-available' || pack.evidence.length === 0) return deterministic;

    const outcome = await this.requestProvider(input, deterministic, pack);
    if (!outcome.ok) return { ...deterministic, warnings: [...deterministic.warnings, outcome.warning] };
    return this.assemble(input, deterministic, pack, lead, outcome.sections, outcome.snippetIds);
  }

  private async requestProvider(
    input: SynthesizeKnowledgeAnswerInput,
    deterministic: KnowledgeSynthesisResult,
    pack: EvidencePack,
  ): Promise<
    | { ok: true; sections: KnowledgeSynthesisResult['sections']; snippetIds: ReadonlySet<string> }
    | { ok: false; warning: ProviderFallbackWarning }
  > {
    const gateway = this.options.gateway;
    if (gateway === undefined) return { ok: false, warning: providerFallbackWarning('no_profile') };

    const snippets = new Map<string, string>();
    for (const group of pack.groups) {
      if (group.snippet !== null) snippets.set(group.entries[0].id, group.snippet);
    }
    const request: KnowledgeSynthesisProviderRequest = {
      query: this.redactText(input.query),
      mode: deterministic.mode,
      evidence: pack.evidence.map((entry) => ({
        id: entry.id,
        title: entry.title,
        snippet: snippets.get(entry.id) ?? null,
        citation: entry.citation === null ? null : withoutContext(entry.citation),
      })),
      deterministicDraft: deterministic.sections,
    };
    const serialized = serializeProviderRequest(request);
    if (serialized === null) return { ok: false, warning: providerFallbackWarning('provider_error') };

    const outcome = await gateway.requestJson({
      projectId: input.projectId,
      explicitProfileName: input.providerProfileName ?? null,
      settingKey: KNOWLEDGE_HOST_SETTING_KEYS.providerSynthesisProfile,
      systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
      prompt: serialized.prompt,
      signal: input.signal,
    });
    if (!outcome.ok) return outcome;
    const validated = validateProviderResponse(outcome.value, input.query, pack.evidence, this.redactText);
    if (!validated.ok) return { ok: false, warning: providerFallbackWarning('invalid_response') };
    return { ok: true, sections: validated.sections, snippetIds: new Set(serialized.withSnippets ? snippets.keys() : []) };
  }

  private assemble(
    input: SynthesizeKnowledgeAnswerInput,
    deterministic: KnowledgeSynthesisResult,
    pack: EvidencePack,
    lead: LeadAmbiguity | null,
    providerSections: KnowledgeSynthesisResult['sections'],
    snippetIds: ReadonlySet<string>,
  ): KnowledgeSynthesisResult {
    const ambiguity = buildAmbiguitySection(input.query, pack, lead, this.redactText);
    const sections = ambiguity === null ? providerSections : [...providerSections, ambiguity];
    const citations = collectCitations(sections);
    const snippetByEntry = new Map(pack.groups.flatMap((group) => (group.snippet === null ? [] : [[group.entries[0].id, group.snippet] as const])));
    return {
      ...deterministic,
      strategy: 'provider-assisted',
      sections,
      citations,
      answerMarkdown: renderAnswerMarkdown(input.query, sections, citations, this.redactText),
      evidence: pack.evidence.map((entry) =>
        snippetIds.has(entry.id)
          ? { ...entry, snippetPolicy: 'ephemeral_redacted', ephemeralSnippet: snippetByEntry.get(entry.id) ?? null }
          : entry,
      ),
    };
  }
}

function withoutContext<T extends { context?: unknown }>(citation: T): Omit<T, 'context'> {
  const { context: _context, ...rest } = citation;
  return rest;
}
