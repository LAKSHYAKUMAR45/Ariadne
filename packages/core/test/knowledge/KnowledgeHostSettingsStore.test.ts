import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  KNOWLEDGE_HOST_SETTING_KEYS,
  KNOWLEDGE_WORKER_CONCURRENCY_DEFAULT,
  KNOWLEDGE_WORKER_CONCURRENCY_MAX,
  KnowledgeHostSettingsStore,
  KnowledgeSearchSettingsStore,
  KnowledgeWorkerSettingsStore,
  resolveKnowledgeSemanticRetrieval,
  resolveKnowledgeWorkerConcurrency,
} from '../../src/knowledge/KnowledgeHostSettingsStore.js';

const PROJECT_A = 'project_a';
const PROJECT_B = 'project_b';
const NOW = '2026-09-29T00:00:00.000Z';

describe('KnowledgeHostSettingsStore', () => {
  let db: Database.Database;
  let store: KnowledgeHostSettingsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, `/tmp/${projectId}`, projectId, NOW, NOW);
    }
    store = new KnowledgeHostSettingsStore(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  function rawValue(projectId: string, key: string): string | undefined {
    return (
      db.prepare('SELECT setting_value FROM knowledge_settings WHERE project_id = ? AND setting_key = ?').get(projectId, key) as
        | { setting_value: string }
        | undefined
    )?.setting_value;
  }

  it('returns null for unset keys and round-trips set/delete per project', () => {
    expect(store.get(PROJECT_A, 'host.worker.concurrency')).toBeNull();

    store.set(PROJECT_A, 'host.worker.concurrency', '3');

    expect(store.get(PROJECT_A, 'host.worker.concurrency')).toBe('3');
    expect(store.get(PROJECT_B, 'host.worker.concurrency')).toBeNull();
    expect(store.delete(PROJECT_A, 'host.worker.concurrency')).toBe(true);
    expect(store.delete(PROJECT_A, 'host.worker.concurrency')).toBe(false);
    expect(store.get(PROJECT_A, 'host.worker.concurrency')).toBeNull();
  });

  it('overwrites an existing value in place and keeps one row per key', () => {
    store.set(PROJECT_A, 'host.worker.concurrency', '2');
    store.set(PROJECT_A, 'host.worker.concurrency', '5');

    expect(rawValue(PROJECT_A, 'host.worker.concurrency')).toBe('5');
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_settings').get()).toEqual({ count: 1 });
  });

  it('rejects unknown host. keys and non-host keys on every operation without echoing the key', () => {
    for (const key of ['host.unknown.thing', 'host.', 'portable.theme', '']) {
      expect(() => store.get(PROJECT_A, key)).toThrow(/unknown host setting key/i);
      expect(() => store.set(PROJECT_A, key, '1')).toThrow(/unknown host setting key/i);
      expect(() => store.delete(PROJECT_A, key)).toThrow(/unknown host setting key/i);
    }
    try {
      store.set(PROJECT_A, 'host.secret.leak', 'x');
    } catch (error) {
      expect((error as Error).message).not.toContain('host.secret.leak');
    }
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_settings').get()).toEqual({ count: 0 });
  });

  it('rejects unknown projects and blank project ids', () => {
    expect(() => store.set('missing', 'host.worker.concurrency', '2')).toThrow(/project not found/i);
    expect(() => store.get('  ', 'host.worker.concurrency')).toThrow(/project ID must not be empty/i);
  });

  it.each(['0', '9', '-1', '1.5', '01', ' 2', '', 'abc', '1e1', '2 '])('rejects invalid concurrency value %j on write without echoing it', (value) => {
    let message = '';
    try {
      store.set(PROJECT_A, 'host.worker.concurrency', value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/invalid value for host setting host\.worker\.concurrency/i);
    if (value.length > 0) {
      expect(message).not.toContain(`"${value}"`);
    }
    expect(rawValue(PROJECT_A, 'host.worker.concurrency')).toBeUndefined();
  });

  it('fails fast when an invalid value is already stored', () => {
    db.prepare(
      `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
       VALUES ('s1', ?, 'host.worker.concurrency', '99', ?, ?)`,
    ).run(PROJECT_A, NOW, NOW);

    let message = '';
    try {
      store.get(PROJECT_A, 'host.worker.concurrency');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/invalid stored value/i);
    expect(message).not.toContain('99');
  });

  it('validates the boolean, salt, and profile-name registry entries', () => {
    store.set(PROJECT_A, 'host.search.hybrid.enabled', 'true');
    store.set(PROJECT_A, 'host.analytics.enabled', 'false');
    store.set(PROJECT_A, 'host.analytics.salt', 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    store.set(PROJECT_A, 'host.provider.synthesis_profile', 'local-llm');
    store.set(PROJECT_A, 'host.provider.summary_profile', 'summary.v2');

    expect(() => store.set(PROJECT_A, 'host.search.hybrid.enabled', 'yes')).toThrow(/invalid value/i);
    expect(() => store.set(PROJECT_A, 'host.analytics.enabled', '1')).toThrow(/invalid value/i);
    expect(() => store.set(PROJECT_A, 'host.analytics.salt', 'not hex!')).toThrow(/invalid value/i);
    expect(() => store.set(PROJECT_A, 'host.provider.synthesis_profile', '-bad name-')).toThrow(/invalid value/i);
    expect(Object.keys(KNOWLEDGE_HOST_SETTING_KEYS).sort()).toEqual([
      'analyticsEnabled',
      'analyticsSalt',
      'hybridSearchEnabled',
      'providerSummaryProfile',
      'providerSynthesisProfile',
      'workerConcurrency',
    ]);
  });

  it('cascades host settings away with the project without touching other projects', () => {
    store.set(PROJECT_A, 'host.worker.concurrency', '2');
    store.set(PROJECT_B, 'host.worker.concurrency', '4');

    db.prepare('DELETE FROM knowledge_projects WHERE id = ?').run(PROJECT_A);

    expect(store.get(PROJECT_B, 'host.worker.concurrency')).toBe('4');
  });
});

describe('KnowledgeWorkerSettingsStore and concurrency resolution', () => {
  let db: Database.Database;
  let settings: KnowledgeWorkerSettingsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, `/tmp/${projectId}`, projectId, NOW, NOW);
    }
    settings = new KnowledgeWorkerSettingsStore(new KnowledgeHostSettingsStore(db, { now: () => NOW }));
  });

  afterEach(() => db.close());

  it('stores concurrency per project as a typed integer and treats unset as null', () => {
    expect(settings.getConcurrency(PROJECT_A)).toBeNull();

    settings.setConcurrency(PROJECT_A, 4);

    expect(settings.getConcurrency(PROJECT_A)).toBe(4);
    expect(settings.getConcurrency(PROJECT_B)).toBeNull();
    expect(db.prepare("SELECT setting_value FROM knowledge_settings WHERE setting_key = 'host.worker.concurrency'").get()).toEqual({
      setting_value: '4',
    });
  });

  it.each([0, 9, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects non-integer or out-of-range concurrency %s without clamping', (value) => {
    expect(() => settings.setConcurrency(PROJECT_A, value)).toThrow(/concurrency must be an integer between 1 and 8/i);
    expect(settings.getConcurrency(PROJECT_A)).toBeNull();
  });

  it('resolves override before host setting before the default and reports the source', () => {
    expect(resolveKnowledgeWorkerConcurrency(settings, PROJECT_A)).toEqual({
      value: KNOWLEDGE_WORKER_CONCURRENCY_DEFAULT,
      source: 'default',
    });

    settings.setConcurrency(PROJECT_A, 3);

    expect(resolveKnowledgeWorkerConcurrency(settings, PROJECT_A)).toEqual({ value: 3, source: 'host-setting' });
    expect(resolveKnowledgeWorkerConcurrency(settings, PROJECT_B)).toEqual({ value: 1, source: 'default' });
    expect(resolveKnowledgeWorkerConcurrency(settings, PROJECT_A, KNOWLEDGE_WORKER_CONCURRENCY_MAX)).toEqual({
      value: 8,
      source: 'override',
    });
  });

  it('rejects an invalid override before reading the host setting', () => {
    expect(() => resolveKnowledgeWorkerConcurrency(settings, PROJECT_A, 0)).toThrow(/concurrency must be an integer between 1 and 8/i);
    expect(() => resolveKnowledgeWorkerConcurrency(settings, PROJECT_A, 9)).toThrow(/concurrency must be an integer between 1 and 8/i);
    expect(() => resolveKnowledgeWorkerConcurrency(settings, PROJECT_A, 2.5)).toThrow(/concurrency must be an integer between 1 and 8/i);
  });

  it('fails resolution when the stored value is corrupt instead of falling back to the default', () => {
    db.prepare(
      `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
       VALUES ('s1', ?, 'host.worker.concurrency', 'lots', ?, ?)`,
    ).run(PROJECT_A, NOW, NOW);

    expect(() => resolveKnowledgeWorkerConcurrency(settings, PROJECT_A)).toThrow(/invalid stored value/i);
    expect(resolveKnowledgeWorkerConcurrency(settings, PROJECT_A, 2)).toEqual({ value: 2, source: 'override' });
  });
});

describe('hybrid search enablement setting', () => {
  let db: Database.Database;
  let settings: KnowledgeSearchSettingsStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      db.prepare(
        `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`,
      ).run(projectId, `/tmp/${projectId}`, projectId, NOW, NOW);
    }
    settings = new KnowledgeSearchSettingsStore(new KnowledgeHostSettingsStore(db, { now: () => NOW }));
  });

  afterEach(() => db.close());

  it('is off by default and only enabled explicitly per project', () => {
    expect(settings.getHybridEnabled(PROJECT_A)).toBeNull();
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A)).toEqual({ enabled: false, source: 'default' });

    settings.setHybridEnabled(PROJECT_A, true);

    expect(db.prepare('SELECT setting_value FROM knowledge_settings WHERE setting_key = ?').get(KNOWLEDGE_HOST_SETTING_KEYS.hybridSearchEnabled)).toEqual({
      setting_value: 'true',
    });
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A)).toEqual({ enabled: true, source: 'host-setting' });
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_B)).toEqual({ enabled: false, source: 'default' });
    settings.setHybridEnabled(PROJECT_A, false);
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A)).toEqual({ enabled: false, source: 'host-setting' });
    expect(settings.clearHybridEnabled(PROJECT_A)).toBe(true);
    expect(settings.getHybridEnabled(PROJECT_A)).toBeNull();
  });

  it('lets the per-call option override the setting in either direction', () => {
    settings.setHybridEnabled(PROJECT_A, true);
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A, 'off')).toEqual({ enabled: false, source: 'option' });
    settings.setHybridEnabled(PROJECT_A, false);
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A, 'if-available')).toEqual({ enabled: true, source: 'option' });
  });

  it('rejects an unknown option value and a corrupt stored value instead of clamping', () => {
    expect(() => resolveKnowledgeSemanticRetrieval(settings, PROJECT_A, 'always' as never)).toThrow(/semanticRetrieval/);
    db.prepare(
      `INSERT INTO knowledge_settings (id, project_id, setting_key, setting_value, created_at, updated_at)
       VALUES ('s1', ?, 'host.search.hybrid.enabled', 'maybe', ?, ?)`,
    ).run(PROJECT_A, NOW, NOW);

    expect(() => resolveKnowledgeSemanticRetrieval(settings, PROJECT_A)).toThrow(/invalid stored value/i);
    expect(resolveKnowledgeSemanticRetrieval(settings, PROJECT_A, 'off')).toEqual({ enabled: false, source: 'option' });
  });
});
