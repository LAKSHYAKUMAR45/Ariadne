import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildKnowledgeManifest, type KnowledgeManifest } from './KnowledgeManifest.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import { KnowledgePageStore, type CreatePageVersionInput, type KnowledgePageVersion } from './KnowledgePageStore.js';
import { KnowledgeRenderer, renderKnowledgeIndex, renderKnowledgeLog, renderKnowledgeOverview, type KnowledgeIndexEntry } from './KnowledgeRenderer.js';
import type { KnowledgePageType, KnowledgeProvenanceRef } from './KnowledgeTypes.js';

export interface KnowledgeGenerationPageInput {
  pageId?: string;
  type: KnowledgePageType;
  title: string;
  slug: string;
  content: string;
  summary?: string | null;
  sourceVersionIds?: string[];
  provenance?: KnowledgeProvenanceRef[];
  confidence?: number | null;
}

export interface KnowledgeGenerationPayload {
  pages: KnowledgeGenerationPageInput[];
  overview?: string | null;
  generatorVersion?: string;
  generatedAt?: string;
  outputRoot?: string;
}

export interface KnowledgeGenerationResult {
  jobId: string;
  projectId: string;
  generatedAt: string;
  pages: KnowledgePageVersion[];
  files: string[];
  manifest: KnowledgeManifest;
}

export interface KnowledgeGeneratorServiceOptions {
  workerId?: string;
  renderer?: KnowledgeRenderer;
  now?: () => string;
}

interface JobRow {
  id: string;
  project_id: string;
  status: string;
  payload_json: string;
  worker_id: string | null;
}

interface ProjectRow {
  id: string;
  workspace_root: string;
  name: string;
}

interface StagedFile {
  relativePath: string;
  content: string;
}

interface FileCommit {
  files: string[];
  finalize: () => void;
  rollback: () => void;
}

function parsePayload(value: string): KnowledgeGenerationPayload {
  const payload: unknown = JSON.parse(value);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Knowledge generation job payload must be an object');
  }
  const candidate = payload as Partial<KnowledgeGenerationPayload>;
  if (!Array.isArray(candidate.pages)) throw new Error('Knowledge generation payload requires pages');
  return candidate as KnowledgeGenerationPayload;
}

function writeDurable(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
  const descriptor = openSync(filePath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function commitFiles(root: string, files: StagedFile[]): FileCommit {
  mkdirSync(root, { recursive: true });
  const token = `${process.pid}.${Date.now()}.${createKnowledgeId('generation').slice(-8)}`;
  const stagingRoot = path.join(root, `.generation-${token}`);
  const backupRoot = path.join(root, `.generation-backup-${token}`);
  const targets = files.map(({ relativePath }) => path.join(root, relativePath));
  const backups: Array<{ target: string; backup: string }> = [];
  try {
    for (const file of files) writeDurable(path.join(stagingRoot, file.relativePath), file.content);
    for (const target of targets) {
      if (!existsSync(target)) continue;
      const backup = path.join(backupRoot, path.relative(root, target));
      mkdirSync(path.dirname(backup), { recursive: true });
      renameSync(target, backup);
      backups.push({ target, backup });
    }
    for (const file of files) {
      const target = path.join(root, file.relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(path.join(stagingRoot, file.relativePath), target);
    }
    const rollback = (): void => {
      for (const target of targets) rmSync(target, { force: true });
      for (const { target, backup } of backups.reverse()) {
        if (existsSync(backup)) {
          mkdirSync(path.dirname(target), { recursive: true });
          renameSync(backup, target);
        }
      }
      rmSync(stagingRoot, { recursive: true, force: true });
      rmSync(backupRoot, { recursive: true, force: true });
    };
    return {
      files: files.map(({ relativePath }) => relativePath),
      finalize: () => {
        rmSync(stagingRoot, { recursive: true, force: true });
        rmSync(backupRoot, { recursive: true, force: true });
      },
      rollback,
    };
  } catch (error) {
    for (const target of targets) rmSync(target, { force: true });
    for (const { target, backup } of backups.reverse()) {
      if (existsSync(backup)) {
        mkdirSync(path.dirname(target), { recursive: true });
        renameSync(backup, target);
      }
    }
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
    throw error;
  }
}

export class KnowledgeGeneratorService {
  private readonly renderer: KnowledgeRenderer;
  private readonly workerId: string;
  private readonly now: () => string;

  public constructor(
    private readonly db: Database.Database,
    options: KnowledgeGeneratorServiceOptions = {},
  ) {
    this.renderer = options.renderer ?? new KnowledgeRenderer();
    this.workerId = options.workerId ?? `knowledge-generator-${process.pid}`;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async runKnowledgeGeneration(jobId: string): Promise<KnowledgeGenerationResult> {
    const job = this.db
      .prepare('SELECT id, project_id, status, payload_json, worker_id FROM knowledge_jobs WHERE id = ?')
      .get(jobId) as JobRow | undefined;
    if (!job) throw new Error(`Knowledge job not found: ${jobId}`);
    if (job.status === 'queued') {
      this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'running', worker_id = @workerId, started_at = COALESCE(started_at, @now)
           WHERE id = @id AND status = 'queued'`,
        )
        .run({ workerId: this.workerId, now: this.now(), id: jobId });
    } else if (job.status !== 'running') {
      throw new Error(`Cannot generate knowledge for ${job.status} job`);
    }

    const project = this.db
      .prepare('SELECT id, workspace_root, name FROM knowledge_projects WHERE id = ?')
      .get(job.project_id) as ProjectRow | undefined;
    if (!project) throw new Error(`Knowledge project not found: ${job.project_id}`);

    const payload = parsePayload(job.payload_json);
    const generatedAt = payload.generatedAt ?? this.now();
    const generatorVersion = payload.generatorVersion ?? '1';
    const outputRoot = path.resolve(payload.outputRoot ?? path.join(project.workspace_root, '.ariadne', 'knowledge'));
    const manifest = buildKnowledgeManifest(project.id, generatedAt);
    const pageStore = new KnowledgePageStore(this.db);
    const renderedPages: Array<{ input: KnowledgeGenerationPageInput; pageId: string; version: number; markdown: string }> = [];

    try {
      for (const input of payload.pages) {
        if (!input.content.trim()) throw new Error(`Knowledge page content must not be empty: ${input.slug}`);
        const pageId = input.pageId ?? createKnowledgeId('page', `${project.id}:${input.slug}`);
        const version = pageStore.getNextVersionNumber(project.id, pageId as never);
        const markdown = this.renderer.renderKnowledgePage({
          id: pageId,
          type: input.type,
          title: input.title,
          slug: input.slug,
          content: input.content,
          sourceIds: input.sourceVersionIds,
          provenance: input.provenance,
          confidence: input.confidence,
          generatorVersion,
          generatedAt,
          version,
        });
        renderedPages.push({ input, pageId, version, markdown });
      }
    } catch (error) {
      this.failJob(jobId, error);
      throw error;
    }

    const entries: KnowledgeIndexEntry[] = renderedPages
      .map(({ input, pageId, version }) => ({
        id: pageId,
        type: input.type,
        title: input.title,
        slug: input.slug,
        summary: input.summary ?? null,
        status: 'active',
        version,
        updatedAt: generatedAt,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id));
    const existingLog = existsSync(path.join(outputRoot, 'log.md'))
      ? readFileSync(path.join(outputRoot, 'log.md'), 'utf8')
      : '';
    const stagedFiles: StagedFile[] = [
      ...renderedPages.map(({ input, markdown }) => ({
        relativePath: `pages/${input.type}/${input.slug}.md`,
        content: markdown,
      })),
      { relativePath: 'index.md', content: renderKnowledgeIndex(entries) },
      { relativePath: 'overview.md', content: renderKnowledgeOverview(project.name, entries, payload.overview) },
      { relativePath: 'log.md', content: renderKnowledgeLog({ jobId, generatedAt, pageCount: entries.length }, existingLog) },
      { relativePath: 'index.json', content: `${JSON.stringify({ projectId: project.id, generatedAt, pages: entries }, null, 2)}\n` },
      { relativePath: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    ];

    let fileCommit: FileCommit | null = null;
    try {
      fileCommit = commitFiles(outputRoot, stagedFiles);
      const versions = this.db.transaction(() =>
        renderedPages.map(({ input, pageId, markdown }) => {
          const versionInput: CreatePageVersionInput = {
            projectId: project.id,
            pageId: pageId as never,
            type: input.type,
            title: input.title,
            slug: input.slug,
            content: markdown,
            contentPath: `pages/${input.type}/${input.slug}.md`,
            summary: input.summary,
            sourceVersionIds: input.sourceVersionIds,
            provenance: input.provenance,
            confidence: input.confidence,
            generatorVersion,
            createdAt: generatedAt,
          };
          return pageStore.createPageVersion(versionInput);
        }),
      )();
      this.db
        .prepare(
          `UPDATE knowledge_jobs
           SET status = 'completed', completed_at = @completedAt, worker_id = NULL, lease_expires_at = NULL
           WHERE id = @id`,
        )
        .run({ completedAt: generatedAt, id: jobId });
      fileCommit.finalize();
      return { jobId, projectId: project.id, generatedAt, pages: versions, files: fileCommit.files, manifest };
    } catch (error) {
      if (fileCommit) fileCommit.rollback();
      this.failJob(jobId, error);
      throw error;
    }
  }

  private failJob(jobId: string, error: unknown): void {
    this.db
      .prepare(
        `UPDATE knowledge_jobs
         SET status = 'failed', completed_at = @completedAt, failure_code = 'generation_failed',
             failure_message = @failureMessage, worker_id = NULL, lease_expires_at = NULL
         WHERE id = @id`,
      )
      .run({
        completedAt: this.now(),
        id: jobId,
        failureMessage: error instanceof Error ? error.message : 'Knowledge generation failed',
      });
  }
}

export async function runKnowledgeGeneration(
  db: Database.Database,
  jobId: string,
  options?: KnowledgeGeneratorServiceOptions,
): Promise<KnowledgeGenerationResult> {
  return new KnowledgeGeneratorService(db, options).runKnowledgeGeneration(jobId);
}
