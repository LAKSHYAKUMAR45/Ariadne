import type Database from 'better-sqlite3';
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

export { KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

/**
 * Creates the additive knowledge schema atomically. It is idempotent so it
 * can be called safely by the shared migration runner on every database open.
 */
export function applyKnowledgeMigrations(db: Database.Database): void {
  db.transaction(() => {
    db.exec(KNOWLEDGE_SCHEMA_SQL);
  })();
}
