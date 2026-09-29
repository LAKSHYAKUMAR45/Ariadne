import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { TaskStore } from '../../src/TaskStore.js';
import { KnowledgeAnswerSynthesizer } from '../../src/knowledge/KnowledgeAnswerSynthesis.js';
import { KNOWLEDGE_HOST_SETTING_KEYS } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeLocalSemanticIndex } from '../../src/knowledge/KnowledgeLocalSemanticIndex.js';
import { KnowledgeHostSettingsStore, KnowledgeSearchSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { PROVIDER_FALLBACK_REASONS, type ProviderFallbackReason } from '../../src/knowledge/KnowledgeProviderFallback.js';
import type { KnowledgeSynthesisProviderRequest, KnowledgeSynthesisResult } from '../../src/knowledge/KnowledgeSynthesisTypes.js';
import { toPersistedKnowledgeSynthesis } from '../../src/knowledge/KnowledgeSynthesisPersistence.js';
import {
  FIXTURE_PROJECT_ID,
  indexFixtureSource,
  seedAuthCorpus,
  seedNearTieCorpus,
  seedPageOnly,
} from './knowledgeSynthesisFixtures.js';
import {
  ProviderFixture,
  completionResponse,
  createProviderHarness,
  openHarnessDatabase,
  type FixtureHandler,
  type ProviderHarness,
} from './knowledgeProviderTestHarness.js';

const QUERY = 'authenticate user session';

function providerRequestOf(fixture: ProviderFixture, index = 0): KnowledgeSynthesisProviderRequest {
  const body = JSON.parse(fixture.requests[index].body) as { messages: Array<{ content: string }> };
  return JSON.parse(body.messages[1].content) as KnowledgeSynthesisProviderRequest;
}

function answerFromRequest(fixture: ProviderFixture): FixtureHandler {
  return (request, response) => {
    const provided = providerRequestOf(fixture, fixture.requests.length - 1);
    const ids = provided.evidence.map((entry) => entry.id);
    completionResponse({
      sections: [{ heading: 'Answer', claims: [{ text: 'Authentication and session creation span two files.', evidenceIds: ids.slice(0, 2) }] }],
    })(request, response);
  };
}

describe('KnowledgeAnswerSynthesizer', () => {
  const fixture = new ProviderFixture();
  let db: Database.Database;
  let harness: ProviderHarness;

  beforeEach(() => {
    db = openHarnessDatabase('/tmp/unused-workspace');
    harness = createProviderHarness(db);
  });

  afterEach(async () => {
    await fixture.stop();
    fixture.requests.length = 0;
    db.close();
  });

  const synthesizer = (redact?: (value: string) => string) => new KnowledgeAnswerSynthesizer({ db, gateway: harness.gateway, redact });
  const synthesize = (input: Partial<Parameters<KnowledgeAnswerSynthesizer['synthesize']>[0]> = {}) =>
    synthesizer().synthesize({ projectId: FIXTURE_PROJECT_ID, query: QUERY, mode: 'sources', ...input });

  describe('deterministic synthesis', () => {
    it('cites exact spans from more than one file without any provider', async () => {
      const corpus = seedAuthCorpus(db);

      const result = await synthesize();

      expect(result.strategy).toBe('deterministic');
      expect(result.sections.map((section) => section.heading)).toContain('Answer');
      const paths = new Set(result.citations.map((citation) => citation.path));
      expect(paths).toEqual(new Set(['src/auth/login.ts', 'src/auth/session.ts']));
      for (const citation of result.citations) {
        expect(citation.context).toMatchObject({ matchKind: 'exact_span', snippetPolicy: 'reference_only' });
        expect(citation.span?.id).toBeTruthy();
      }
      const versionIds = result.citations.map((citation) => citation.context?.sourceVersionId);
      expect(new Set(versionIds)).toEqual(new Set([corpus.login.sourceVersionId, corpus.session.sourceVersionId]));
      expect(result.warnings).toEqual([]);
    });

    it('preserves the search span id from evidence through claims', async () => {
      seedAuthCorpus(db);

      const result = await synthesize();

      const evidenceSpanIds = new Set(result.evidence.map((entry) => entry.citation?.span?.id));
      const claims = result.sections.flatMap((section) => section.claims);
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim.citations.length).toBeGreaterThan(0);
        for (const citation of claim.citations) expect(evidenceSpanIds.has(citation.span?.id)).toBe(true);
      }
    });

    it('is stable: identical inputs give identical structure and ids', async () => {
      seedAuthCorpus(db);

      expect(await synthesize()).toEqual(await synthesize());
    });

    it('keeps evidence reference-only and never reads or embeds source content', async () => {
      seedAuthCorpus(db);

      const result = await synthesize();

      for (const entry of result.evidence) {
        expect(entry.snippetPolicy).toBe('reference_only');
        expect(entry.ephemeralSnippet).toBeNull();
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('raw contents');
      expect(serialized).not.toContain('credentials against the directory');
      expect(result.answerMarkdown).toContain('[1]');
      expect(result.answerMarkdown).toContain('src/auth/login.ts');
    });

    it('applies the redaction hook to every title and claim', async () => {
      seedAuthCorpus(db);

      const result = await synthesizer((value) => value.replaceAll('authenticateUser', '[hidden]')).synthesize({
        projectId: FIXTURE_PROJECT_ID,
        query: QUERY,
        mode: 'sources',
      });

      const prose = [result.answerMarkdown, ...result.sections.flatMap((section) => section.claims.map((claim) => claim.text))];
      for (const text of prose) expect(text).not.toContain('authenticateUser');
      expect(result.answerMarkdown).toContain('[hidden]');
    });

    it('bounds the evidence pack and reports result_limit_reached', async () => {
      for (let index = 0; index < 12; index += 1) {
        indexFixtureSource(db, {
          path: `src/many/file${index}.ts`,
          sections: [{ title: 'Notes', text: 'quasar pipeline stage', startLine: 1, endLine: 2 }],
        });
      }

      const result = await synthesize({ query: 'quasar pipeline', limit: 12 });

      const resultIds = new Set(result.evidence.map((entry) => entry.resultId));
      expect(resultIds.size).toBeLessThanOrEqual(8);
      expect(result.evidence.length).toBeLessThanOrEqual(12);
      expect(result.warnings.map((warning) => warning.code)).toContain('result_limit_reached');
    });

    it('reports result_limit_reached when the token budget drops results', async () => {
      seedAuthCorpus(db);

      const result = await synthesize({ tokenBudget: 60 });

      expect(result.warnings.map((warning) => warning.code)).toContain('result_limit_reached');
    });

    it('answers with an explicit no-evidence statement when nothing matches', async () => {
      seedAuthCorpus(db);

      const result = await synthesize({ query: 'nonexistentterm' });

      expect(result.evidence).toEqual([]);
      expect(result.citations).toEqual([]);
      expect(result.warnings.map((warning) => warning.code)).toEqual(['insufficient_exact_spans']);
      expect(result.answerMarkdown.toLowerCase()).toContain('no matching evidence');
    });

    it('never upgrades page or task evidence into exact-span source citations', async () => {
      seedPageOnly(db);
      const taskStore = new TaskStore(':memory:');
      try {
        const task = taskStore.createTask({ title: 'Zeppelin fuel audit', goal: 'Audit zeppelin fuel' });

        const result = await synthesizer().synthesize({
          projectId: FIXTURE_PROJECT_ID,
          query: 'zeppelin',
          mode: 'hybrid',
          taskStore,
        });

        expect(result.warnings.map((warning) => warning.code)).toContain('insufficient_exact_spans');
        const kinds = new Set(result.evidence.map((entry) => entry.kind));
        expect(kinds).toEqual(new Set(['page', 'task']));
        for (const entry of result.evidence.filter((candidate) => candidate.kind === 'page')) {
          expect(entry.citation?.context?.matchKind).toBe('page_provenance');
        }
        for (const entry of result.evidence.filter((candidate) => candidate.kind === 'task')) {
          expect(entry.citation).toBeNull();
          expect(entry.snippetPolicy).toBe('reference_only');
        }
        const taskClaim = result.sections.flatMap((section) => section.claims).find((claim) => claim.evidenceIds.length === 1 && claim.citations.length === 0);
        expect(taskClaim?.text).toContain('Zeppelin fuel audit');
        expect(taskClaim?.confidence).toBe('unassessed');
        expect(task.id).toBeTruthy();
      } finally {
        taskStore.close();
      }
    });

    it('does not include another project’s evidence', async () => {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES ('project_2', '/other', 'Other', 'active', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
      ).run();
      seedAuthCorpus(db, 'project_2');

      const result = await synthesize();

      expect(result.evidence).toEqual([]);
    });
  });

  describe('ambiguity propagation', () => {
    it('copies search confidence, warns once, and lists competing results', async () => {
      seedNearTieCorpus(db);

      const result = await synthesize({ query: 'invoice' });

      const ambiguity = result.warnings.filter((warning) => warning.code === 'ambiguous_evidence');
      expect(ambiguity).toHaveLength(1);
      expect(ambiguity[0].ambiguityReason).toBeTruthy();
      expect(ambiguity[0].alternativeCount).toBeGreaterThan(0);
      expect(result.evidence.some((entry) => entry.searchConfidence === 'ambiguous')).toBe(true);
      const leadClaim = result.sections.find((section) => section.heading === 'Answer')?.claims[0];
      expect(leadClaim?.confidence).toBe('ambiguous');
      const open = result.sections.find((section) => section.heading === 'Open questions / ambiguity');
      expect(open?.claims.length).toBeGreaterThan(0);
      for (const claim of open?.claims ?? []) expect(claim.citations.length).toBeGreaterThan(0);
    });

    it('marks clear results as clear and omits the ambiguity section', async () => {
      seedAuthCorpus(db);

      const result = await synthesize({ query: 'authenticateUser' });

      expect(result.warnings.map((warning) => warning.code)).not.toContain('ambiguous_evidence');
      expect(result.sections.map((section) => section.heading)).not.toContain('Open questions / ambiguity');
      const leadClaim = result.sections.find((section) => section.heading === 'Answer')?.claims[0];
      expect(leadClaim?.confidence).toBe('clear');
    });

    it('keeps the search-provided ambiguity mapping after a semantic reorder', async () => {
      seedNearTieCorpus(db);
      new KnowledgeLocalSemanticIndex(db).replaceForProject(FIXTURE_PROJECT_ID);
      new KnowledgeSearchSettingsStore(new KnowledgeHostSettingsStore(db)).setHybridEnabled(FIXTURE_PROJECT_ID, true);

      const hybrid = await synthesize({ query: 'invoice' });

      expect(hybrid.warnings.filter((warning) => warning.code === 'ambiguous_evidence')).toHaveLength(1);
      expect(hybrid.sections.find((section) => section.heading === 'Answer')?.claims[0].confidence).toBe('ambiguous');
    });
  });

  describe('opt-in provider generation', () => {
    it('never consults a provider when the strategy is omitted or never', async () => {
      const endpoint = await fixture.start(completionResponse({ sections: [] }));
      harness.createProfile({ name: 'gen', endpoint });
      harness.hostSettings.set(FIXTURE_PROJECT_ID, KNOWLEDGE_HOST_SETTING_KEYS.providerSynthesisProfile, 'gen');
      seedAuthCorpus(db);

      const omitted = await synthesize();
      const never = await synthesize({ providerStrategy: 'never', providerProfileName: 'gen' });

      expect(fixture.requests).toHaveLength(0);
      expect(omitted).toEqual(never);
      expect(omitted.strategy).toBe('deterministic');
    });

    it('falls back with a no_profile warning when opted in without a resolvable profile', async () => {
      seedAuthCorpus(db);
      const deterministic = await synthesize();

      const result = await synthesize({ providerStrategy: 'if-available' });

      expect(result.strategy).toBe('deterministic');
      expect(result.warnings).toEqual([
        ...deterministic.warnings,
        expect.objectContaining({ code: 'provider_unavailable', reason: 'no_profile' }),
      ]);
      expect({ ...result, warnings: deterministic.warnings }).toEqual(deterministic);
    });

    it('makes one bounded non-streaming request and rebuilds citations from evidence ids', async () => {
      const endpoint = await fixture.start(answerFromRequest(fixture));
      harness.createProfile({ name: 'gen', endpoint });
      seedAuthCorpus(db);

      const result = await synthesize({ providerStrategy: 'if-available', providerProfileName: 'gen' });

      expect(fixture.requests).toHaveLength(1);
      const body = JSON.parse(fixture.requests[0].body) as Record<string, unknown>;
      expect(body.stream).toBeUndefined();
      expect(Buffer.byteLength(fixture.requests[0].body, 'utf8')).toBeLessThan(16_000);
      const sent = providerRequestOf(fixture);
      expect(sent.evidence.length).toBeGreaterThan(0);
      expect(JSON.stringify(sent)).not.toContain('raw contents');
      expect(result.strategy).toBe('provider-assisted');
      const claim = result.sections.find((section) => section.heading === 'Answer')?.claims[0];
      expect(claim?.text).toBe('Authentication and session creation span two files.');
      expect(claim?.citations.map((citation) => citation.path).sort()).toEqual(['src/auth/login.ts', 'src/auth/session.ts']);
      expect(result.answerMarkdown).toContain('Authentication and session creation span two files.');
    });

    it('sends redacted, bounded ephemeral snippets and drops them on persistence', async () => {
      const endpoint = await fixture.start(answerFromRequest(fixture));
      harness.createProfile({ name: 'gen', endpoint });
      seedAuthCorpus(db);

      const result = await synthesize({ query: 'credentials directory', providerStrategy: 'if-available', providerProfileName: 'gen' });

      const sent = providerRequestOf(fixture);
      const snippets = sent.evidence.map((entry) => entry.snippet).filter((snippet): snippet is string => snippet !== null);
      expect(snippets.length).toBeGreaterThan(0);
      for (const snippet of snippets) expect(snippet.length).toBeLessThanOrEqual(240);
      expect(result.evidence.some((entry) => entry.snippetPolicy === 'ephemeral_redacted')).toBe(true);
      const persisted = JSON.stringify(toPersistedKnowledgeSynthesis(result));
      expect(snippets.some((snippet) => snippet.includes('directory'))).toBe(true);
      expect(persisted).not.toContain('against the directory');
      expect(persisted).not.toContain('ephemeralSnippet');
    });

    it('prefers the explicit profile over the host-local setting', async () => {
      const explicitEndpoint = await fixture.start(answerFromRequest(fixture));
      const other = new ProviderFixture();
      const hostEndpoint = await other.start(completionResponse({ sections: [] }));
      try {
        harness.createProfile({ name: 'explicit', endpoint: explicitEndpoint });
        harness.createProfile({ name: 'host', endpoint: hostEndpoint });
        harness.hostSettings.set(FIXTURE_PROJECT_ID, KNOWLEDGE_HOST_SETTING_KEYS.providerSynthesisProfile, 'host');
        seedAuthCorpus(db);

        await synthesize({ providerStrategy: 'if-available', providerProfileName: 'explicit' });
        expect(fixture.requests).toHaveLength(1);
        expect(other.requests).toHaveLength(0);

        await synthesize({ providerStrategy: 'if-available' });
        expect(other.requests).toHaveLength(1);
      } finally {
        await other.stop();
      }
    });

    it('dedupes repeated evidence ids within a claim', async () => {
      const endpoint = await fixture.start((request, response) => {
        const id = providerRequestOf(fixture, fixture.requests.length - 1).evidence[0].id;
        completionResponse({ sections: [{ heading: 'Answer', claims: [{ text: 'One file.', evidenceIds: [id, id] }] }] })(request, response);
      });
      harness.createProfile({ name: 'gen', endpoint });
      seedAuthCorpus(db);

      const result = await synthesize({ providerStrategy: 'if-available', providerProfileName: 'gen' });

      const claim = result.sections[0].claims[0];
      expect(claim.evidenceIds).toHaveLength(1);
      expect(claim.citations).toHaveLength(1);
    });

    it('keeps the deterministic ambiguity section and warning on provider-assisted results', async () => {
      const endpoint = await fixture.start(answerFromRequest(fixture));
      harness.createProfile({ name: 'gen', endpoint });
      seedNearTieCorpus(db);

      const result = await synthesize({ query: 'invoice', providerStrategy: 'if-available', providerProfileName: 'gen' });

      expect(result.strategy).toBe('provider-assisted');
      expect(result.warnings.filter((warning) => warning.code === 'ambiguous_evidence')).toHaveLength(1);
      expect(result.sections.map((section) => section.heading)).toContain('Open questions / ambiguity');
      expect(result.sections[0].claims[0].confidence).toBe('ambiguous');
    });

    it('redacts accepted provider prose', async () => {
      const endpoint = await fixture.start((request, response) => {
        const id = providerRequestOf(fixture, fixture.requests.length - 1).evidence[0].id;
        completionResponse({
          sections: [{ heading: 'Answer', claims: [{ text: 'Token is api_key=sk-live-abcdefghijklmnop123456.', evidenceIds: [id] }] }],
        })(request, response);
      });
      harness.createProfile({ name: 'gen', endpoint });
      seedAuthCorpus(db);

      const result = await synthesize({ providerStrategy: 'if-available', providerProfileName: 'gen' });

      expect(JSON.stringify(result)).not.toContain('sk-live-abcdefghijklmnop123456');
    });
  });

  describe('warning-only fallback', () => {
    async function expectFallback(reason: ProviderFallbackReason, input: Partial<Parameters<KnowledgeAnswerSynthesizer['synthesize']>[0]>) {
      seedAuthCorpus(db);
      const deterministic = await synthesize();
      const result = await synthesize({ providerStrategy: 'if-available', ...input });
      expect(result.strategy).toBe('deterministic');
      const providerWarnings = result.warnings.filter((warning) => warning.code === 'provider_unavailable' || warning.code === 'provider_invalid');
      expect(providerWarnings).toHaveLength(1);
      expect(providerWarnings[0].reason).toBe(reason);
      expect(providerWarnings[0].message).not.toMatch(/127\.0\.0\.1|sk-|http/);
      expect({ ...result, warnings: deterministic.warnings }).toEqual(deterministic);
      return result;
    }

    it('handles a disabled profile', async () => {
      harness.createProfile({ name: 'off', endpoint: 'http://127.0.0.1:9/v1', enabled: false });
      await expectFallback('profile_disabled', { providerProfileName: 'off' });
    });

    it('handles a missing generation capability', async () => {
      harness.createProfile({ name: 'analysis', endpoint: 'http://127.0.0.1:9/v1', capabilities: ['analysis'] });
      await expectFallback('capability_missing', { providerProfileName: 'analysis' });
    });

    it('handles missing credentials', async () => {
      const endpoint = await fixture.start(completionResponse({ sections: [] }));
      harness.createProfile({ name: 'gen', endpoint });
      harness.environment.ARIADNE_KNOWLEDGE_PROVIDER_HARNESS_KEY = undefined;
      await expectFallback('missing_credentials', { providerProfileName: 'gen' });
      expect(fixture.requests).toHaveLength(0);
    });

    it('handles a provider timeout', async () => {
      const endpoint = await fixture.start(() => new Promise<void>(() => undefined));
      harness.createProfile({ name: 'slow', endpoint, timeoutMs: 100 });
      await expectFallback('timeout', { providerProfileName: 'slow' });
    });

    it('handles a provider HTTP error', async () => {
      const endpoint = await fixture.start((_request, response) => {
        response.writeHead(500);
        response.end('boom sk-secret');
      });
      harness.createProfile({ name: 'bad', endpoint });
      await expectFallback('provider_error', { providerProfileName: 'bad' });
    });

    it('handles an unsafe endpoint', async () => {
      const endpoint = await fixture.start(completionResponse({ sections: [] }));
      const unsafe = createProviderHarness(db, { allowedOrigins: () => new Set() });
      unsafe.createProfile({ name: 'unsafe', endpoint });
      seedAuthCorpus(db);
      const result = await new KnowledgeAnswerSynthesizer({ db, gateway: unsafe.gateway }).synthesize({
        projectId: FIXTURE_PROJECT_ID,
        query: QUERY,
        mode: 'sources',
        providerStrategy: 'if-available',
        providerProfileName: 'unsafe',
      });
      expect(result.warnings.at(-1)).toMatchObject({ code: 'provider_unavailable', reason: 'unsafe_endpoint' });
      expect(fixture.requests).toHaveLength(0);
    });

    it('never throws when no gateway is configured', async () => {
      seedAuthCorpus(db);
      const result = await new KnowledgeAnswerSynthesizer({ db }).synthesize({
        projectId: FIXTURE_PROJECT_ID,
        query: QUERY,
        mode: 'sources',
        providerStrategy: 'if-available',
      });
      expect(result.warnings.at(-1)).toMatchObject({ code: 'provider_unavailable', reason: 'no_profile' });
    });

    const invalidResponses: Array<[string, (ids: string[]) => unknown]> = [
      ['unknown evidence id', () => ({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: ['evidence_unknown'] }] }] })],
      ['no evidence ids', () => ({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: [] }] }] })],
      ['non-string evidence id', () => ({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: [7] }] }] })],
      ['empty sections', () => ({ sections: [] })],
      ['too many sections', (ids) => ({ sections: Array.from({ length: 5 }, () => ({ heading: 'A', claims: [{ text: 'x', evidenceIds: [ids[0]] }] })) })],
      ['too many claims', (ids) => ({ sections: [{ heading: 'A', claims: Array.from({ length: 7 }, () => ({ text: 'x', evidenceIds: [ids[0]] })) }] })],
      ['oversized claim text', (ids) => ({ sections: [{ heading: 'A', claims: [{ text: 'x'.repeat(401), evidenceIds: [ids[0]] }] }] })],
      ['oversized heading', (ids) => ({ sections: [{ heading: 'h'.repeat(81), claims: [{ text: 'x', evidenceIds: [ids[0]] }] }] })],
      ['unknown top-level key', (ids) => ({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: [ids[0]] }] }], extra: 1 })],
      ['unknown claim key', (ids) => ({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: [ids[0]], citations: [] }] }] })],
      ['non-object payload', () => ['sections']],
      ['empty text', (ids) => ({ sections: [{ heading: 'A', claims: [{ text: '  ', evidenceIds: [ids[0]] }] }] })],
    ];

    it.each(invalidResponses)('rejects %s with provider_invalid and the deterministic result', async (_name, build) => {
      const endpoint = await fixture.start((request, response) => {
        const ids = providerRequestOf(fixture, fixture.requests.length - 1).evidence.map((entry) => entry.id);
        completionResponse(build(ids))(request, response);
      });
      harness.createProfile({ name: 'gen', endpoint });
      const result = await expectFallback('invalid_response', { providerProfileName: 'gen' });
      expect(result.warnings.at(-1)?.code).toBe('provider_invalid');
      expect(fixture.requests).toHaveLength(1);
    });

    it('rejects a claim whose only evidence has no citation', async () => {
      seedPageOnly(db);
      const taskStore = new TaskStore(':memory:');
      try {
        taskStore.createTask({ title: 'Zeppelin fuel audit', goal: 'Audit zeppelin fuel' });
        const endpoint = await fixture.start((request, response) => {
          const evidence = providerRequestOf(fixture, fixture.requests.length - 1).evidence;
          const uncited = evidence.find((entry) => entry.citation === null);
          completionResponse({ sections: [{ heading: 'A', claims: [{ text: 'x', evidenceIds: [uncited?.id ?? 'missing'] }] }] })(request, response);
        });
        harness.createProfile({ name: 'gen', endpoint });

        const result = await synthesizer().synthesize({
          projectId: FIXTURE_PROJECT_ID,
          query: 'zeppelin',
          mode: 'hybrid',
          taskStore,
          providerStrategy: 'if-available',
          providerProfileName: 'gen',
        });

        expect(result.strategy).toBe('deterministic');
        expect(result.warnings.at(-1)).toMatchObject({ code: 'provider_invalid', reason: 'invalid_response' });
      } finally {
        taskStore.close();
      }
    });

    it('covers every shared fallback reason', () => {
      expect(PROVIDER_FALLBACK_REASONS).toHaveLength(8);
    });
  });

  describe('persistence of results', () => {
    it('produces a result that round-trips through the persisted synthesis validator', async () => {
      seedAuthCorpus(db);
      const result: KnowledgeSynthesisResult = await synthesize();

      const persisted = toPersistedKnowledgeSynthesis(result);

      expect(persisted.sections).toEqual(result.sections);
      expect(persisted.evidence.map((entry) => entry.id)).toEqual(result.evidence.map((entry) => entry.id));
    });
  });
});
