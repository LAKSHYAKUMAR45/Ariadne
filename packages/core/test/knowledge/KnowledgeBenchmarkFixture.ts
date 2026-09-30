import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep, relative, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeQueue } from '../../src/knowledge/KnowledgeQueue.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeWorker } from '../../src/knowledge/KnowledgeWorker.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import type { KnowledgeAccuracyCorpus, KnowledgeAccuracyQuestion } from './KnowledgeSearchEvaluator.js';
import { parseKnowledgeAccuracyCorpus } from './KnowledgeSearchEvaluator.js';

const FIXTURE_ROOT = resolve(process.cwd(), 'test/knowledge/fixtures/naas');
const QUESTIONS_PATH = 'questions.json';
const DEFAULT_PROJECT_ID = 'synthetic-naas-benchmark';
const DEFAULT_CREATED_AT = '2026-09-29T00:00:00.000Z';
const CONTENT_ROOT = 'sources/files';
const INCREMENTAL_SOURCE_PATH = 'task-managers/configlet.py';
const INCREMENTAL_APPEND_LINE = '\n# benchmark incremental refresh\n';
const SOURCE_PATHS = [
  'task-managers/configlet.py',
  'task-managers/deployment.py',
  'task-managers/device.py',
  'task-managers/gnmi.py',
  'task-managers/pytest_bootstrap.py',
  'task-managers/remote_access.py',
  'task-managers/topology.py',
  'task-managers/use_case.py',
] as const;

export interface KnowledgeBenchmarkSource {
  path: string;
  content: string;
  bytes: number;
}

export interface KnowledgeBenchmarkInput {
  corpus: KnowledgeAccuracyCorpus;
  corpusDigest: string;
  sourceBytes: number;
  sources: readonly KnowledgeBenchmarkSource[];
}

export interface KnowledgeBenchmarkHarness {
  db: Database.Database;
  databasePath: string;
  projectId: string;
  workspaceRoot: string;
  input: KnowledgeBenchmarkInput;
  seedInitialSources(): { queuedJobCount: number };
  runWorker(workerId: string): Promise<void>;
  applyIncrementalUpdate(): { sourcePath: string; sourceVersionId: string };
  cleanup(): void;
}

function resolveFixturePath(path: string): string {
  const resolvedPath = resolve(FIXTURE_ROOT, path);
  const fixtureRelativePath = relative(FIXTURE_ROOT, resolvedPath);
  if (fixtureRelativePath.startsWith('..') || fixtureRelativePath === '' || fixtureRelativePath.includes(`..${sep}`)) {
    throw new Error(`Benchmark fixture path must stay within ${FIXTURE_ROOT}: ${path}`);
  }
  return resolvedPath;
}

function cloneQuestion(question: KnowledgeAccuracyQuestion): KnowledgeAccuracyQuestion {
  return {
    ...question,
    expectedPaths: [...question.expectedPaths],
    expectedSymbols: [...question.expectedSymbols],
  };
}

function cloneCorpus(corpus: KnowledgeAccuracyCorpus): KnowledgeAccuracyCorpus {
  return {
    corpusVersion: corpus.corpusVersion,
    questions: corpus.questions.map(cloneQuestion),
  };
}

function buildDigest(
  questionBytes: Buffer,
  sources: readonly KnowledgeBenchmarkSource[],
): string {
  const hash = createHash('sha256');
  for (const source of sources) {
    hash.update(source.path);
    hash.update('\0');
    hash.update(String(source.bytes));
    hash.update('\0');
    hash.update(source.content);
    hash.update('\0');
  }
  hash.update(questionBytes);
  return hash.digest('hex');
}

function contentPathForSource(sourcePath: string): string {
  return `${CONTENT_ROOT}/${sourcePath.replaceAll('/', '-')}`;
}

function storedPathForSource(workspaceRoot: string, sourcePath: string): string {
  return join(workspaceRoot, '.ariadne', 'knowledge', contentPathForSource(sourcePath));
}

function persistSourceCopy(workspaceRoot: string, sourcePath: string, content: string): string {
  const storedPath = storedPathForSource(workspaceRoot, sourcePath);
  mkdirSync(dirname(storedPath), { recursive: true });
  writeFileSync(storedPath, content, 'utf8');
  return storedPath;
}

export function loadKnowledgeBenchmarkInput(): KnowledgeBenchmarkInput {
  const questionBytes = readFileSync(resolveFixturePath(QUESTIONS_PATH));
  const parsedQuestions = JSON.parse(questionBytes.toString('utf8')) as unknown;
  const corpus = parseKnowledgeAccuracyCorpus(parsedQuestions);
  const sources = SOURCE_PATHS.map((sourcePath) => {
    const content = readFileSync(resolveFixturePath(sourcePath), 'utf8');
    return {
      path: sourcePath,
      content,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  });

  return {
    corpus: cloneCorpus(corpus),
    corpusDigest: buildDigest(questionBytes, sources),
    sourceBytes: sources.reduce((sum, source) => sum + source.bytes, 0),
    sources: sources.map((source) => ({ ...source })),
  };
}

export function createKnowledgeBenchmarkHarness(
  options: {
    databasePath?: string;
    projectId?: string;
    createdAt?: string;
  } = {},
): KnowledgeBenchmarkHarness {
  const workspaceRoot = mkdtempSync(join(process.cwd(), '.knowledge-benchmark-'));
  const databasePath = options.databasePath ?? join(workspaceRoot, 'state.db');
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const createdAt = options.createdAt ?? DEFAULT_CREATED_AT;
  const input = loadKnowledgeBenchmarkInput();
  const db = openDatabase(databasePath);
  applyKnowledgeMigrations(db);
  const queue = new KnowledgeQueue(db, { now: () => createdAt });
  const sourceStore = new KnowledgeSourceStore(db);
  let cleaned = false;
  let databaseClosed = false;
  let workspaceRemoved = false;

  db.prepare(
    `INSERT INTO knowledge_projects
     (id, workspace_root, name, status, created_at, updated_at)
     VALUES (?, ?, 'Synthetic NAAS benchmark fixtures', 'active', ?, ?)`,
  ).run(projectId, workspaceRoot, createdAt, createdAt);

  return {
    db,
    databasePath,
    projectId,
    workspaceRoot,
    input,
    seedInitialSources(): { queuedJobCount: number } {
      let queuedJobCount = 0;
      for (const source of input.sources) {
        persistSourceCopy(workspaceRoot, source.path, source.content);
        const record = sourceStore.register({
          projectId,
          kind: 'file',
          path: source.path,
          content: source.content,
          contentPath: contentPathForSource(source.path),
          mimeType: 'text/x-python',
        });
        const currentVersion = sourceStore.currentVersion(projectId, record.id);
        if (!currentVersion) {
          throw new Error(`Expected current benchmark source version for ${source.path}`);
        }
        const existingJob = db.prepare(
          `SELECT 1 FROM knowledge_jobs
           WHERE project_id = ? AND job_kind = 'analyze' AND source_version_id = ?`,
        ).get(projectId, currentVersion.id);
        queue.enqueue({
          projectId,
          jobKind: 'analyze',
          sourceVersionId: currentVersion.id,
          payload: {
            sourceId: record.id,
            sourceVersionId: currentVersion.id,
            path: source.path,
          },
        });
        if (!existingJob) {
          queuedJobCount += 1;
        }
      }
      return { queuedJobCount };
    },
    async runWorker(workerId: string): Promise<void> {
      await new KnowledgeWorker(db, { workerId, now: () => createdAt }).runOnce(projectId);
    },
    applyIncrementalUpdate(): { sourcePath: string; sourceVersionId: string } {
      const storedPath = storedPathForSource(workspaceRoot, INCREMENTAL_SOURCE_PATH);
      const updatedContent = `${readFileSync(storedPath, 'utf8')}${INCREMENTAL_APPEND_LINE}`;
      persistSourceCopy(workspaceRoot, INCREMENTAL_SOURCE_PATH, updatedContent);
      const record = sourceStore.register({
        projectId,
        kind: 'file',
        path: INCREMENTAL_SOURCE_PATH,
        content: updatedContent,
        contentPath: contentPathForSource(INCREMENTAL_SOURCE_PATH),
        mimeType: 'text/x-python',
      });
      const currentVersion = sourceStore.currentVersion(projectId, record.id);
      if (!currentVersion) {
        throw new Error(`Expected current benchmark source version for ${INCREMENTAL_SOURCE_PATH}`);
      }
      queue.enqueue({
        projectId,
        jobKind: 'analyze',
        sourceVersionId: currentVersion.id,
        payload: {
          sourceId: record.id,
          sourceVersionId: currentVersion.id,
          path: INCREMENTAL_SOURCE_PATH,
        },
      });
      return {
        sourcePath: INCREMENTAL_SOURCE_PATH,
        sourceVersionId: currentVersion.id,
      };
    },
    cleanup(): void {
      if (cleaned) {
        return;
      }

      const failures: unknown[] = [];
      if (!databaseClosed) {
        try {
          db.close();
          databaseClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (!workspaceRemoved) {
        try {
          rmSync(workspaceRoot, { recursive: true, force: true });
          workspaceRemoved = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw failures[0];
      }
      cleaned = true;
    },
  };
}
