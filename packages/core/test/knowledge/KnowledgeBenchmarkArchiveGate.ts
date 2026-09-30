import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import {
  exportKnowledgeProject,
  importKnowledgeProject,
  type KnowledgeArchive,
} from '../../src/knowledge/KnowledgeArchive.js';

const ATTACKER_COLUMN = "id) VALUES ('pwned'); --";
const MISMATCHED_PROJECT_ID = 'benchmark-archive-gate-other-project';

function tableRows(archive: KnowledgeArchive, table: string): Array<Record<string, unknown>> {
  return JSON.parse(String(archive.files[`data/${table}.json`])) as Array<Record<string, unknown>>;
}

function withTableRows(
  archive: KnowledgeArchive,
  table: string,
  rows: Array<Record<string, unknown>>,
): KnowledgeArchive {
  const filePath = `data/${table}.json`;
  const content = `${JSON.stringify(rows, null, 2)}\n`;
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const compatibility = archive.manifest.compatibility;
  return {
    manifest: {
      ...archive.manifest,
      ...(compatibility === undefined
        ? {}
        : {
            compatibility: {
              ...compatibility,
              tableFingerprints: compatibility.tableFingerprints.map((fingerprint) =>
                fingerprint.table === table ? { ...fingerprint, sha256, rowCount: rows.length } : fingerprint),
            },
          }),
      entries: archive.manifest.entries.map((entry) =>
        entry.path === filePath
          ? {
              ...entry,
              size: Buffer.byteLength(content, 'utf8'),
              sha256,
            }
          : entry,
      ),
    },
    files: { ...archive.files, [filePath]: content },
  };
}

function importFailure(
  target: Database.Database,
  archive: KnowledgeArchive,
  workspaceRoot: string,
): Error {
  try {
    importKnowledgeProject(target, archive, { workspaceRoot });
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('Archive gate expected the tampered archive import to be rejected');
}

function assertMessage(error: Error, pattern: RegExp, description: string): void {
  if (!pattern.test(error.message)) {
    throw new Error(`Archive gate expected ${description} rejection but import failed differently`);
  }
}

export function runKnowledgeBenchmarkArchiveGate(
  sourceDb: Database.Database,
  projectId: string,
): { passed: true } {
  const archive = exportKnowledgeProject(sourceDb, { projectId });
  const isolatedRoot = mkdtempSync(join(tmpdir(), '.knowledge-benchmark-archive-'));
  let target: Database.Database | null = null;
  try {
    target = openDatabase(join(isolatedRoot, 'import-target.db'));
    const workspaceRoot = join(isolatedRoot, 'workspace');

    const projects = tableRows(archive, 'knowledge_projects');
    if (projects.length !== 1) {
      throw new Error('Archive gate expected exactly one exported project row');
    }
    const mismatched = withTableRows(archive, 'knowledge_projects', [
      { ...projects[0], id: MISMATCHED_PROJECT_ID },
    ]);
    assertMessage(
      importFailure(target, mismatched, workspaceRoot),
      /matches manifest\.projectId/i,
      'project mismatch',
    );

    const pages = tableRows(archive, 'knowledge_pages');
    if (pages.length === 0) {
      throw new Error('Archive gate requires an exported knowledge page to clone');
    }
    const undeclared = withTableRows(archive, 'knowledge_pages', [
      { ...pages[0], [ATTACKER_COLUMN]: 'bad' },
    ]);
    const columnFailure = importFailure(target, undeclared, workspaceRoot);
    assertMessage(columnFailure, /unknown column/i, 'undeclared column');
    if (columnFailure.message.includes(ATTACKER_COLUMN) || columnFailure.message.includes('pwned')) {
      throw new Error('Archive gate found an attacker-controlled column key in the validation error');
    }

    return { passed: true };
  } finally {
    try {
      target?.close();
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  }
}
