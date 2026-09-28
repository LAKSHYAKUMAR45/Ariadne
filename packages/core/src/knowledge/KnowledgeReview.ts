import type Database from 'better-sqlite3';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgeReviewId, KnowledgeReviewStatus } from './KnowledgeTypes.js';

export const KNOWLEDGE_REVIEW_ACTIONS = [
  'accept',
  'reject',
  'edit',
  'merge',
  'skip',
  'research',
  'create_task',
  'label',
] as const;

export type KnowledgeReviewAction = (typeof KNOWLEDGE_REVIEW_ACTIONS)[number];

export interface KnowledgeReviewEvidence {
  kind: string;
  id: string;
  detail?: string;
}

export interface KnowledgeReviewRecord {
  id: KnowledgeReviewId;
  projectId: string;
  pageVersionId: string | null;
  status: KnowledgeReviewStatus;
  requestedAt: string;
  reviewedAt: string | null;
  reviewerId: string | null;
  summary: string | null;
}

export interface CreateKnowledgeReviewInput {
  projectId: string;
  pageVersionId?: string;
  summary?: string;
  requestedAt?: string;
}

export interface EnsurePendingKnowledgeReviewInput {
  projectId: string;
  pageVersionId?: string;
  summary: string;
  requestedAt?: string;
}

export interface ListKnowledgeReviewsOptions {
  status?: KnowledgeReviewStatus;
  limit?: number;
}

export interface ResolveKnowledgeReviewInput {
  action: KnowledgeReviewAction;
  actorId: string;
  source: string;
  evidence?: KnowledgeReviewEvidence;
  comment?: string;
  reviewedAt?: string;
}

export interface ReopenKnowledgeReviewInput {
  actorId: string;
  source: string;
  comment?: string;
  requestedAt?: string;
}

export interface BulkResolveKnowledgeReviewsResult {
  resolvedIds: KnowledgeReviewId[];
  skippedIds: KnowledgeReviewId[];
}

interface KnowledgeReviewRow {
  id: string;
  project_id: string;
  page_version_id: string | null;
  status: KnowledgeReviewStatus;
  requested_at: string;
  reviewed_at: string | null;
  reviewer_id: string | null;
  summary: string | null;
}

const REVIEW_ACTIONS = new Set<string>(KNOWLEDGE_REVIEW_ACTIONS);
const REVIEW_STATUSES = new Set<KnowledgeReviewStatus>(['pending', 'approved', 'rejected', 'dismissed']);

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Knowledge review ${label} must not be empty`);
  }
}

function assertReviewAction(action: string): asserts action is KnowledgeReviewAction {
  if (!REVIEW_ACTIONS.has(action)) {
    throw new Error(`Unsupported knowledge review action: ${action}`);
  }
}

function validateEvidence(evidence: KnowledgeReviewEvidence | undefined): asserts evidence is KnowledgeReviewEvidence {
  if (evidence === undefined) {
    throw new Error('Knowledge review evidence is required');
  }
  requireNonEmpty(evidence.kind, 'evidence kind');
  requireNonEmpty(evidence.id, 'evidence ID');
  if (evidence.detail !== undefined) {
    requireNonEmpty(evidence.detail, 'evidence detail');
  }
}

function rowToKnowledgeReview(row: KnowledgeReviewRow): KnowledgeReviewRecord {
  return {
    id: row.id as KnowledgeReviewId,
    projectId: row.project_id,
    pageVersionId: row.page_version_id,
    status: row.status,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    reviewerId: row.reviewer_id,
    summary: row.summary,
  };
}

function resolutionStatus(action: KnowledgeReviewAction): Exclude<KnowledgeReviewStatus, 'pending'> {
  switch (action) {
    case 'accept':
    case 'edit':
    case 'merge':
    case 'label':
      return 'approved';
    case 'reject':
      return 'rejected';
    case 'skip':
    case 'research':
    case 'create_task':
      return 'dismissed';
  }
}

function requireReview(db: Database.Database, reviewId: string): KnowledgeReviewRecord {
  const row = db.prepare('SELECT * FROM knowledge_reviews WHERE id = ?').get(reviewId) as
    | KnowledgeReviewRow
    | undefined;
  if (row === undefined) {
    throw new Error(`Knowledge review not found: ${reviewId}`);
  }
  return rowToKnowledgeReview(row);
}

function findPendingReview(
  db: Database.Database,
  projectId: string,
  pageVersionId: string | null,
  summary: string,
): KnowledgeReviewRecord | null {
  const row = pageVersionId === null
    ? (db
        .prepare(
          `SELECT * FROM knowledge_reviews
           WHERE project_id = ? AND page_version_id IS NULL AND status = 'pending' AND summary = ?
           ORDER BY requested_at, id
           LIMIT 1`,
        )
        .get(projectId, summary) as KnowledgeReviewRow | undefined)
    : (db
        .prepare(
          `SELECT * FROM knowledge_reviews
           WHERE project_id = ? AND page_version_id = ? AND status = 'pending' AND summary = ?
           ORDER BY requested_at, id
           LIMIT 1`,
        )
        .get(projectId, pageVersionId, summary) as KnowledgeReviewRow | undefined);
  return row ? rowToKnowledgeReview(row) : null;
}

function recordReviewAction(
  db: Database.Database,
  input: {
    projectId: string;
    reviewId: string;
    action: KnowledgeReviewAction | 'reopen';
    actorId: string;
    source: string;
    evidence?: KnowledgeReviewEvidence;
    comment?: string;
    createdAt: string;
  },
): void {
  const audit = {
    actorId: input.actorId,
    source: input.source,
    ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
    ...(input.comment === undefined ? {} : { comment: input.comment }),
  };
  db.prepare(
    `INSERT INTO knowledge_review_actions
     (id, project_id, review_id, action_kind, comment, created_at)
     VALUES (@id, @projectId, @reviewId, @action, @comment, @createdAt)`,
  ).run({
    id: createKnowledgeId('review-action'),
    projectId: input.projectId,
    reviewId: input.reviewId,
    action: input.action,
    comment: JSON.stringify(audit),
    createdAt: input.createdAt,
  });
}

function resolvePendingKnowledgeReview(
  db: Database.Database,
  review: KnowledgeReviewRecord,
  input: ResolveKnowledgeReviewInput,
): KnowledgeReviewRecord {
  assertReviewAction(input.action);
  requireNonEmpty(input.actorId, 'actor ID');
  requireNonEmpty(input.source, 'source');
  validateEvidence(input.evidence);
  if (input.comment !== undefined) {
    requireNonEmpty(input.comment, 'comment');
  }
  if (review.status !== 'pending') {
    throw new Error(`Cannot resolve knowledge review ${review.id} from ${review.status} state`);
  }

  const reviewedAt = input.reviewedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE knowledge_reviews
     SET status = @status, reviewed_at = @reviewedAt, reviewer_id = @actorId
     WHERE id = @id AND status = 'pending'`,
  ).run({
    id: review.id,
    status: resolutionStatus(input.action),
    reviewedAt,
    actorId: input.actorId,
  });
  recordReviewAction(db, {
    projectId: review.projectId,
    reviewId: review.id,
    action: input.action,
    actorId: input.actorId,
    source: input.source,
    evidence: input.evidence,
    comment: input.comment,
    createdAt: reviewedAt,
  });
  return requireReview(db, review.id);
}

export function createKnowledgeReview(
  db: Database.Database,
  input: CreateKnowledgeReviewInput,
): KnowledgeReviewRecord {
  requireNonEmpty(input.projectId, 'project ID');
  if (input.pageVersionId !== undefined) {
    requireNonEmpty(input.pageVersionId, 'page version ID');
  }
  if (input.summary !== undefined) {
    requireNonEmpty(input.summary, 'summary');
  }

  const review = {
    id: createKnowledgeId('review'),
    projectId: input.projectId,
    pageVersionId: input.pageVersionId ?? null,
    summary: input.summary ?? null,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO knowledge_reviews
     (id, project_id, page_version_id, status, requested_at, summary)
     VALUES (@id, @projectId, @pageVersionId, 'pending', @requestedAt, @summary)`,
  ).run(review);
  return requireReview(db, review.id);
}

export function ensurePendingKnowledgeReview(
  db: Database.Database,
  input: EnsurePendingKnowledgeReviewInput,
): KnowledgeReviewRecord {
  requireNonEmpty(input.projectId, 'project ID');
  if (input.pageVersionId !== undefined) {
    requireNonEmpty(input.pageVersionId, 'page version ID');
  }
  requireNonEmpty(input.summary, 'summary');

  const review = {
    id: createKnowledgeId('review'),
    projectId: input.projectId,
    pageVersionId: input.pageVersionId ?? null,
    summary: input.summary,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  };
  const existing = findPendingReview(db, review.projectId, review.pageVersionId, review.summary);
  if (existing) {
    return existing;
  }
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_reviews
     (id, project_id, page_version_id, status, requested_at, summary)
     VALUES (@id, @projectId, @pageVersionId, 'pending', @requestedAt, @summary)`,
  ).run(review);
  const created = db.prepare('SELECT * FROM knowledge_reviews WHERE id = ?').get(review.id) as KnowledgeReviewRow | undefined;
  if (created) {
    return rowToKnowledgeReview(created);
  }
  const reused = findPendingReview(db, review.projectId, review.pageVersionId, review.summary);
  if (reused) {
    return reused;
  }
  throw new Error(`Knowledge review could not be created or reused: ${review.projectId}`);
}

export function listKnowledgeReviews(
  db: Database.Database,
  projectId: string,
  options: ListKnowledgeReviewsOptions = {},
): KnowledgeReviewRecord[] {
  requireNonEmpty(projectId, 'project ID');
  if (options.status !== undefined && !REVIEW_STATUSES.has(options.status)) {
    throw new Error(`Unsupported knowledge review status: ${options.status}`);
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error('Knowledge review list limit must be a positive integer');
  }

  const parameters: Record<string, string | number> = { projectId };
  const clauses = ['project_id = @projectId'];
  if (options.status !== undefined) {
    clauses.push('status = @status');
    parameters.status = options.status;
  }
  if (options.limit !== undefined) {
    parameters.limit = options.limit;
  }
  const limit = options.limit === undefined ? '' : ' LIMIT @limit';
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_reviews
       WHERE ${clauses.join(' AND ')}
       ORDER BY requested_at, id${limit}`,
    )
    .all(parameters) as KnowledgeReviewRow[];
  return rows.map(rowToKnowledgeReview);
}

export function resolveKnowledgeReview(
  db: Database.Database,
  reviewId: string,
  input: ResolveKnowledgeReviewInput,
): KnowledgeReviewRecord {
  requireNonEmpty(reviewId, 'ID');
  return db.transaction(() => resolvePendingKnowledgeReview(db, requireReview(db, reviewId), input))();
}

export function reopenKnowledgeReview(
  db: Database.Database,
  reviewId: string,
  input: ReopenKnowledgeReviewInput,
): KnowledgeReviewRecord {
  requireNonEmpty(reviewId, 'ID');
  requireNonEmpty(input.actorId, 'actor ID');
  requireNonEmpty(input.source, 'source');
  if (input.comment !== undefined) {
    requireNonEmpty(input.comment, 'comment');
  }

  return db.transaction(() => {
    const review = requireReview(db, reviewId);
    if (review.status === 'pending') {
      throw new Error(`Cannot reopen knowledge review ${review.id} from pending state`);
    }
    const requestedAt = input.requestedAt ?? new Date().toISOString();
    db.prepare(
      `UPDATE knowledge_reviews
       SET status = 'pending', requested_at = @requestedAt, reviewed_at = NULL, reviewer_id = NULL
       WHERE id = @id AND status <> 'pending'`,
    ).run({ id: review.id, requestedAt });
    recordReviewAction(db, {
      projectId: review.projectId,
      reviewId: review.id,
      action: 'reopen',
      actorId: input.actorId,
      source: input.source,
      comment: input.comment,
      createdAt: requestedAt,
    });
    return requireReview(db, review.id);
  })();
}

export function bulkResolveKnowledgeReviews(
  db: Database.Database,
  reviewIds: readonly string[],
  input: ResolveKnowledgeReviewInput,
): BulkResolveKnowledgeReviewsResult {
  assertReviewAction(input.action);
  requireNonEmpty(input.actorId, 'actor ID');
  requireNonEmpty(input.source, 'source');
  validateEvidence(input.evidence);
  if (input.comment !== undefined) {
    requireNonEmpty(input.comment, 'comment');
  }

  return db.transaction(() => {
    const resolvedIds: KnowledgeReviewId[] = [];
    const skippedIds: KnowledgeReviewId[] = [];
    const seen = new Set<string>();
    for (const reviewId of reviewIds) {
      requireNonEmpty(reviewId, 'ID');
      if (seen.has(reviewId)) continue;
      seen.add(reviewId);
      const review = requireReview(db, reviewId);
      if (review.status !== 'pending') {
        skippedIds.push(review.id);
        continue;
      }
      resolvePendingKnowledgeReview(db, review, input);
      resolvedIds.push(review.id);
    }
    return { resolvedIds, skippedIds };
  })();
}
