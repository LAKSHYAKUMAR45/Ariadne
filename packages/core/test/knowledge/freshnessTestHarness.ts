import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';

export interface FreshnessHarness {
  db: Database.Database;
  queue: KnowledgeQueue;
  workspaces: string[];
  createProject(id: string, options?: { roots?: string[] }): { id: string; workspaceRoot: string };
  writeFile(workspaceRoot: string, relativePath: string, content: string): void;
  cleanup(): void;
}

export function createFreshnessHarness(now: () => string = () => new Date().toISOString()): FreshnessHarness {
  const db = openDatabase(':memory:');
  const queue = new KnowledgeQueue(db, { now, leaseDurationMs: 60_000 });
  const workspaces: string[] = [];
  return {
    db,
    queue,
    workspaces,
    createProject(id, options = {}) {
      const workspaceRoot = mkdtempSync(join(process.cwd(), '.test-freshness-'));
      workspaces.push(workspaceRoot);
      new KnowledgeProjectStore(db).create({ id: id as never, workspaceRoot, name: id, roots: options.roots });
      return { id, workspaceRoot };
    },
    writeFile(workspaceRoot, relativePath, content) {
      const absolutePath = join(workspaceRoot, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    },
    cleanup() {
      db.close();
      for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
    },
  };
}
