import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeAnalyticsSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeSearchAnalyticsService } from '../../src/knowledge/KnowledgeSearchAnalytics.js';
import { searchKnowledge } from '../../src/knowledge/KnowledgeSearch.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';

const PROJECT_A = 'analytics_project_a';
const PROJECT_B = 'analytics_project_b';
const NOW = '2026-09-29T00:00:00.000Z';

describe('knowledge search analytics', () => {
  let db: Database.Database;
  let settings: KnowledgeAnalyticsSettingsStore;
  let analytics: KnowledgeSearchAnalyticsService;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, `/tmp/${projectId}`, projectId, NOW, NOW);
    }
    settings = new KnowledgeAnalyticsSettingsStore(db, { now: () => NOW });
    analytics = new KnowledgeSearchAnalyticsService(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  it('stays disabled without creating a salt and does not persist exposure or feedback', () => {
    expect(settings.isEnabled(PROJECT_A)).toBe(false);
    expect(settings.getSalt(PROJECT_A)).toBeNull();

    expect(
      analytics.recordSearchExposure({
        projectId: PROJECT_A,
        query: 'private query',
        mode: 'sources',
        resultCount: 0,
        topResultAmbiguity: 'none',
        topResultHasCitation: false,
      }),
    ).toEqual({ recorded: false, reason: 'disabled' });
    expect(
      analytics.recordSearchFeedback({
        projectId: PROJECT_A,
        query: 'private query',
        mode: 'sources',
        resultId: '/private/source.md',
        resultKind: 'source',
        feedbackKind: 'accepted',
        rankPosition: 1,
        ambiguityState: 'clear',
        citationPresent: true,
      }),
    ).toEqual({ recorded: false, reason: 'disabled' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_query_analytics_daily').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_search_feedback').get()).toEqual({ count: 0 });
  });

  it('creates a random per-project salt on enable, keeps it on disable, and removes rows and salt on clear', () => {
    settings.enable(PROJECT_A);
    settings.enable(PROJECT_B);

    const saltA = settings.getSalt(PROJECT_A);
    const saltB = settings.getSalt(PROJECT_B);
    expect(saltA).toMatch(/^[0-9a-f]{64}$/);
    expect(saltB).toMatch(/^[0-9a-f]{64}$/);
    expect(saltA).not.toBe(saltB);
    expect(settings.isEnabled(PROJECT_A)).toBe(true);

    analytics.recordSearchExposure({
      projectId: PROJECT_A,
      query: 'private query',
      mode: 'sources',
      resultCount: 1,
      topResultAmbiguity: 'clear',
      topResultHasCitation: true,
    });
    analytics.recordSearchFeedback({
      projectId: PROJECT_A,
      query: 'private query',
      mode: 'sources',
      resultId: 'private-result-id',
      resultKind: 'source',
      feedbackKind: 'accepted',
      rankPosition: 1,
      ambiguityState: 'clear',
      citationPresent: true,
    });
    analytics.detectRankingRegression({
      projectId: PROJECT_A,
      runKind: 'manual_diagnostic',
      corpusVersion: 'local-v1',
      strategyLabel: 'lexical-v1',
      currentSummary: {
        questionCount: 1,
        top1PathHits: 1,
        top3PathHits: 1,
        spanCitationHits: 1,
        typedGraphEvidenceHits: 0,
        ambiguousTopResults: 0,
        zeroResultCount: 0,
      },
    });
    settings.disable(PROJECT_A);
    expect(settings.isEnabled(PROJECT_A)).toBe(false);
    expect(settings.getSalt(PROJECT_A)).toBe(saltA);
    expect(
      analytics.recordSearchExposure({
        projectId: PROJECT_A,
        query: 'another query',
        mode: 'sources',
        resultCount: 1,
        topResultAmbiguity: 'clear',
        topResultHasCitation: true,
      }),
    ).toEqual({ recorded: false, reason: 'disabled' });

    analytics.clearAnalytics(PROJECT_A);
    expect(settings.getSalt(PROJECT_A)).toBeNull();
    expect(settings.isEnabled(PROJECT_A)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_query_analytics_daily WHERE project_id = ?').get(PROJECT_A)).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_search_feedback WHERE project_id = ?').get(PROJECT_A)).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_search_regression_runs WHERE project_id = ?').get(PROJECT_A)).toEqual({
      count: 0,
    });
  });

  it('stores only opaque fingerprints, rolls daily counts up, and increments repeated feedback', () => {
    settings.enable(PROJECT_A);
    settings.enable(PROJECT_B);
    const query = 'confidential query value';
    const resultId = '/home/private/repository/secret.ts';

    expect(
      analytics.recordSearchExposure({
        projectId: PROJECT_A,
        query,
        mode: 'sources',
        resultCount: 3,
        topResultAmbiguity: 'ambiguous',
        topResultHasCitation: false,
      }),
    ).toEqual({ recorded: true });
    analytics.recordSearchExposure({
      projectId: PROJECT_A,
      query: 'no results query',
      mode: 'sources',
      resultCount: 0,
      topResultAmbiguity: 'none',
      topResultHasCitation: false,
    });

    const feedback = {
      projectId: PROJECT_A,
      query,
      mode: 'sources' as const,
      resultId,
      resultKind: 'source' as const,
      feedbackKind: 'accepted' as const,
      rankPosition: 300,
      ambiguityState: 'ambiguous' as const,
      citationPresent: false,
    };
    expect(analytics.recordSearchFeedback(feedback)).toEqual({ recorded: true });
    analytics.recordSearchFeedback(feedback);
    analytics.recordSearchFeedback({ ...feedback, projectId: PROJECT_B });

    const rows = db.prepare('SELECT * FROM knowledge_search_feedback ORDER BY project_id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      project_id: PROJECT_A,
      feedback_count: 2,
      rank_position: 100,
      first_day: '2026-09-29',
      last_day: '2026-09-29',
    });
    expect(rows[0].query_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].result_ref).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].query_fingerprint).not.toBe(rows[1].query_fingerprint);
    expect(rows[0].result_ref).not.toBe(rows[1].result_ref);

    const daily = db
      .prepare('SELECT * FROM knowledge_query_analytics_daily WHERE project_id = ?')
      .get(PROJECT_A) as Record<string, unknown>;
    expect(daily).toMatchObject({
      total_queries: 2,
      zero_result_queries: 1,
      ambiguous_top_results: 1,
      citationless_top_results: 1,
      accepted_result_count: 2,
      rejected_result_count: 0,
      total_result_count: 3,
    });
    const persisted = JSON.stringify({ rows, daily });
    expect(persisted).not.toContain(query);
    expect(persisted).not.toContain(resultId);
    expect(persisted).not.toContain('secret.ts');
    expect(db.prepare('PRAGMA table_info(knowledge_search_feedback)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'query' }), expect.objectContaining({ name: 'result_id' })]),
    );
  });

  it('returns invalid_input for unbounded values and clamps feedback rank to one through one hundred', () => {
    settings.enable(PROJECT_A);
    expect(
      analytics.recordSearchExposure({
        projectId: PROJECT_A,
        query: 'inconsistent exposure',
        mode: 'sources',
        resultCount: 0,
        topResultAmbiguity: 'clear',
        topResultHasCitation: true,
      }),
    ).toEqual({ recorded: false, reason: 'invalid_input' });
    expect(
      analytics.recordSearchExposure({
        projectId: PROJECT_A,
        query: 'q'.repeat(257),
        mode: 'sources',
        resultCount: 0,
        topResultAmbiguity: 'none',
        topResultHasCitation: false,
      }),
    ).toEqual({ recorded: false, reason: 'invalid_input' });

    analytics.recordSearchFeedback({
      projectId: PROJECT_A,
      query: 'valid query',
      mode: 'sources',
      resultId: 'result-id',
      resultKind: 'source',
      feedbackKind: 'rejected',
      rankPosition: 0,
      ambiguityState: 'clear',
      citationPresent: true,
    });
    expect(db.prepare('SELECT rank_position FROM knowledge_search_feedback').get()).toEqual({ rank_position: 1 });
    expect(
      analytics.recordSearchFeedback({
        projectId: PROJECT_A,
        query: 'valid query',
        mode: 'sources',
        resultId: 'another-result',
        resultKind: 'source',
        feedbackKind: 'rejected',
        rankPosition: 1.5,
        ambiguityState: 'clear',
        citationPresent: true,
      }),
    ).toEqual({ recorded: false, reason: 'invalid_input' });
  });

  it('persists count-only regression summaries and warns when gated metrics regress', () => {
    const baseline = analytics.detectRankingRegression({
      runKind: 'synthetic_fixture',
      corpusVersion: 'naas-v1',
      strategyLabel: 'lexical-v1',
      currentSummary: {
        questionCount: 10,
        top1PathHits: 8,
        top3PathHits: 9,
        spanCitationHits: 10,
        typedGraphEvidenceHits: 8,
        ambiguousTopResults: 1,
        zeroResultCount: 0,
        failures: [{ id: 'q-1', prompt: 'private prompt', expectedPaths: ['/private/a'], returnedPaths: ['/private/b'] }],
      },
    });
    expect(baseline).toMatchObject({ recorded: true, regressed: false, warnings: [] });
    if (!baseline.recorded) throw new Error('Expected synthetic baseline to be recorded');

    const current = analytics.detectRankingRegression({
      runKind: 'synthetic_fixture',
      corpusVersion: 'naas-v1',
      strategyLabel: 'lexical-v1',
      baselineRunId: baseline.runId,
      currentSummary: {
        questionCount: 10,
        top1PathHits: 7,
        top3PathHits: 7,
        spanCitationHits: 9,
        typedGraphEvidenceHits: 7,
        ambiguousTopResults: 3,
        zeroResultCount: 2,
        failures: [{ id: 'q-2', prompt: 'another private prompt', expectedPaths: ['/private/c'], returnedPaths: [] }],
      },
    });
    expect(current).toMatchObject({
      recorded: true,
      regressed: true,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'exact_span_citation_drop' }),
        expect.objectContaining({ code: 'top_three_hit_drop' }),
        expect.objectContaining({ code: 'ambiguity_rate_increase' }),
      ]),
    });
    const persisted = db.prepare('SELECT summary_json FROM knowledge_search_regression_runs ORDER BY created_at').all();
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain('q-2');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('/private/');

    settings.enable(PROJECT_A);
    const localBaseline = analytics.detectRankingRegression({
      projectId: PROJECT_A,
      runKind: 'approved_local_benchmark',
      corpusVersion: 'workspace-v1',
      strategyLabel: 'lexical-v1',
      currentSummary: {
        questionCount: 10,
        top1PathHits: 8,
        top3PathHits: 9,
        spanCitationHits: 10,
        typedGraphEvidenceHits: 8,
        ambiguousTopResults: 0,
        zeroResultCount: 0,
      },
    });
    if (!localBaseline.recorded) throw new Error('Expected approved local baseline to be recorded');
    const localCurrent = analytics.detectRankingRegression({
      projectId: PROJECT_A,
      runKind: 'approved_local_benchmark',
      corpusVersion: 'workspace-v1',
      strategyLabel: 'lexical-v1',
      baselineRunId: localBaseline.runId,
      currentSummary: {
        questionCount: 10,
        top1PathHits: 8,
        top3PathHits: 9,
        spanCitationHits: 10,
        typedGraphEvidenceHits: 8,
        ambiguousTopResults: 0,
        zeroResultCount: 2,
      },
    });
    expect(localCurrent).toMatchObject({
      recorded: true,
      regressed: true,
      warnings: [expect.objectContaining({ code: 'zero_result_rate_increase' })],
    });
  });

  it('gates user benchmark runs and rejects unsafe regression labels', () => {
    expect(
      analytics.detectRankingRegression({
        runKind: 'approved_local_benchmark',
        projectId: PROJECT_A,
        corpusVersion: 'local-benchmark',
        strategyLabel: 'lexical-v1',
        currentSummary: {
          questionCount: 1,
          top1PathHits: 1,
          top3PathHits: 1,
          spanCitationHits: 1,
          typedGraphEvidenceHits: 0,
          ambiguousTopResults: 0,
          zeroResultCount: 0,
        },
      }),
    ).toEqual({ recorded: false, reason: 'disabled', regressed: false, warnings: [] });
    expect(
      analytics.detectRankingRegression({
        runKind: 'synthetic_fixture',
        corpusVersion: '../private-workspace',
        strategyLabel: 'lexical-v1',
        currentSummary: {},
      }),
    ).toMatchObject({ recorded: false, reason: 'invalid_input' });
  });

  it('prunes only data older than ninety days when explicitly requested', () => {
    settings.enable(PROJECT_A);
    analytics.recordSearchExposure({
      projectId: PROJECT_A,
      query: 'recent query',
      mode: 'sources',
      resultCount: 0,
      topResultAmbiguity: 'none',
      topResultHasCitation: false,
    });
    db.prepare(
      `INSERT INTO knowledge_query_analytics_daily
       (id, project_id, day, search_mode, total_queries, zero_result_queries, ambiguous_top_results,
        citationless_top_results, accepted_result_count, rejected_result_count, total_result_count, created_at, updated_at)
       VALUES ('old-row', ?, '2026-06-01', 'sources', 1, 1, 0, 1, 0, 0, 0, ?, ?)`,
    ).run(PROJECT_A, NOW, NOW);
    db.prepare(
      `INSERT INTO knowledge_search_feedback
       (id, project_id, query_fingerprint, search_mode, result_kind, result_ref, feedback_kind, rank_position,
        ambiguity_state, citation_present, feedback_count, first_day, last_day)
       VALUES ('old-feedback', ?, 'opaque-query', 'sources', 'source', 'opaque-result', 'accepted', 1, 'clear', 1, 1, '2026-06-01', '2026-06-01')`,
    ).run(PROJECT_A);

    expect(analytics.pruneExpired()).toEqual({ feedbackRows: 1, dailyRows: 1 });
    expect(db.prepare('SELECT day FROM knowledge_query_analytics_daily').all()).toEqual([{ day: '2026-09-29' }]);
  });

  it('records exposures only when opted in and does not let feedback change search results', () => {
    const options = { db, projectId: PROJECT_A, mode: 'sources' as const };
    const disabledResults = searchKnowledge('no matching content', options);
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_query_analytics_daily').get()).toEqual({ count: 0 });

    settings.enable(PROJECT_A);
    const enabledResults = searchKnowledge('no matching content', options);
    expect(enabledResults).toEqual(disabledResults);
    expect(db.prepare('SELECT total_queries FROM knowledge_query_analytics_daily').get()).toEqual({ total_queries: 1 });

    analytics.recordSearchFeedback({
      projectId: PROJECT_A,
      query: 'no matching content',
      mode: 'sources',
      resultId: 'synthetic-result',
      resultKind: 'source',
      feedbackKind: 'accepted',
      rankPosition: 1,
      ambiguityState: 'clear',
      citationPresent: true,
    });
    expect(searchKnowledge('no matching content', options)).toEqual(disabledResults);
    db.exec('DROP TABLE knowledge_query_analytics_daily');
    const diagnostics: string[] = [];
    expect(
      searchKnowledge('no matching content', {
        ...options,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
      }),
    ).toEqual(disabledResults);
    expect(diagnostics).toContain('analytics_write_failed');
  });
});
