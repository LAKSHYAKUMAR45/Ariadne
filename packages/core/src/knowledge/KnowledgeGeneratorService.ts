import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { buildKnowledgeManifest, type KnowledgeManifest } from './KnowledgeManifest.js';
import { createKnowledgeId, normalizeKnowledgePath } from './KnowledgeIds.js';
import { KnowledgePageStore, type CreatePageVersionInput, type KnowledgePageVersion } from './KnowledgePageStore.js';
import { KnowledgeRenderer, renderKnowledgeIndex, renderKnowledgeLog, renderKnowledgeOverview, type KnowledgeIndexEntry } from './KnowledgeRenderer.js';
import type { KnowledgePageType, KnowledgeProvenanceRef } from './KnowledgeTypes.js';
import { assertNoSymlinkComponents, isPathWithinRoot } from './KnowledgePathSecurity.js';

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
  pageResults: KnowledgeGenerationPageResult[];
  files: string[];
  manifest: KnowledgeManifest;
}

export interface KnowledgeGenerationPageResult {
  page: KnowledgePageVersion;
  reused: boolean;
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

interface PreparedPageGeneration {
  input: KnowledgeGenerationPageInput;
  pageId: string;
  relativePath: string;
  markdown: string;
  versionNumber: number;
  reused: boolean;
  reusedVersion: KnowledgePageVersion | null;
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

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function canonicalizeSourceVersionIds(value: string[] | undefined): string[] {
  return [...new Set(value ?? [])].sort();
}

function sameStrings(left: string[] | undefined, right: string[]): boolean {
  return JSON.stringify(canonicalizeSourceVersionIds(left)) === JSON.stringify(canonicalizeSourceVersionIds(right));
}

function resolveOutputPath(root: string, relativePath: string): { relativePath: string; absolutePath: string } {
  if (relativePath.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error('Knowledge generation output path must stay within the output root');
  }
  const normalizedPath = normalizeKnowledgePath(relativePath);
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, normalizedPath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('Knowledge generation output path must stay within the output root');
  }
  return { relativePath: normalizedPath, absolutePath };
}

function pageRelativePath(input: KnowledgeGenerationPageInput): string {
  return resolveOutputPath('/', `pages/${input.type}/${input.slug}.md`).relativePath;
}

function commitFiles(root: string, files: StagedFile[]): FileCommit {
  mkdirSync(root, { recursive: true });
  const token = `${process.pid}.${Date.now()}.${createKnowledgeId('generation').slice(-8)}`;
  const absoluteRoot = path.resolve(root);
  const stagingRoot = path.join(absoluteRoot, `.generation-${token}`);
  const backupRoot = path.join(absoluteRoot, `.generation-backup-${token}`);
  const staged = files.map((file) => ({ ...file, ...resolveOutputPath(absoluteRoot, file.relativePath) }));
  const targets = staged.map(({ absolutePath }) => absolutePath);
  const backups: Array<{ target: string; backup: string }> = [];
  try {
    for (const file of staged) writeDurable(path.join(stagingRoot, file.relativePath), file.content);
    for (const target of targets) {
      if (!existsSync(target)) continue;
      const backup = path.join(backupRoot, path.relative(absoluteRoot, target));
      mkdirSync(path.dirname(backup), { recursive: true });
      renameSync(target, backup);
      backups.push({ target, backup });
    }
    for (const file of staged) {
      const target = file.absolutePath;
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
      files: staged.map(({ relativePath }) => relativePath),
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
    const workspaceRoot = realpathSync(project.workspace_root);
    const approvedOutputRoot = path.join(workspaceRoot, '.ariadne', 'knowledge');
    const outputRoot = path.resolve(payload.outputRoot ?? approvedOutputRoot);
    if (!isPathWithinRoot(approvedOutputRoot, outputRoot)) {
      throw new Error('Knowledge generation output root must stay within .ariadne/knowledge');
    }
    assertNoSymlinkComponents(workspaceRoot, outputRoot, 'Knowledge generation output root');
    const manifest = buildKnowledgeManifest(project.id, generatedAt);
    const pageStore = new KnowledgePageStore(this.db);
    const renderedPages: PreparedPageGeneration[] = [];

    try {
      for (const input of payload.pages) {
        if (!input.content.trim()) throw new Error(`Knowledge page content must not be empty: ${input.slug}`);
        const relativePath = pageRelativePath(input);
        const pageId = input.pageId ?? createKnowledgeId('page', `${project.id}:${input.slug}`);
        const sourceVersionIds = canonicalizeSourceVersionIds(input.sourceVersionIds);
        const currentVersion = pageStore.getCurrentVersion(project.id, pageId as never);
        const reusedMarkdown =
          currentVersion === null
            ? null
            : this.renderer.renderKnowledgePage({
                id: pageId,
                type: input.type,
                title: input.title,
                slug: input.slug,
                content: input.content,
                sourceIds: sourceVersionIds,
                provenance: input.provenance,
                confidence: input.confidence,
                generatorVersion,
                generatedAt: currentVersion.createdAt,
                version: currentVersion.versionNumber,
              });

        if (
          currentVersion &&
          reusedMarkdown &&
          contentHash(reusedMarkdown) === currentVersion.contentHash &&
          (currentVersion.summary ?? null) === (input.summary ?? null) &&
          sameStrings(input.sourceVersionIds, currentVersion.sourceVersionIds)
        ) {
          renderedPages.push({
            input,
            pageId,
            relativePath,
            markdown: reusedMarkdown,
            versionNumber: currentVersion.versionNumber,
            reused: true,
            reusedVersion: currentVersion,
          });
          continue;
        }

        const versionNumber = pageStore.getNextVersionNumber(project.id, pageId as never);
        const markdown = this.renderer.renderKnowledgePage({
          id: pageId,
          type: input.type,
          title: input.title,
          slug: input.slug,
          content: input.content,
          sourceIds: sourceVersionIds,
          provenance: input.provenance,
          confidence: input.confidence,
          generatorVersion,
          generatedAt,
          version: versionNumber,
        });
        renderedPages.push({
          input: {
            ...input,
            sourceVersionIds,
          },
          pageId,
          relativePath,
          markdown,
          versionNumber,
          reused: false,
          reusedVersion: null,
        });
      }
    } catch (error) {
      this.failJob(jobId, error);
      throw error;
    }

    const entries: KnowledgeIndexEntry[] = renderedPages
      .map(({ input, pageId, versionNumber }) => ({
        id: pageId,
        type: input.type,
        title: input.title,
        slug: input.slug,
        summary: input.summary ?? null,
        status: 'active',
        version: versionNumber,
        updatedAt: generatedAt,
      }))
      .sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id));
    const existingLog = existsSync(path.join(outputRoot, 'log.md'))
      ? readFileSync(path.join(outputRoot, 'log.md'), 'utf8')
      : '';
    const stagedFiles: StagedFile[] = [
      ...renderedPages.map(({ markdown, relativePath }) => ({
        relativePath,
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
      const pageResults = this.db.transaction(() =>
        renderedPages.map((prepared) => {
          if (prepared.reused && prepared.reusedVersion) {
            pageStore.activatePage(project.id, prepared.pageId as never, prepared.input.type, prepared.input.title, generatedAt);
            return { page: prepared.reusedVersion, reused: true };
          }
          const versionInput: CreatePageVersionInput = {
            projectId: project.id,
            pageId: prepared.pageId as never,
            type: prepared.input.type,
            title: prepared.input.title,
            slug: prepared.input.slug,
            content: prepared.markdown,
            contentPath: prepared.relativePath,
            summary: prepared.input.summary,
            sourceVersionIds: prepared.input.sourceVersionIds,
            provenance: prepared.input.provenance,
            confidence: prepared.input.confidence,
            generatorVersion,
            createdAt: generatedAt,
          };
          return { page: pageStore.createPageVersion(versionInput), reused: false };
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
      return {
        jobId,
        projectId: project.id,
        generatedAt,
        pages: pageResults.map((result) => result.page),
        pageResults,
        files: fileCommit.files,
        manifest,
      };
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
