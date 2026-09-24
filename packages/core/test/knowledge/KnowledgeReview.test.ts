import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  bulkResolveKnowledgeReviews,
  createKnowledgeReview,
  listKnowledgeReviews,
  reopenKnowledgeReview,
  resolveKnowledgeReview,
} from '../../src/knowledge/KnowledgeReview.js';
import { SCHEMA_SQL } from '../../src/schema.js';

const CREATED_AT = '2026-09-24T00:00:00.000Z';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES ('project-1', '/workspace', 'Workspace', ?, ?)`,
  ).run(CREATED_AT, CREATED_AT);
  return db;
}

describe('KnowledgeReview', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it('creates and lists pending reviews in request order', () => {
    const db = createDatabase();
    databases.push(db);

    const first = createKnowledgeReview(db, {
      projectId: 'project-1',
      summary: 'Review generated architecture summary',
      requestedAt: '2026-09-24T01:00:00.000Z',
    });
    createKnowledgeReview(db, {
      projectId: 'project-1',
      summary: 'Review source attribution',
      requestedAt: '2026-09-24T02:00:00.000Z',
    });

    expect(first).toMatchObject({
      projectId: 'project-1',
      status: 'pending',
      summary: 'Review generated architecture summary',
      requestedAt: '2026-09-24T01:00:00.000Z',
      reviewedAt: null,
      reviewerId: null,
    });
    expect(listKnowledgeReviews(db, 'project-1')).toMatchObject([
      { summary: 'Review generated architecture summary', status: 'pending' },
      { summary: 'Review source attribution', status: 'pending' },
    ]);
  });

  it('requires an allowlisted action and evidence before resolving a review', () => {
    const db = createDatabase();
    databases.push(db);
    const review = createKnowledgeReview(db, {
      projectId: 'project-1',
      summary: 'Review a generated conclusion',
    });

    expect(() =>
      resolveKnowledgeReview(db, review.id, {
        action: 'run_command' as never,
        actorId: 'reviewer-1',
        source: 'human',
        evidence: { kind: 'source', id: 'source-1' },
      }),
    ).toThrow('Unsupported knowledge review action: run_command');
    expect(() =>
      resolveKnowledgeReview(db, review.id, {
        action: 'accept',
        actorId: 'reviewer-1',
        source: 'human',
      }),
    ).toThrow('Knowledge review evidence is required');

    const resolved = resolveKnowledgeReview(db, review.id, {
      action: 'accept',
      actorId: 'reviewer-1',
      source: 'human',
      evidence: { kind: 'source', id: 'source-1', detail: 'Verified against source passage' },
      comment: 'The conclusion matches the cited source.',
      reviewedAt: '2026-09-24T03:00:00.000Z',
    });

    expect(resolved).toMatchObject({
      id: review.id,
      status: 'approved',
      reviewerId: 'reviewer-1',
      reviewedAt: '2026-09-24T03:00:00.000Z',
    });
    expect(
      db.prepare(
        `SELECT action_kind, comment FROM knowledge_review_actions WHERE review_id = ?`,
      ).get(review.id),
    ).toEqual({
      action_kind: 'accept',
      comment: JSON.stringify({
        actorId: 'reviewer-1',
        source: 'human',
        evidence: { kind: 'source', id: 'source-1', detail: 'Verified against source passage' },
        comment: 'The conclusion matches the cited source.',
      }),
    });
  });

  it('resolves reviews in bulk, skips non-pending reviews, and can reopen a resolved review', () => {
    const db = createDatabase();
    databases.push(db);
    const pending = createKnowledgeReview(db, { projectId: 'project-1', summary: 'Pending review' });
    const alreadyResolved = createKnowledgeReview(db, { projectId: 'project-1', summary: 'Resolved review' });
    resolveKnowledgeReview(db, alreadyResolved.id, {
      action: 'reject',
      actorId: 'reviewer-1',
      source: 'human',
      evidence: { kind: 'source', id: 'source-1' },
    });

    const bulk = bulkResolveKnowledgeReviews(db, [pending.id, alreadyResolved.id], {
      action: 'skip',
      actorId: 'reviewer-2',
      source: 'bulk-review',
      evidence: { kind: 'policy', id: 'policy-1' },
    });

    expect(bulk).toEqual({
      resolvedIds: [pending.id],
      skippedIds: [alreadyResolved.id],
    });
    expect(reopenKnowledgeReview(db, pending.id, {
      actorId: 'reviewer-3',
      source: 'quality-audit',
      comment: 'New supporting source requires another review.',
    })).toMatchObject({
      id: pending.id,
      status: 'pending',
      reviewedAt: null,
      reviewerId: null,
    });
    expect(
      db.prepare(
        `SELECT action_kind, comment FROM knowledge_review_actions WHERE review_id = ? ORDER BY rowid`,
      ).all(pending.id),
    ).toEqual([
      {
        action_kind: 'skip',
        comment: JSON.stringify({
          actorId: 'reviewer-2',
          source: 'bulk-review',
          evidence: { kind: 'policy', id: 'policy-1' },
        }),
      },
      {
        action_kind: 'reopen',
        comment: JSON.stringify({
          actorId: 'reviewer-3',
          source: 'quality-audit',
          comment: 'New supporting source requires another review.',
        }),
      },
    ]);
  });
});
