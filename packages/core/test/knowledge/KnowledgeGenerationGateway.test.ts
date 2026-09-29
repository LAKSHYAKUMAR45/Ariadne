import { afterEach, describe, expect, it } from 'vitest';
import { KNOWLEDGE_HOST_SETTING_KEYS } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { PROVIDER_FALLBACK_REASONS, type ProviderFallbackReason } from '../../src/knowledge/KnowledgeProviderFallback.js';
import {
  HARNESS_API_KEY,
  HARNESS_API_KEY_ENV,
  HARNESS_PROJECT_ID,
  ProviderFixture,
  completionResponse,
  createProviderHarness,
  openHarnessDatabase,
} from './knowledgeProviderTestHarness.js';

const SETTING = KNOWLEDGE_HOST_SETTING_KEYS.providerSynthesisProfile;

describe('KnowledgeGenerationGateway', () => {
  const fixture = new ProviderFixture();
  const databases: Array<{ close: () => void }> = [];

  afterEach(async () => {
    await fixture.stop();
    fixture.requests.length = 0;
    for (const db of databases.splice(0)) db.close();
  });

  function harness(options?: Parameters<typeof createProviderHarness>[1]) {
    const db = openHarnessDatabase('/tmp/unused-workspace');
    databases.push(db);
    return createProviderHarness(db, options);
  }

  const request = (overrides: Record<string, unknown> = {}) => ({
    projectId: HARNESS_PROJECT_ID,
    settingKey: SETTING,
    systemPrompt: 'Return JSON only.',
    prompt: '{"ping":true}',
    ...overrides,
  });

  it('sends one bounded non-streaming JSON request and returns the parsed value', async () => {
    const endpoint = await fixture.start(completionResponse({ ok: true }));
    const h = harness();
    h.createProfile({ name: 'gen', endpoint });
    const outcome = await h.gateway.requestJson(request({ explicitProfileName: 'gen' }));
    expect(outcome).toEqual({ ok: true, value: { ok: true }, profileName: 'gen' });
    expect(fixture.requests).toHaveLength(1);
    const body = JSON.parse(fixture.requests[0].body) as Record<string, unknown>;
    expect(body.stream).toBeUndefined();
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(fixture.requests[0].path).toBe('/v1/chat/completions');
  });

  it('prefers the explicit profile, then the host-local setting, and never guesses a first enabled profile', async () => {
    const endpoint = await fixture.start(completionResponse({ ok: true }));
    const h = harness();
    h.createProfile({ name: 'alpha', endpoint });
    h.createProfile({ name: 'beta', endpoint });

    const guessed = await h.gateway.requestJson(request());
    expect(guessed).toMatchObject({ ok: false, warning: { code: 'provider_unavailable', reason: 'no_profile' } });
    expect(fixture.requests).toHaveLength(0);

    h.hostSettings.set(HARNESS_PROJECT_ID, SETTING, 'beta');
    expect(await h.gateway.requestJson(request())).toMatchObject({ ok: true, profileName: 'beta' });
    expect(await h.gateway.requestJson(request({ explicitProfileName: 'alpha' }))).toMatchObject({ ok: true, profileName: 'alpha' });
    expect(await h.gateway.requestJson(request({ explicitProfileName: null }))).toMatchObject({ ok: true, profileName: 'beta' });
  });

  it('reports an unknown or malformed explicit profile as no_profile without throwing', async () => {
    const h = harness();
    for (const explicitProfileName of ['missing', 'bad name!']) {
      const outcome = await h.gateway.requestJson(request({ explicitProfileName }));
      expect(outcome).toMatchObject({ ok: false, warning: { reason: 'no_profile' } });
    }
  });

  it('maps every profile-level failure to its fallback reason before any request is made', async () => {
    const endpoint = await fixture.start(completionResponse({ ok: true }));
    const h = harness({ environment: {} });
    h.createProfile({ name: 'off', endpoint, enabled: false });
    h.createProfile({ name: 'analysis-only', endpoint, capabilities: ['analysis'] });
    h.createProfile({ name: 'needs-key', endpoint });
    h.createProfile({ name: 'keyless', endpoint, apiKeyEnv: null });
    const reasonFor = async (name: string): Promise<string> => {
      const outcome = await h.gateway.requestJson(request({ explicitProfileName: name }));
      return outcome.ok ? 'ok' : outcome.warning.reason;
    };
    expect(await reasonFor('off')).toBe('profile_disabled');
    expect(await reasonFor('analysis-only')).toBe('capability_missing');
    expect(await reasonFor('needs-key')).toBe('missing_credentials');
    expect(fixture.requests).toHaveLength(0);
    expect(await reasonFor('keyless')).toBe('ok');
  });

  it('rejects an origin outside the host policy as unsafe_endpoint', async () => {
    const endpoint = await fixture.start(completionResponse({ ok: true }));
    const h = harness({ allowedOrigins: () => new Set(['http://127.0.0.1:1']) });
    h.createProfile({ name: 'gen', endpoint });
    const outcome = await h.gateway.requestJson(request({ explicitProfileName: 'gen' }));
    expect(outcome).toMatchObject({ ok: false, warning: { code: 'provider_unavailable', reason: 'unsafe_endpoint' } });
    expect(fixture.requests).toHaveLength(0);
  });

  it('maps timeouts, HTTP errors, and malformed bodies without retrying', async () => {
    const hangs = await fixture.start(() => new Promise(() => undefined));
    const failing = await fixture.start((_request, response) => {
      response.writeHead(500);
      response.end('upstream secret detail');
    });
    const garbage = await fixture.start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json');
    });
    const notJsonContent = await fixture.start(completionResponse('this is prose, not json'));
    const h = harness();
    h.createProfile({ name: 'hang', endpoint: hangs, timeoutMs: 150 });
    h.createProfile({ name: 'fail', endpoint: failing });
    h.createProfile({ name: 'garbage', endpoint: garbage });
    h.createProfile({ name: 'prose', endpoint: notJsonContent });
    const outcomes: Record<string, ProviderFallbackReason | 'ok'> = {};
    for (const name of ['hang', 'fail', 'garbage', 'prose']) {
      const outcome = await h.gateway.requestJson(request({ explicitProfileName: name }));
      outcomes[name] = outcome.ok ? 'ok' : outcome.warning.reason;
    }
    expect(outcomes).toEqual({ hang: 'timeout', fail: 'provider_error', garbage: 'invalid_response', prose: 'invalid_response' });
    expect(fixture.requests).toHaveLength(4);
  });

  it('never leaks endpoints, keys, environment names, or provider bodies in warnings', async () => {
    const failing = await fixture.start((_request, response) => {
      response.writeHead(500);
      response.end(`echo ${HARNESS_API_KEY}`);
    });
    const h = harness();
    h.createProfile({ name: 'fail', endpoint: failing });
    const outcome = await h.gateway.requestJson(request({ explicitProfileName: 'fail' }));
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(failing);
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).not.toContain(HARNESS_API_KEY);
    expect(serialized).not.toContain(HARNESS_API_KEY_ENV);
    expect(serialized).not.toContain('echo');
  });

  it('honors caller abort as a provider_error warning rather than throwing', async () => {
    const hangs = await fixture.start(() => new Promise(() => undefined));
    const h = harness();
    h.createProfile({ name: 'hang', endpoint: hangs, timeoutMs: 5_000 });
    const controller = new AbortController();
    const pending = h.gateway.requestJson(request({ explicitProfileName: 'hang', signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const outcome = await pending;
    expect(outcome).toMatchObject({ ok: false, warning: { code: 'provider_unavailable', reason: 'provider_error' } });
  });

  it('exposes the complete shared reason vocabulary', () => {
    expect([...PROVIDER_FALLBACK_REASONS].sort()).toEqual(
      ['capability_missing', 'invalid_response', 'missing_credentials', 'no_profile', 'profile_disabled', 'provider_error', 'timeout', 'unsafe_endpoint'],
    );
  });
});
