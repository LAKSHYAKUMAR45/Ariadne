import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { exportKnowledgeProject } from '../../src/knowledge/KnowledgeArchive.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';
import {
  KnowledgeProviderProfileStore,
  type KnowledgeProviderCredentialPolicy,
  type KnowledgeProviderProfile,
  type KnowledgeProviderProfileTestAdapter,
} from '../../src/knowledge/KnowledgeProviderProfiles.js';

const CREATED_AT = '2026-09-28T00:00:00.000Z';
const DEFAULT_API_KEY_ENV = 'ARIADNE_KNOWLEDGE_PROVIDER_DEFAULT_KEY';

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
    options: {
      adapter?: KnowledgeProviderProfileTestAdapter;
      credentialPolicy?: KnowledgeProviderCredentialPolicy;
    } = {},
  ): KnowledgeProviderProfileStore {
    return new KnowledgeProviderProfileStore(db, {
      now: () => CREATED_AT,
      ...options,
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
      apiKeyEnv: overrides.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      enabled: overrides.enabled ?? false,
    });
  }

  it('accepts loopback HTTP endpoints, stores environment-variable names only, and never resolves secret values when listing', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    const secretEnvironment = { [DEFAULT_API_KEY_ENV]: 'sk-live-secret-value' } as NodeJS.ProcessEnv;

    const profile = createProfile(store, projectId, {
      profileName: 'Loopback',
      endpoint: 'http://127.0.0.1:11434/v1/',
      apiKeyEnv: DEFAULT_API_KEY_ENV,
    });

    expect(profile).toMatchObject({
      projectId,
      providerKind: 'openai-compatible',
      profileName: 'Loopback',
      endpoint: 'http://127.0.0.1:11434/v1',
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      enabled: false,
    });

    expect(store.get(projectId, 'loopback')).toEqual(profile);
    expect(store.list(projectId)).toEqual([profile]);
    expect(JSON.stringify(store.list(projectId))).toContain(DEFAULT_API_KEY_ENV);
    expect(JSON.stringify(store.list(projectId))).not.toContain(secretEnvironment[DEFAULT_API_KEY_ENV]);
  });

  it('rejects unsafe endpoints, out-of-bounds configuration, mapped loopback targets, and duplicate project-local profile names', () => {
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
      createProfile(store, projectId, { profileName: 'bad-http-localhost', endpoint: 'http://localhost:11434/v1' }),
    ).toThrow(/loopback ip literals/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-loopback', endpoint: 'https://127.0.0.1/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-unspecified', endpoint: 'https://0.0.0.0/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-mapped-loopback', endpoint: 'https://[::ffff:127.0.0.1]/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-embedded-loopback', endpoint: 'https://[::127.0.0.1]/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-nat64-metadata', endpoint: 'https://[64:ff9b::a9fe:a9fe]/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-https-nat64-local-metadata', endpoint: 'https://[64:ff9b:1::a9fe:a9fe]/v1' }),
    ).toThrow(/private ip|localhost/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-creds', endpoint: 'http://user:pass@example.com/v1?token=secret#frag' }),
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
      createProfile(store, projectId, { profileName: 'bad-env-format', apiKeyEnv: 'sk-live-value' }),
    ).toThrow(/environment/i);
    expect(() =>
      createProfile(store, projectId, { profileName: 'bad-env-prefix', apiKeyEnv: 'DATABASE_URL' }),
    ).toThrow(/ARIADNE_KNOWLEDGE_PROVIDER_/i);

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

  it('keeps previously persisted safe env-variable names readable while enforcing the new prefix on new writes', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, 'openai-compatible', 'legacy-safe', ?, ?, ?)`,
    ).run(
      'provider_legacy_safe',
      projectId,
      JSON.stringify({
        endpoint: 'http://127.0.0.1:11434/v1',
        model: 'gpt-4.1-mini',
        capabilities: ['analysis'],
        timeoutMs: 10_000,
        apiKeyEnv: 'ARIADNE_PROVIDER_API_KEY',
        enabled: true,
      }),
      CREATED_AT,
      CREATED_AT,
    );

    expect(store.get(projectId, 'legacy-safe')).toMatchObject({
      profileName: 'legacy-safe',
      apiKeyEnv: 'ARIADNE_PROVIDER_API_KEY',
      enabled: true,
    });
    expect(store.selectEnabledProfile(projectId, 'analysis')).toMatchObject({
      profileName: 'legacy-safe',
    });
  });

  it('quarantines unsafe legacy env names before resolver callbacks and requires exact legacy allowlisting', async () => {
    const db = database();
    const projectId = createProject(db);
    const resolverCalls: string[] = [];
    const adapterEnvironmentKeys: string[][] = [];
    const seenApiKeys: Array<string | null> = [];
    const accessed: string[] = [];
    const env = new Proxy(
      {
        DATABASE_URL: 'postgres://secret',
        OPENAI_API_KEY: 'sk-live-legacy-value',
      },
      {
        get(target, property, receiver) {
          if (typeof property === 'string') {
            accessed.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as NodeJS.ProcessEnv;
    const store = createStore(db, {
      adapter: {
        async testProfile({ apiKey, environment }) {
          seenApiKeys.push(apiKey);
          adapterEnvironmentKeys.push(Object.keys(environment).sort());
          return { success: true };
        },
      },
      credentialPolicy: {
        allowedEnvironmentVariables: new Set(['DATABASE_URL', 'OPENAI_API_KEY']),
        allowedLegacyEnvironmentVariables: new Set(['OPENAI_API_KEY']),
        resolveApiKey({ envName, environment }) {
          resolverCalls.push(envName);
          return environment[envName] ?? null;
        },
      },
    });
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, 'openai-compatible', ?, ?, ?, ?)`,
    ).run(
      'provider_legacy_unsafe',
      projectId,
      'legacy-unsafe',
      JSON.stringify({
        endpoint: 'https://api.example.com/v1',
        model: 'gpt-4.1-mini',
        capabilities: ['analysis'],
        timeoutMs: 10_000,
        apiKeyEnv: 'DATABASE_URL',
        enabled: true,
      }),
      CREATED_AT,
      CREATED_AT,
    );
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, 'openai-compatible', ?, ?, ?, ?)`,
    ).run(
      'provider_legacy_allowlisted',
      projectId,
      'legacy-allowlisted',
      JSON.stringify({
        endpoint: 'https://api.example.com/v1',
        model: 'gpt-4.1-mini',
        capabilities: ['analysis'],
        timeoutMs: 10_000,
        apiKeyEnv: 'OPENAI_API_KEY',
        enabled: true,
      }),
      CREATED_AT,
      CREATED_AT,
    );

    const unsafe = await store.test(projectId, 'legacy-unsafe', env);
    expect(resolverCalls).toEqual([]);
    expect(seenApiKeys).toEqual([null]);
    expect(adapterEnvironmentKeys).toEqual([[]]);
    expect(unsafe.warnings).toEqual([
      expect.objectContaining({
        code: 'provider_api_key_not_allowed',
        message: expect.stringContaining('DATABASE_URL'),
      }),
    ]);
    expect(accessed).not.toContain('DATABASE_URL');

    resolverCalls.length = 0;
    accessed.length = 0;
    const allowlisted = await store.test(projectId, 'legacy-allowlisted', env);
    expect(resolverCalls).toEqual(['OPENAI_API_KEY']);
    expect(seenApiKeys).toEqual([null, 'sk-live-legacy-value']);
    expect(adapterEnvironmentKeys).toEqual([[], ['OPENAI_API_KEY']]);
    expect(allowlisted.warnings).toEqual([]);
    expect(accessed).toContain('OPENAI_API_KEY');
    expect(accessed).not.toContain('DATABASE_URL');

    const directReadApiKeys: Array<string | null> = [];
    const directReadStore = createStore(db, {
      adapter: {
        async testProfile({ apiKey }) {
          directReadApiKeys.push(apiKey);
          return { success: true };
        },
      },
      credentialPolicy: {
        allowedLegacyEnvironmentVariables: new Set(['OPENAI_API_KEY']),
      },
    });
    const directRead = await directReadStore.test(projectId, 'legacy-allowlisted', env);
    expect(directReadApiKeys).toEqual(['sk-live-legacy-value']);
    expect(directRead.warnings).toEqual([]);
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
    expect(String(archive.files['data/knowledge_provider_profiles.json'])).not.toContain(DEFAULT_API_KEY_ENV);
    expect(archive.manifest.omitted).toContain('knowledge_provider_profiles.configuration_json');
  });

  it('denies unapproved environment-variable names without reading them and resolves approved names through host policy only', async () => {
    const db = database();
    const projectId = createProject(db);
    const accessed: string[] = [];
    let seenApiKey: string | null = null;
    let adapterEnvironmentKeys: string[] = [];
    const env = new Proxy(
      {
        ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_KEY: 'sk-live-approved-value',
        ARIADNE_KNOWLEDGE_PROVIDER_UNAPPROVED_KEY: 'sk-live-unapproved-value',
        DATABASE_URL: 'postgres://secret',
      },
      {
        get(target, property, receiver) {
          if (typeof property === 'string') {
            accessed.push(property);
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as NodeJS.ProcessEnv;
    const store = createStore(db, {
      adapter: {
        async testProfile({ apiKey, environment }) {
          seenApiKey = apiKey;
          adapterEnvironmentKeys = Object.keys(environment).sort();
          return { success: true };
        },
      },
      credentialPolicy: {
        allowedEnvironmentVariables: new Set(['ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_KEY']),
      },
    });
    createProfile(store, projectId, {
      profileName: 'approved',
      apiKeyEnv: 'ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_KEY',
      enabled: true,
    });
    createProfile(store, projectId, {
      profileName: 'unapproved',
      apiKeyEnv: 'ARIADNE_KNOWLEDGE_PROVIDER_UNAPPROVED_KEY',
      enabled: true,
    });

    const approved = await store.test(projectId, 'approved', env);
    expect(seenApiKey).toBe('sk-live-approved-value');
    expect(approved.warnings).toEqual([]);
    expect(accessed).toContain('ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_KEY');
    expect(adapterEnvironmentKeys).toEqual(['ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_KEY']);

    accessed.length = 0;
    seenApiKey = null;
    adapterEnvironmentKeys = [];
    const unapproved = await store.test(projectId, 'unapproved', env);
    expect(seenApiKey).toBeNull();
    expect(unapproved.warnings).toEqual([
      expect.objectContaining({
        code: 'provider_api_key_not_allowed',
        message: expect.stringContaining('ARIADNE_KNOWLEDGE_PROVIDER_UNAPPROVED_KEY'),
      }),
    ]);
    expect(accessed).not.toContain('ARIADNE_KNOWLEDGE_PROVIDER_UNAPPROVED_KEY');
    expect(accessed).not.toContain('DATABASE_URL');
    expect(adapterEnvironmentKeys).toEqual([]);
    expect(JSON.stringify(unapproved)).not.toContain('sk-live-unapproved-value');
    expect(JSON.stringify(unapproved)).not.toContain('postgres://secret');
  });

  it('tests profiles with injected environment and redacts bounded diagnostics', async () => {
    const db = database();
    const projectId = createProject(db);
    let seenApiKey: string | null = null;
    const store = createStore(db, {
      adapter: {
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
      },
      credentialPolicy: {
        allowedEnvironmentVariables: new Set(['ARIADNE_KNOWLEDGE_PROVIDER_TEST_KEY']),
      },
    });
    createProfile(store, projectId, {
      profileName: 'testable',
      apiKeyEnv: 'ARIADNE_KNOWLEDGE_PROVIDER_TEST_KEY',
      enabled: true,
    });

    const result = await store.test(projectId, 'testable', {
      ARIADNE_KNOWLEDGE_PROVIDER_TEST_KEY: 'sk-live-sensitive-value',
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

  it('skips unsupported legacy rows and malformed persisted config with bounded redacted diagnostics', () => {
    const db = database();
    const projectId = createProject(db);
    const store = createStore(db);
    const valid = createProfile(store, projectId, {
      profileName: 'valid',
      enabled: true,
    });
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, 'remote', 'legacy-remote', ?, ?, ?)`,
    ).run(
      'provider_legacy_remote',
      projectId,
      '{"endpoint":"https://example.com/v1","apiKey":"sk-live-secret-value"}',
      CREATED_AT,
      CREATED_AT,
    );
    db.prepare(
      `INSERT INTO knowledge_provider_profiles
       (id, project_id, provider_kind, profile_name, configuration_json, created_at, updated_at)
       VALUES (?, ?, 'openai-compatible', 'legacy-malformed', ?, ?, ?)`,
    ).run(
      'provider_legacy_malformed',
      projectId,
      '{"endpoint":123,"model":false,"capabilities":[],"timeoutMs":"1000","apiKeyEnv":{"oops":true},"enabled":"yes"}',
      CREATED_AT,
      CREATED_AT,
    );

    const listed = store.listWithDiagnostics(projectId);

    expect(listed.profiles).toEqual([valid]);
    expect(store.get(projectId, 'legacy-remote')).toBeNull();
    expect(store.get(projectId, 'legacy-malformed')).toBeNull();
    expect(store.selectEnabledProfile(projectId, 'analysis')).toEqual(valid);
    expect(listed.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_profile_legacy_unsupported' }),
        expect.objectContaining({ code: 'provider_profile_invalid' }),
      ]),
    );
    expect(JSON.stringify(listed.warnings)).not.toContain('sk-live-secret-value');
    expect(JSON.stringify(listed.warnings)).not.toContain('trim is not a function');
    expect(JSON.stringify(listed.warnings)).not.toContain('String(');
    expect((listed.warnings[0]?.message.length ?? 0) <= 280).toBe(true);
    expect((listed.warnings[1]?.message.length ?? 0) <= 280).toBe(true);
  });
});
