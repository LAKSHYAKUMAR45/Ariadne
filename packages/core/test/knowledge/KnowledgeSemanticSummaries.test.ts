import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { KNOWLEDGE_HOST_SETTING_KEYS } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeSemanticSummaryStore } from '../../src/knowledge/KnowledgeSemanticSummaries.js';
import type { ProviderFallbackReason } from '../../src/knowledge/KnowledgeProviderFallback.js';
import type {
  BuildKnowledgeSemanticSummaryInput,
  SemanticSummaryProviderRequest,
} from '../../src/knowledge/KnowledgeSemanticSummaryTypes.js';
import { FIXTURE_PROJECT_ID, indexFixtureSource, seedAuthCorpus, seedPageOnly } from './knowledgeSynthesisFixtures.js';
import {
  ProviderFixture,
  completionResponse,
  createProviderHarness,
  openHarnessDatabase,
  type ProviderHarness,
} from './knowledgeProviderTestHarness.js';

function requestOf(fixture: ProviderFixture, index = fixture.requests.length - 1): SemanticSummaryProviderRequest {
  const body = JSON.parse(fixture.requests[index].body) as { messages: Array<{ content: string }> };
  return JSON.parse(body.messages[1].content) as SemanticSummaryProviderRequest;
}

describe('KnowledgeSemanticSummaryStore', () => {
  const fixture = new ProviderFixture();
  let db: Database.Database;
  let harness: ProviderHarness;
  let tick: number;

  beforeEach(() => {
    db = openHarnessDatabase('/tmp/unused-workspace');
    harness = createProviderHarness(db);
    tick = 0;
  });

  afterEach(async () => {
    await fixture.stop();
    fixture.requests.length = 0;
    db.close();
  });

  const store = (overrides: Partial<ConstructorParameters<typeof KnowledgeSemanticSummaryStore>[0]> = {}) =>
    new KnowledgeSemanticSummaryStore({
      db,
      gateway: harness.gateway,
      now: () => new Date(Date.UTC(2026, 8, 29, 0, 0, tick++)).toISOString(),
      ...overrides,
    });
  const build = (input: Partial<BuildKnowledgeSemanticSummaryInput> & Pick<BuildKnowledgeSemanticSummaryInput, 'scopeKind' | 'scopeId'>) =>
    store().build({ projectId: FIXTURE_PROJECT_ID, ...input });

  function answerAll(request: SemanticSummaryProviderRequest) {
    const ids = request.evidence.filter((entry) => entry.citation !== null).map((entry) => entry.id);
    return {
      title: 'Refined title',
      summary: 'A more coherent summary of the source.',
      bullets: ['Authentication lives here.', 'A second grounded point.'],
      evidenceIdsByBullet: [[ids[0]], [ids[ids.length - 1]]],
    };
  }

  function respondWith(build: (request: SemanticSummaryProviderRequest) => unknown) {
    return fixture.start((request, response) => completionResponse(build(requestOf(fixture)))(request, response));
  }

  describe('deterministic summaries', () => {
    it('summarizes a source version from extraction data with exact-span references and no provider', async () => {
      const corpus = seedAuthCorpus(db);

      const record = await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId });

      expect(record).toMatchObject({ strategy: 'deterministic', providerProfileName: null, warnings: [], scopeKind: 'source_version' });
      expect(record.title).toContain('src/auth/login.ts');
      expect(record.bullets.join('\n')).toContain('authenticateUser');
      expect(record.bullets.join('\n')).toContain('Login flow');
      const spanCitations = record.evidence.flatMap((entry) => (entry.citation?.span ? [entry.citation] : []));
      expect(spanCitations.length).toBeGreaterThanOrEqual(2);
      for (const citation of spanCitations) {
        expect(citation.context).toMatchObject({ matchKind: 'exact_span', snippetPolicy: 'reference_only' });
        expect(citation.context?.sourceVersionId).toBe(corpus.login.sourceVersionId);
      }
      expect(record.bulletEvidenceIds).toHaveLength(record.bullets.length);
      expect(fixture.requests).toHaveLength(0);
    });

    it('bounds symbols and sections', async () => {
      const indexed = indexFixtureSource(db, {
        path: 'src/big.ts',
        symbols: Array.from({ length: 9 }, (_, index) => ({ name: `symbol${index}`, startLine: index + 1, endLine: index + 1 })),
        sections: Array.from({ length: 9 }, (_, index) => ({ title: `Section ${index}`, text: `text ${index}`, startLine: 20 + index, endLine: 20 + index })),
      });

      const record = await build({ scopeKind: 'source_version', scopeId: indexed.sourceVersionId });

      expect(record.bullets.length).toBeLessThanOrEqual(8);
      expect(record.evidence.length).toBeLessThanOrEqual(12);
    });

    it('summarizes a page version from its summary and provenance', async () => {
      const seeded = seedPageOnly(db);

      const record = await build({ scopeKind: 'page_version', scopeId: seeded.page.id });

      expect(record.strategy).toBe('deterministic');
      expect(record.summary).toContain('Explains zeppelin routing tables.');
      expect(record.title).toContain('Zeppelin routing');
      const cited = record.evidence.flatMap((entry) => (entry.citation ? [entry.citation] : []));
      expect(cited.some((citation) => citation.context?.sourceSpanId === 'span_zeppelin')).toBe(true);
      for (const citation of cited) expect(citation.context?.snippetPolicy).toBe('reference_only');
    });

    it('summarizes the project from bounded page summaries and counts', async () => {
      seedPageOnly(db);

      const record = await build({ scopeKind: 'project', scopeId: FIXTURE_PROJECT_ID });

      expect(record.strategy).toBe('deterministic');
      expect(record.bullets.join('\n')).toContain('Zeppelin routing');
      expect(record.summary).toMatch(/1 active page/);
    });

    it('keeps project scopes isolated', async () => {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES ('project_2', '/other', 'Other', 'active', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
      ).run();
      const other = seedAuthCorpus(db, 'project_2');
      seedPageOnly(db);

      const record = await build({ scopeKind: 'project', scopeId: FIXTURE_PROJECT_ID });
      expect(JSON.stringify(record)).not.toContain('project_2');
      await expect(build({ scopeKind: 'source_version', scopeId: other.login.sourceVersionId })).rejects.toThrow(/not found/);
      await expect(build({ scopeKind: 'project', scopeId: 'project_2' })).rejects.toThrow(/not found/);
    });

    it('rejects unknown scopes', async () => {
      await expect(build({ scopeKind: 'source_version', scopeId: 'missing' })).rejects.toThrow(/not found/);
      await expect(build({ scopeKind: 'page_version', scopeId: 'missing' })).rejects.toThrow(/not found/);
    });

    it('persists and returns the latest record, keeping created_at strictly increasing', async () => {
      const corpus = seedAuthCorpus(db);
      const summaries = store({ now: () => '2026-09-29T00:00:00.000Z' });
      const scope = { projectId: FIXTURE_PROJECT_ID, scopeKind: 'source_version' as const, scopeId: corpus.login.sourceVersionId };

      const first = await summaries.build(scope);
      const second = await summaries.build(scope);

      expect(second.createdAt > first.createdAt).toBe(true);
      expect(summaries.getLatest(FIXTURE_PROJECT_ID, 'source_version', corpus.login.sourceVersionId)).toEqual(second);
      expect(summaries.getLatest(FIXTURE_PROJECT_ID, 'source_version', 'other')).toBeNull();
      expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_semantic_summaries').get()).toEqual({ n: 2 });
    });

    it('reports the feature as unavailable on a database without the table', async () => {
      const corpus = seedAuthCorpus(db);
      db.exec('DROP TABLE knowledge_semantic_summaries');

      expect(store().getLatest(FIXTURE_PROJECT_ID, 'project', FIXTURE_PROJECT_ID)).toBeNull();
      await expect(build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId })).rejects.toThrow(/unavailable/);
    });

    it('stores only reference-only summary data', async () => {
      const corpus = seedAuthCorpus(db);

      await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId });

      const row = db.prepare('SELECT * FROM knowledge_semantic_summaries').get() as Record<string, string | null>;
      expect(row.provider_profile_name).toBeNull();
      expect(row.warnings_json).toBe('[]');
      expect(row.summary_json).not.toContain('raw contents');
      expect(Object.keys(JSON.parse(row.summary_json as string) as object).sort()).toEqual(
        ['bulletEvidenceIds', 'bullets', 'evidence', 'summary', 'title'],
      );
      expect(row.summary_json).not.toContain('ephemeral_redacted');
    });

    it('never consults a provider when the mode is omitted or never', async () => {
      const corpus = seedAuthCorpus(db);
      const endpoint = await respondWith(answerAll);
      harness.createProfile({ name: 'gen', endpoint });
      harness.hostSettings.set(FIXTURE_PROJECT_ID, KNOWLEDGE_HOST_SETTING_KEYS.providerSummaryProfile, 'gen');

      const omitted = await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId });
      const never = await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId, providerMode: 'never', providerProfileName: 'gen' });

      expect(fixture.requests).toHaveLength(0);
      expect(omitted.strategy).toBe('deterministic');
      expect(never.strategy).toBe('deterministic');
    });
  });

  describe('provider refinement', () => {
    it('accepts a grounded response as provider_refined with one bounded non-streaming request', async () => {
      const corpus = seedAuthCorpus(db);
      const endpoint = await respondWith(answerAll);
      harness.createProfile({ name: 'gen', endpoint });

      const record = await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId, providerMode: 'if-available', providerProfileName: 'gen' });

      expect(fixture.requests).toHaveLength(1);
      const body = JSON.parse(fixture.requests[0].body) as Record<string, unknown>;
      expect(body.stream).toBeUndefined();
      expect(Buffer.byteLength(fixture.requests[0].body, 'utf8')).toBeLessThan(16_000);
      const sent = requestOf(fixture);
      expect(sent.scopeKind).toBe('source_version');
      expect(sent.deterministicSummary.length).toBeGreaterThan(0);
      expect(sent.evidence.some((entry) => entry.text.length > 0)).toBe(true);
      expect(JSON.stringify(sent)).not.toContain('raw contents');
      expect(record).toMatchObject({
        strategy: 'provider_refined',
        providerProfileName: 'gen',
        title: 'Refined title',
        summary: 'A more coherent summary of the source.',
        warnings: [],
      });
      expect(record.bullets).toEqual(['Authentication lives here.', 'A second grounded point.']);
      const cited = new Set(record.bulletEvidenceIds.flat());
      expect(new Set(record.evidence.map((entry) => entry.evidenceId))).toEqual(cited);
      const row = db.prepare('SELECT provider_profile_name, summary_json, warnings_json FROM knowledge_semantic_summaries').get() as Record<string, string>;
      expect(row.provider_profile_name).toBe('gen');
      for (const forbidden of [endpoint, 'harness-model', 'ARIADNE_KNOWLEDGE_PROVIDER', 'You refine', 'evidenceIdsByBullet', 'response_format']) {
        expect(row.summary_json + row.warnings_json).not.toContain(forbidden);
      }
    });

    it('prefers the explicit profile over the host-local setting', async () => {
      const corpus = seedAuthCorpus(db);
      const explicitEndpoint = await respondWith(answerAll);
      const other = new ProviderFixture();
      const hostEndpoint = await other.start(completionResponse({}));
      try {
        harness.createProfile({ name: 'explicit', endpoint: explicitEndpoint });
        harness.createProfile({ name: 'host', endpoint: hostEndpoint });
        harness.hostSettings.set(FIXTURE_PROJECT_ID, KNOWLEDGE_HOST_SETTING_KEYS.providerSummaryProfile, 'host');
        const scope = { scopeKind: 'source_version' as const, scopeId: corpus.login.sourceVersionId, providerMode: 'if-available' as const };

        const explicit = await build({ ...scope, providerProfileName: 'explicit' });
        expect(explicit.providerProfileName).toBe('explicit');
        expect(other.requests).toHaveLength(0);

        await build(scope);
        expect(other.requests).toHaveLength(1);
      } finally {
        await other.stop();
      }
    });

    it('redacts accepted provider prose', async () => {
      const corpus = seedAuthCorpus(db);
      const endpoint = await respondWith((request) => ({
        ...answerAll(request),
        summary: 'Uses api_key=sk-live-abcdefghijklmnop123456 internally.',
      }));
      harness.createProfile({ name: 'gen', endpoint });

      const record = await build({ scopeKind: 'source_version', scopeId: corpus.login.sourceVersionId, providerMode: 'if-available', providerProfileName: 'gen' });

      expect(record.strategy).toBe('provider_refined');
      expect(JSON.stringify(record)).not.toContain('sk-live-abcdefghijklmnop123456');
    });

    async function expectFallback(reason: ProviderFallbackReason, code: string, input: { providerProfileName?: string | null } = {}) {
      const corpus = seedAuthCorpus(db);
      const scope = { scopeKind: 'source_version' as const, scopeId: corpus.login.sourceVersionId };
      const deterministic = await build(scope);
      const record = await build({ ...scope, providerMode: 'if-available', ...input });
      expect(record.strategy).toBe('fallback_warning');
      expect(record.providerProfileName).toBeNull();
      expect(record.warnings).toHaveLength(1);
      expect(record.warnings[0]).toMatchObject({ code, reason });
      expect(record.warnings[0].message).not.toMatch(/127\.0\.0\.1|sk-|http/);
      expect({ ...record, id: '', strategy: '', warnings: [], createdAt: '', updatedAt: '' }).toEqual({
        ...deterministic,
        id: '',
        strategy: '',
        warnings: [],
        createdAt: '',
        updatedAt: '',
      });
      const row = db.prepare('SELECT provider_profile_name FROM knowledge_semantic_summaries ORDER BY created_at DESC').get() as { provider_profile_name: string | null };
      expect(row.provider_profile_name).toBeNull();
      return record;
    }

    it('falls back with no_profile when nothing resolves', async () => {
      await expectFallback('no_profile', 'provider_unavailable');
    });

    it('falls back with no_profile when no gateway is configured', async () => {
      const corpus = seedAuthCorpus(db);
      const record = await store({ gateway: undefined }).build({
        projectId: FIXTURE_PROJECT_ID,
        scopeKind: 'source_version',
        scopeId: corpus.login.sourceVersionId,
        providerMode: 'if-available',
      });
      expect(record.warnings).toEqual([expect.objectContaining({ reason: 'no_profile' })]);
    });

    it('falls back for a disabled profile', async () => {
      harness.createProfile({ name: 'off', endpoint: 'http://127.0.0.1:9/v1', enabled: false });
      await expectFallback('profile_disabled', 'provider_unavailable', { providerProfileName: 'off' });
    });

    it('falls back for a missing generation capability', async () => {
      harness.createProfile({ name: 'analysis', endpoint: 'http://127.0.0.1:9/v1', capabilities: ['analysis'] });
      await expectFallback('capability_missing', 'provider_unavailable', { providerProfileName: 'analysis' });
    });

    it('falls back for missing credentials without contacting the provider', async () => {
      const endpoint = await respondWith(answerAll);
      harness.createProfile({ name: 'gen', endpoint });
      harness.environment.ARIADNE_KNOWLEDGE_PROVIDER_HARNESS_KEY = undefined;
      await expectFallback('missing_credentials', 'provider_unavailable', { providerProfileName: 'gen' });
      expect(fixture.requests).toHaveLength(0);
    });

    it('falls back for a timeout', async () => {
      const endpoint = await fixture.start(() => new Promise<void>(() => undefined));
      harness.createProfile({ name: 'slow', endpoint, timeoutMs: 100 });
      await expectFallback('timeout', 'provider_unavailable', { providerProfileName: 'slow' });
    });

    it('falls back for a provider error', async () => {
      const endpoint = await fixture.start((_request, response) => {
        response.writeHead(500);
        response.end('boom');
      });
      harness.createProfile({ name: 'bad', endpoint });
      await expectFallback('provider_error', 'provider_unavailable', { providerProfileName: 'bad' });
    });

    it('falls back for an unsafe endpoint', async () => {
      const endpoint = await fixture.start(completionResponse({}));
      const unsafe = createProviderHarness(db, { allowedOrigins: () => new Set() });
      unsafe.createProfile({ name: 'unsafe', endpoint });
      const corpus = seedAuthCorpus(db);

      const record = await store({ gateway: unsafe.gateway }).build({
        projectId: FIXTURE_PROJECT_ID,
        scopeKind: 'source_version',
        scopeId: corpus.login.sourceVersionId,
        providerMode: 'if-available',
        providerProfileName: 'unsafe',
      });

      expect(record.warnings).toEqual([expect.objectContaining({ code: 'provider_unavailable', reason: 'unsafe_endpoint' })]);
      expect(fixture.requests).toHaveLength(0);
    });

    const invalid: Array<[string, (ids: string[]) => unknown]> = [
      ['unknown evidence ids', () => ({ title: 't', summary: 's', bullets: ['b'], evidenceIdsByBullet: [['evidence_unknown']] })],
      ['a bullet without evidence', () => ({ title: 't', summary: 's', bullets: ['b'], evidenceIdsByBullet: [[]] })],
      ['misaligned evidence lists', (ids) => ({ title: 't', summary: 's', bullets: ['a', 'b'], evidenceIdsByBullet: [[ids[0]]] })],
      ['too many bullets', (ids) => ({ title: 't', summary: 's', bullets: Array.from({ length: 9 }, () => 'b'), evidenceIdsByBullet: Array.from({ length: 9 }, () => [ids[0]]) })],
      ['an oversized bullet', (ids) => ({ title: 't', summary: 's', bullets: ['b'.repeat(241)], evidenceIdsByBullet: [[ids[0]]] })],
      ['an oversized summary', (ids) => ({ title: 't', summary: 's'.repeat(501), bullets: ['b'], evidenceIdsByBullet: [[ids[0]]] })],
      ['an oversized title', (ids) => ({ title: 't'.repeat(121), summary: 's', bullets: ['b'], evidenceIdsByBullet: [[ids[0]]] })],
      ['an empty title', (ids) => ({ title: ' ', summary: 's', bullets: ['b'], evidenceIdsByBullet: [[ids[0]]] })],
      ['no bullets', () => ({ title: 't', summary: 's', bullets: [], evidenceIdsByBullet: [] })],
      ['an unknown key', (ids) => ({ title: 't', summary: 's', bullets: ['b'], evidenceIdsByBullet: [[ids[0]]], extra: true })],
      ['a missing key', () => ({ title: 't', summary: 's', bullets: ['b'] })],
      ['non-string bullets', (ids) => ({ title: 't', summary: 's', bullets: [3], evidenceIdsByBullet: [[ids[0]]] })],
      ['non-object payload', () => ['x']],
    ];

    it.each(invalid)('rejects %s and falls back with provider_invalid', async (_name, buildResponse) => {
      const endpoint = await respondWith((request) => buildResponse(request.evidence.map((entry) => entry.id)));
      harness.createProfile({ name: 'gen', endpoint });
      await expectFallback('invalid_response', 'provider_invalid', { providerProfileName: 'gen' });
      expect(fixture.requests).toHaveLength(1);
    });

    it('rejects a bullet whose only evidence has no citation', async () => {
      seedPageOnly(db);
      const endpoint = await respondWith((request) => {
        const uncited = request.evidence.find((entry) => entry.citation === null);
        return { title: 't', summary: 's', bullets: ['b'], evidenceIdsByBullet: [[uncited?.id ?? 'missing']] };
      });
      harness.createProfile({ name: 'gen', endpoint });

      const record = await build({ scopeKind: 'project', scopeId: FIXTURE_PROJECT_ID, providerMode: 'if-available', providerProfileName: 'gen' });

      expect(record.strategy).toBe('fallback_warning');
      expect(record.warnings).toEqual([expect.objectContaining({ code: 'provider_invalid', reason: 'invalid_response' })]);
    });
  });
});
