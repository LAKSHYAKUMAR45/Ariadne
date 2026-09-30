import { createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { KnowledgeAnalyticsSettingsStore } from './KnowledgeHostSettingsStore.js';
import type { KnowledgeSearchMode, KnowledgeSearchResultKind } from './KnowledgeSearch.js';

export interface RecordAnalyticsResult {
  recorded: boolean;
  reason?: 'disabled' | 'invalid_input';
}

export interface RecordSearchExposureInput {
  projectId: string;
  query: string;
  mode: KnowledgeSearchMode;
  resultCount: number;
  topResultAmbiguity: 'clear' | 'ambiguous' | 'none';
  topResultHasCitation: boolean;
}

export type KnowledgeFeedbackKind = 'accepted' | 'rejected' | 'not_relevant' | 'ambiguous_but_useful';

export interface RecordSearchFeedbackInput {
  projectId: string;
  query: string;
  mode: KnowledgeSearchMode;
  resultId: string;
  resultKind: KnowledgeSearchResultKind;
  feedbackKind: KnowledgeFeedbackKind;
  rankPosition: number;
  ambiguityState: 'clear' | 'ambiguous' | 'none';
  citationPresent: boolean;
}

export type KnowledgeSearchRegressionRunKind = 'synthetic_fixture' | 'approved_local_benchmark' | 'manual_diagnostic';

export interface DetectRankingRegressionInput {
  projectId?: string;
  corpusVersion: string;
  strategyLabel: string;
  currentSummary: Record<string, unknown>;
  baselineRunId?: string;
  runKind?: KnowledgeSearchRegressionRunKind;
}

export type RankingRegressionWarningCode =
  | 'exact_span_citation_drop'
  | 'top_three_hit_drop'
  | 'ambiguity_rate_increase'
  | 'zero_result_rate_increase';

export interface RankingRegressionWarning {
  code: RankingRegressionWarningCode;
  message: string;
}

export type DetectRankingRegressionResult =
  | {
      recorded: true;
      runId: string;
      regressed: boolean;
      warnings: RankingRegressionWarning[];
    }
  | {
      recorded: false;
      reason: 'disabled' | 'invalid_input';
      regressed: false;
      warnings: [];
    };

export interface KnowledgeSearchAnalyticsOptions {
  now?: () => string;
}

export interface PrunedAnalyticsRows {
  feedbackRows: number;
  dailyRows: number;
}

interface SearchSummaryCounts {
  questionCount: number;
  top1PathHits: number;
  top3PathHits: number;
  spanCitationHits: number;
  typedGraphEvidenceHits: number;
  ambiguousTopResults: number;
  zeroResultCount: number;
  failingQuestionIds: string[];
}

interface StoredRegressionRun {
  id: string;
  project_id: string | null;
  corpus_version: string;
  strategy_label: string;
  run_kind: KnowledgeSearchRegressionRunKind;
  summary_json: string;
}

const MAX_QUERY_BYTES = 256;
const MAX_PROJECT_ID_LENGTH = 200;
const MAX_RESULT_ID_BYTES = 4096;
const MAX_RESULT_COUNT = 10_000;
const MAX_REGRESSION_QUESTIONS = 100_000;
const MAX_FAILURE_IDS = 1_000;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SEARCH_MODES = new Set<string>(['knowledge', 'sources', 'tasks', 'hybrid', 'read-sources-only']);
const RESULT_KINDS = new Set<KnowledgeSearchResultKind>(['page', 'source', 'task']);
const FEEDBACK_KINDS = new Set<KnowledgeFeedbackKind>(['accepted', 'rejected', 'not_relevant', 'ambiguous_but_useful']);
const RUN_KINDS = new Set<KnowledgeSearchRegressionRunKind>([
  'synthetic_fixture',
  'approved_local_benchmark',
  'manual_diagnostic',
]);

function projectIdIsValid(projectId: unknown): projectId is string {
  return typeof projectId === 'string' && projectId.trim().length > 0 && projectId.trim().length <= MAX_PROJECT_ID_LENGTH;
}

function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function validSearchInput(projectId: unknown, query: unknown, mode: unknown): query is string {
  return (
    projectIdIsValid(projectId) &&
    typeof query === 'string' &&
    query.trim().length > 0 &&
    Buffer.byteLength(query, 'utf8') <= MAX_QUERY_BYTES &&
    typeof mode === 'string' &&
    SEARCH_MODES.has(mode)
  );
}

function isCount(value: unknown, max = MAX_REGRESSION_QUESTIONS): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function readSummary(summary: Record<string, unknown>): SearchSummaryCounts | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;

  const countKeys = [
    'questionCount',
    'top1PathHits',
    'top3PathHits',
    'spanCitationHits',
    'typedGraphEvidenceHits',
    'ambiguousTopResults',
    'zeroResultCount',
  ] as const;
  if (!countKeys.every((key) => isCount(summary[key]))) return null;

  const [questionCount, top1PathHits, top3PathHits, spanCitationHits, typedGraphEvidenceHits, ambiguousTopResults, zeroResultCount] =
    countKeys.map((key) => summary[key] as number);
  if (
    questionCount < 1 ||
    top1PathHits > questionCount ||
    top3PathHits > questionCount ||
    spanCitationHits > questionCount ||
    typedGraphEvidenceHits > questionCount ||
    ambiguousTopResults > questionCount ||
    zeroResultCount > questionCount
  ) {
    return null;
  }

  const failures = summary.failures;
  if (failures !== undefined && (!Array.isArray(failures) || failures.length > MAX_FAILURE_IDS)) return null;
  const failingQuestionIds: string[] = [];
  for (const failure of failures ?? []) {
    if (!failure || typeof failure !== 'object' || !('id' in failure)) return null;
    const id = failure.id;
    if (typeof id !== 'string' || !SAFE_QUESTION_ID_PATTERN.test(id)) return null;
    failingQuestionIds.push(id);
  }

  return {
    questionCount,
    top1PathHits,
    top3PathHits,
    spanCitationHits,
    typedGraphEvidenceHits,
    ambiguousTopResults,
    zeroResultCount,
    failingQuestionIds: [...new Set(failingQuestionIds)].sort(),
  };
}

function serializeSummary(summary: SearchSummaryCounts): string {
  return JSON.stringify(summary);
}

function countsFromStoredRun(run: StoredRegressionRun): SearchSummaryCounts {
  const parsed: unknown = JSON.parse(run.summary_json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored knowledge search regression summary is invalid');
  }
  const summary = readSummary(parsed as Record<string, unknown>);
  if (!summary) throw new Error('Stored knowledge search regression summary is invalid');
  return summary;
}

function rate(count: number, total: number): number {
  return count / total;
}

function compareSummaries(
  current: SearchSummaryCounts,
  baseline: SearchSummaryCounts,
  runKind: KnowledgeSearchRegressionRunKind,
): RankingRegressionWarning[] {
  const warnings: RankingRegressionWarning[] = [];
  if (rate(current.spanCitationHits, current.questionCount) < rate(baseline.spanCitationHits, baseline.questionCount)) {
    warnings.push({
      code: 'exact_span_citation_drop',
      message: 'Exact-span citation hit rate decreased from the selected baseline.',
    });
  }
  if (baseline.top3PathHits - current.top3PathHits > 1) {
    warnings.push({
      code: 'top_three_hit_drop',
      message: 'Top-three path hits decreased by more than one question from the selected baseline.',
    });
  }
  if (rate(current.ambiguousTopResults, current.questionCount) - rate(baseline.ambiguousTopResults, baseline.questionCount) > 0.1) {
    warnings.push({
      code: 'ambiguity_rate_increase',
      message: 'Ambiguous top-result rate increased by more than ten percentage points from the selected baseline.',
    });
  }
  if (
    runKind === 'approved_local_benchmark' &&
    rate(current.zeroResultCount, current.questionCount) - rate(baseline.zeroResultCount, baseline.questionCount) > 0.1
  ) {
    warnings.push({
      code: 'zero_result_rate_increase',
      message: 'Zero-result rate increased by more than ten percentage points from the selected baseline.',
    });
  }
  return warnings;
}

export class KnowledgeSearchAnalyticsService {
  private readonly now: () => string;
  private readonly settings: KnowledgeAnalyticsSettingsStore;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeSearchAnalyticsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.settings = new KnowledgeAnalyticsSettingsStore(db);
  }

  public recordSearchExposure(input: RecordSearchExposureInput): RecordAnalyticsResult {
    if (
      !validSearchInput(input?.projectId, input?.query, input?.mode) ||
      !isCount(input?.resultCount, MAX_RESULT_COUNT) ||
      !['clear', 'ambiguous', 'none'].includes(input.topResultAmbiguity) ||
      (input.resultCount === 0) !== (input.topResultAmbiguity === 'none') ||
      (input.resultCount === 0 && input.topResultHasCitation) ||
      typeof input.topResultHasCitation !== 'boolean'
    ) {
      return { recorded: false, reason: 'invalid_input' };
    }
    if (!this.projectExists(input.projectId)) return { recorded: false, reason: 'invalid_input' };
    if (!this.settings.isEnabled(input.projectId)) return { recorded: false, reason: 'disabled' };

    const timestamp = this.now();
    const day = timestamp.slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO knowledge_query_analytics_daily
         (id, project_id, day, search_mode, total_queries, zero_result_queries, ambiguous_top_results,
          citationless_top_results, accepted_result_count, rejected_result_count, total_result_count, created_at, updated_at)
         VALUES (@id, @projectId, @day, @mode, 1, @zeroResults, @ambiguous, @citationless, 0, 0, @resultCount, @timestamp, @timestamp)
         ON CONFLICT (project_id, day, search_mode) DO UPDATE SET
           total_queries = total_queries + 1,
           zero_result_queries = zero_result_queries + excluded.zero_result_queries,
           ambiguous_top_results = ambiguous_top_results + excluded.ambiguous_top_results,
           citationless_top_results = citationless_top_results + excluded.citationless_top_results,
           total_result_count = total_result_count + excluded.total_result_count,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: randomUUID(),
        projectId: input.projectId.trim(),
        day,
        mode: input.mode,
        zeroResults: input.resultCount === 0 ? 1 : 0,
        ambiguous: input.topResultAmbiguity === 'ambiguous' ? 1 : 0,
        citationless: input.resultCount > 0 && !input.topResultHasCitation ? 1 : 0,
        resultCount: input.resultCount,
        timestamp,
      });
    return { recorded: true };
  }

  public recordSearchFeedback(input: RecordSearchFeedbackInput): RecordAnalyticsResult {
    if (
      !validSearchInput(input?.projectId, input?.query, input?.mode) ||
      typeof input?.resultId !== 'string' ||
      input.resultId.trim().length === 0 ||
      Buffer.byteLength(input.resultId, 'utf8') > MAX_RESULT_ID_BYTES ||
      !RESULT_KINDS.has(input.resultKind) ||
      !FEEDBACK_KINDS.has(input.feedbackKind) ||
      typeof input.rankPosition !== 'number' ||
      !Number.isSafeInteger(input.rankPosition) ||
      !['clear', 'ambiguous', 'none'].includes(input.ambiguityState) ||
      typeof input.citationPresent !== 'boolean'
    ) {
      return { recorded: false, reason: 'invalid_input' };
    }
    if (!this.projectExists(input.projectId)) return { recorded: false, reason: 'invalid_input' };
    if (!this.settings.isEnabled(input.projectId)) return { recorded: false, reason: 'disabled' };

    const salt = this.settings.getSalt(input.projectId);
    if (salt === null) throw new Error('Knowledge analytics is enabled without its required project salt');

    const timestamp = this.now();
    const day = timestamp.slice(0, 10);
    const queryFingerprint = fingerprint(salt, 'query', normalizeQuery(input.query));
    const resultRef = fingerprint(salt, 'result', input.resultId);
    const rankPosition = Math.max(1, Math.min(100, Math.trunc(input.rankPosition)));
    const acceptedCount = input.feedbackKind === 'accepted' || input.feedbackKind === 'ambiguous_but_useful' ? 1 : 0;
    const rejectedCount = input.feedbackKind === 'rejected' || input.feedbackKind === 'not_relevant' ? 1 : 0;
    const recordFeedback = this.db.prepare(
      `INSERT INTO knowledge_search_feedback
       (id, project_id, query_fingerprint, search_mode, result_kind, result_ref, feedback_kind, rank_position,
        ambiguity_state, citation_present, feedback_count, first_day, last_day)
       VALUES (@id, @projectId, @queryFingerprint, @mode, @resultKind, @resultRef, @feedbackKind,
        @rankPosition, @ambiguityState, @citationPresent, 1, @day, @day)
       ON CONFLICT (project_id, query_fingerprint, search_mode, result_ref, feedback_kind) DO UPDATE SET
         feedback_count = feedback_count + 1,
         last_day = excluded.last_day`,
    );
    const updateDaily = this.db.prepare(
      `INSERT INTO knowledge_query_analytics_daily
       (id, project_id, day, search_mode, total_queries, zero_result_queries, ambiguous_top_results,
        citationless_top_results, accepted_result_count, rejected_result_count, total_result_count, created_at, updated_at)
       VALUES (@id, @projectId, @day, @mode, 0, 0, 0, 0, @acceptedCount, @rejectedCount, 0, @timestamp, @timestamp)
       ON CONFLICT (project_id, day, search_mode) DO UPDATE SET
         accepted_result_count = accepted_result_count + excluded.accepted_result_count,
         rejected_result_count = rejected_result_count + excluded.rejected_result_count,
         updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      recordFeedback.run({
        id: randomUUID(),
        projectId: input.projectId.trim(),
        queryFingerprint,
        mode: input.mode,
        resultKind: input.resultKind,
        resultRef,
        feedbackKind: input.feedbackKind,
        rankPosition,
        ambiguityState: input.ambiguityState,
        citationPresent: input.citationPresent ? 1 : 0,
        day,
      });
      updateDaily.run({
        id: randomUUID(),
        projectId: input.projectId.trim(),
        day,
        mode: input.mode,
        acceptedCount,
        rejectedCount,
        timestamp,
      });
    })();
    return { recorded: true };
  }

  public detectRankingRegression(input: DetectRankingRegressionInput): DetectRankingRegressionResult {
    const runKind = input?.runKind ?? 'synthetic_fixture';
    const summary = input?.currentSummary && readSummary(input.currentSummary);
    if (
      !input ||
      typeof input.corpusVersion !== 'string' ||
      !SAFE_LABEL_PATTERN.test(input.corpusVersion) ||
      typeof input.strategyLabel !== 'string' ||
      !SAFE_LABEL_PATTERN.test(input.strategyLabel) ||
      !RUN_KINDS.has(runKind) ||
      !summary ||
      (input.projectId !== undefined && !projectIdIsValid(input.projectId)) ||
      (input.baselineRunId !== undefined &&
        (typeof input.baselineRunId !== 'string' || input.baselineRunId.length !== 36)) ||
      (runKind !== 'synthetic_fixture' && !projectIdIsValid(input.projectId))
    ) {
      return { recorded: false, reason: 'invalid_input', regressed: false, warnings: [] };
    }
    const projectId = input.projectId?.trim() ?? null;
    if (projectId !== null && !this.projectExists(projectId)) {
      return { recorded: false, reason: 'invalid_input', regressed: false, warnings: [] };
    }
    if (runKind !== 'synthetic_fixture' && projectId !== null && !this.settings.isEnabled(projectId)) {
      return { recorded: false, reason: 'disabled', regressed: false, warnings: [] };
    }

    const baseline = this.readBaseline(input, runKind, projectId);
    if (input.baselineRunId && !baseline) {
      return { recorded: false, reason: 'invalid_input', regressed: false, warnings: [] };
    }
    const warnings = baseline ? compareSummaries(summary, countsFromStoredRun(baseline), runKind) : [];
    const runId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO knowledge_search_regression_runs
         (id, project_id, corpus_version, run_kind, strategy_label, summary_json, baseline_run_id, regressed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        projectId,
        input.corpusVersion,
        runKind,
        input.strategyLabel,
        serializeSummary(summary),
        baseline?.id ?? null,
        warnings.length > 0 ? 1 : 0,
        this.now(),
      );
    return { recorded: true, runId, regressed: warnings.length > 0, warnings };
  }

  public pruneExpired(): PrunedAnalyticsRows {
    const cutoff = new Date(Date.parse(this.now()) - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return this.db.transaction(() => ({
      feedbackRows: this.db.prepare('DELETE FROM knowledge_search_feedback WHERE last_day < ?').run(cutoff).changes,
      dailyRows: this.db.prepare('DELETE FROM knowledge_query_analytics_daily WHERE day < ?').run(cutoff).changes,
    }))();
  }

  public clearAnalytics(projectId: string): void {
    this.settings.clear(projectId);
  }

  private projectExists(projectId: string): boolean {
    return (
      this.db.prepare('SELECT 1 AS present FROM knowledge_projects WHERE id = ?').get(projectId.trim()) !== undefined
    );
  }

  private readBaseline(
    input: DetectRankingRegressionInput,
    runKind: KnowledgeSearchRegressionRunKind,
    projectId: string | null,
  ): StoredRegressionRun | null {
    const select = this.db.prepare(
      `SELECT id, project_id, corpus_version, strategy_label, run_kind, summary_json
       FROM knowledge_search_regression_runs
       WHERE id = ?
         AND project_id IS ?
         AND corpus_version = ?
         AND strategy_label = ?
         AND run_kind = ?`,
    );
    if (input.baselineRunId) {
      return (
        (select.get(input.baselineRunId, projectId, input.corpusVersion, input.strategyLabel, runKind) as
          | StoredRegressionRun
          | undefined) ?? null
      );
    }
    return (
      (this.db
        .prepare(
          `SELECT id, project_id, corpus_version, strategy_label, run_kind, summary_json
           FROM knowledge_search_regression_runs
           WHERE project_id IS ?
             AND corpus_version = ?
             AND strategy_label = ?
             AND run_kind = ?
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(projectId, input.corpusVersion, input.strategyLabel, runKind) as StoredRegressionRun | undefined) ?? null
    );
  }
}

function fingerprint(salt: string, kind: 'query' | 'result', value: string): string {
  return createHmac('sha256', salt).update(`${kind}\0${value}`, 'utf8').digest('hex').slice(0, 32);
}
