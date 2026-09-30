import { describe, expect, it } from 'vitest';
import {
  createKnowledgeBenchmarkHarness,
  loadKnowledgeBenchmarkInput,
} from './KnowledgeBenchmarkFixture.js';

describe('loadKnowledgeBenchmarkInput', () => {
  it('loads the versioned corpus and eight deterministic sources', () => {
    const input = loadKnowledgeBenchmarkInput();

    expect(input.corpus.corpusVersion).toBe('naas-v1');
    expect(input.corpus.questions.filter(({ required }) => required)).toHaveLength(10);
    expect(input.sources.map(({ path }) => path)).toEqual([
      'task-managers/configlet.py',
      'task-managers/deployment.py',
      'task-managers/device.py',
      'task-managers/gnmi.py',
      'task-managers/pytest_bootstrap.py',
      'task-managers/remote_access.py',
      'task-managers/topology.py',
      'task-managers/use_case.py',
    ]);
    expect(input.sourceBytes).toBeGreaterThan(0);
    expect(input.corpusDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns fresh arrays while preserving the same digest', () => {
    const first = loadKnowledgeBenchmarkInput();
    const second = loadKnowledgeBenchmarkInput();

    expect(first).not.toBe(second);
    expect(first.sources).not.toBe(second.sources);
    expect(first.corpusDigest).toBe(second.corpusDigest);
  });
});

describe('createKnowledgeBenchmarkHarness', () => {
  it('seeds one current version and one queued job per source', () => {
    const harness = createKnowledgeBenchmarkHarness();
    try {
      expect(harness.seedInitialSources()).toEqual({ queuedJobCount: 8 });
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge_sources source
         JOIN knowledge_source_versions version
           ON version.project_id = source.project_id
          AND version.source_id = source.id
          AND version.content_hash = source.current_hash
         WHERE source.project_id = ?`,
      ).get(harness.projectId)).toEqual({ count: 8 });
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_jobs
         WHERE project_id = ? AND status = 'queued'`,
      ).get(harness.projectId)).toEqual({ count: 8 });
    } finally {
      harness.cleanup();
    }
  });

  it('creates exactly one incremental version and queues one job', async () => {
    const harness = createKnowledgeBenchmarkHarness();
    try {
      harness.seedInitialSources();
      await harness.runWorker('fixture-initial');
      const update = harness.applyIncrementalUpdate();
      expect(update.sourcePath).toBe('task-managers/configlet.py');
      expect(update.sourceVersionId).toMatch(/^source-version_/);
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_source_versions
         WHERE project_id = ? AND source_id = (
           SELECT id FROM knowledge_sources
           WHERE project_id = ? AND source_path = ?
         )`,
      ).get(harness.projectId, harness.projectId, update.sourcePath)).toEqual({ count: 2 });
      expect(harness.db.prepare(
        `SELECT COUNT(*) AS count FROM knowledge_jobs
         WHERE project_id = ? AND status = 'queued'`,
      ).get(harness.projectId)).toEqual({ count: 1 });
    } finally {
      harness.cleanup();
    }
  });
});
