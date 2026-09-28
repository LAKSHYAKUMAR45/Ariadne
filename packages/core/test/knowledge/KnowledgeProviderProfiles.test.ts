import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { exportKnowledgeProject } from '../../src/knowledge/KnowledgeArchive.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';
import {
  KnowledgeProviderProfileStore,
  type KnowledgeProviderProfile,
  type KnowledgeProviderProfileTestAdapter,
} from '../../src/knowledge/KnowledgeProviderProfiles.js';

const CREATED_AT = '2026-09-28T00:00:00.000Z';

describe('KnowledgeProviderProfileStore', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  function database(): Database.Database {
    const db = openDatabase(':memory:');
    databases.push(db);
    return db;
  }

  function createProject(db: Database.Database, id = 'project-provider'): string {
    return new KnowledgeProjectStore(db).create({
      id: id as never,
      workspaceRoot: `/workspace/${id}`,
      name: id,
      roots: ['docs'],
      createdAt: CREATED_AT,
    }).id;
  }

  function createStore(
    db: Database.Database,
    adapter?: KnowledgeProviderProfileTestAdapter,
  ): KnowledgeProviderProfileStore {
    return new KnowledgeProviderProfileStore(db, {
      now: () => CREATED_AT,
      ...(adapter ? { adapter } : {}),
    });
  }

  function createProfile(
    store: KnowledgeProviderProfileStore,
    projectId: string,
    overrides: Partial<Omit<KnowledgeProviderProfile, 'id' | 'projectId' | 'providerKind'>> = {},
  ): KnowledgeProviderProfile {
    return store.create({
      projectId,
      profileName: overrides.profileName ?? 'default',
      endpoint: overrides.endpoint ?? 'http://127.0.0.1:11434/v1',
      model: overrides.model ?? 'gpt-4.1-mini',
      capabilities: overrides.capabilities ?? ['analysis'],
      timeoutMs: overrides.timeoutMs ?? 10_000,
      apiKeyEnv: overrides.apiKeyEnv ?? 'ARIADNE_PROVIDER_API_KEY',
      enabled: overrides.enabled ?? false,
    });
  }

  it('accepts loopback HTTP endpoints, stores environment-variable names only, and never resolves secret values when listing', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    const secretEnvironment = { ARIADNE_PROVIDER_API_KEY: 'sk-live-secret-value' } as NodeJS.ProcessEnv;

    const profile = createProfile(store, projectId, {
      profileName: 'Loopback',
      endpoint: 'http://127.0.0.1:11434/v1/',
      apiKeyEnv: 'ARIADNE_PROVIDER_API_KEY',
    });

    expect(profile).toMatchObject({
      projectId,
      providerKind: 'openai-compatible',
      profileName: 'Loopback',
      endpoint: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: 'ARIADNE_PROVIDER_API_KEY',
      enabled: false,
    });

    expect(store.get(projectId, 'loopback')).toEqual(profile);
    expect(store.list(projectId)).toEqual([profile]);
    expect(JSON.stringify(store.list(projectId))).toContain('ARIADNE_PROVIDER_API_KEY');
    expect(JSON.stringify(store.list(projectId))).not.toContain(secretEnvironment.ARIADNE_PROVIDER_API_KEY);
  });

  it('rejects unsafe endpoints, out-of-bounds configuration, and duplicate project-local profile names', () => {
    const db = database();
    const projectId = createProject(db);
    const otherProjectId = createProject(db, 'project-provider-2');
    const store = createStore(db);

    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-scheme', endpoint: 'ftp://127.0.0.1:11434/v1' }),
    ).toThrow(/http/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-http', endpoint: 'http://example.com/v1' }),
    ).toThrow(/loopback/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-loopback', endpoint: 'https://127.0.0.1/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-unspecified', endpoint: 'https://0.0.0.0/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-creds', endpoint: 'https://user:pass@example.com/v1?token=secret#frag' }),
    ).toThrow(/credentials|query|fragment/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-host', endpoint: 'https://-bad-host.example/v1' }),
    ).toThrow(/hostname/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'ipv6-loopback', endpoint: 'http://[::1]:11434/v1' }),
    ).not.toThrow();
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-model', model: 'x'.repeat(257) }),
    ).toThrow(/model/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-timeout', timeoutMs: 99 }),
    ).toThrow(/timeout/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-capabilities', capabilities: ['analysis', 'generation', 'analysis'] }),
    ).toThrow(/capabilities|duplicate/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-env', apiKeyEnv: 'sk-live-value' }),
    ).toThrow(/environment/i);

    createProfile(store, projectId, { profileName: 'Shared' });
    expect(() =>
      createProfile(store, projectId, { profileName: 'shared' }),
    ).toThrow(/already exists/i);
    expect(() =>
      createProfile(store, otherProjectId, { profileName: 'shared' }),
    ).not.toThrow();
  });

  it('selects only enabled profiles that advertise the requested capability', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    const disabled = createProfile(store, projectId, {
      profileName: 'disabled',
      capabilities: ['analysis'],
      enabled: false,
    });
    const enabled = store.setEnabled(projectId, disabled.profileName, true);
    createProfile(store, projectId, {
      profileName: 'generation-only',
      capabilities: ['generation'],
      enabled: true,
    });
    createProfile(store, projectId, {
      profileName: 'disabled-two',
      capabilities: ['analysis', 'generation'],
      enabled: false,
    });

    expect(store.selectEnabledProfile(projectId, 'analysis')).toEqual(enabled);
    expect(store.selectEnabledProfile(projectId, 'generation')).toMatchObject({
      profileName: 'generation-only',
    });

    store.setEnabled(projectId, 'generation-only', false);
    expect(store.selectEnabledProfile(projectId, 'generation')).toBeNull();
  });

  it('omits provider configuration from archives and never resolves environment values during export', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    createProfile(store, projectId, {
      profileName: 'archive-safe',
      capabilities: ['analysis', 'generation'],
      enabled: true,
    });

    const archive = exportKnowledgeProject(db, { projectId, generatedAt: CREATED_AT });

    expect(String(archive.files['data/knowledge_provider_profiles.json'])).toContain('archive-safe');
    expect(String(archive.files['data/knowledge_provider_profiles.json'])).not.toContain('configuration_json');
    expect(String(archive.files['data/knowledge_provider_profiles.json'])).not.toContain('ARIADNE_PROVIDER_API_KEY');
    expect(archive.manifest.omitted).toContain('knowledge_provider_profiles.configuration_json');
  });

  it('tests profiles with injected environment and redacts bounded diagnostics', async () => {
    const db = database();
    const projectId = createProject(db);
    let seenApiKey: string | null = null;
    const store = createStore(db, {
      async testProfile({ apiKey, profile }) {
        seenApiKey = apiKey;
        expect(profile.profileName).toBe('testable');
        return {
          success: false,
          warnings: [
            {
              code: 'provider_test_warning',
              message: `Authorization failed for sk-live-sensitive-value at ${profile.endpoint}`,
            },
          ],
          diagnostics: [
            `Authorization: Bearer sk-live-sensitive-value ${'x'.repeat(600)}`,
          ],
        };
      },
    });
    createProfile(store, projectId, {
      profileName: 'testable',
      apiKeyEnv: 'ARIADNE_TEST_PROVIDER_KEY',
      enabled: true,
    });

    const result = await store.test(projectId, 'testable', {
      ARIADNE_TEST_PROVIDER_KEY: 'sk-live-sensitive-value',
    });

    expect(seenApiKey).toBe('sk-live-sensitive-value');
    expect(result.success).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'provider_test_warning',
        message: expect.stringContaining('***'),
      }),
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain('***');
    expect(result.diagnostics[0]).not.toContain('sk-live-sensitive-value');
    expect(result.diagnostics[0]?.length ?? 0).toBeLessThanOrEqual(280);
  });
});
