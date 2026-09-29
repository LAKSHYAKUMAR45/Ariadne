import type Database from 'better-sqlite3';

/**
 * Invalidates a project's local semantic model. The active model becomes stale (never used at query time) and a
 * running rebuild loses its lease, which is how the builder learns at swap time that the index changed under it.
 * It only issues statements, so it participates in whatever transaction the caller already holds.
 */
export function markLocalSemanticModelStale(db: Database.Database, projectId: string, timestamp: string): void {
  db.prepare(
    `UPDATE knowledge_search_semantic_models
     SET status = 'stale', updated_at = ?
     WHERE project_id = ? AND status = 'active'`,
  ).run(timestamp, projectId);
  db.prepare(
    `UPDATE knowledge_search_semantic_models
     SET lease_expires_at = NULL, updated_at = ?
     WHERE project_id = ? AND status = 'building' AND lease_expires_at IS NOT NULL`,
  ).run(timestamp, projectId);
}
