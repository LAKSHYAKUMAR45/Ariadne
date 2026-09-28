import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import {
  openDatabase,
  KnowledgeProjectStore,
  KnowledgeSourceStore,
  scanKnowledgeSources,
  shouldIngestSource,
  KnowledgeQueue,
  KnowledgePageStore,
  searchKnowledge,
  KnowledgeGraph,
  createKnowledgeReview,
  listKnowledgeReviews,
  resolveKnowledgeReview,
  reopenKnowledgeReview,
  KnowledgeResearchService,
  ResearchProviderRequiredError,
  KnowledgeChatService,
  KnowledgeProviderRegistry,
  KnowledgeProviderRequiredError,
  exportKnowledgeProject,
  importKnowledgeProject,
  CodeIngestor,
  MarkdownIngestor,
  PlainTextIngestor,
  createKnowledgeId,
  normalizeKnowledgePath,
  KnowledgeWorker,
  KnowledgeProviderProfileStore,
  OpenAICompatibleProvider,
  OpenAICompatibleEnrichmentService,
  normalizeOpenAICompatibleEndpoint,
} from '@ariadne-dev/core';
import type {
  KnowledgeIngestor,
  KnowledgeSearchMode,
  KnowledgeReviewAction,
  KnowledgeReviewStatus,
  KnowledgeArchive,
  KnowledgeArchiveFile,
  KnowledgeProviderCapability,
  KnowledgeProviderProfile,
  OpenAICompatibleHostPolicy,
} from '@ariadne-dev/core';
import { findWorkspaceRoot, stateDbPath } from './workspace.js';

/** Deterministic (never-provider) chat callback: chat "send" always gates on `providers.supports('chat')` before this could run, so this body should be unreachable in the CLI today. */
const UNCONFIGURED_CHAT_PROVIDER = async function* unconfiguredChatProvider(): AsyncIterable<string> {
  throw new Error('No knowledge chat provider is configured for this CLI.');
};

const INGESTORS: KnowledgeIngestor[] = [new CodeIngestor(), new MarkdownIngestor(), new PlainTextIngestor()];

interface KnowledgeGlobalOptions {
  json?: boolean;
}

type KnowledgeDb = ReturnType<typeof openDatabase>;

interface CliWorkerOptions {
  workerId: string;
  signal?: AbortSignal;
}

interface CliWorkerStatus {
  projectId: string;
  queue: {
    queuedCount: number;
    runningCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    oldestQueuedRequestedAt: string | null;
    oldestQueuedAgeMs: number | null;
  };
  activeWorkers: {
    workerCount: number;
    runningCount: number;
    leases: Array<{
      workerId: string;
      runningCount: number;
      leaseExpiresAt: string;
    }>;
  };
  recentFailureCodes: Array<{
    code: string;
    count: number;
    lastCompletedAt: string | null;
  }>;
  analyzerVersions: Array<{
    analyzerId: string;
    analyzerVersion: string;
    extractionCount: number;
  }>;
  completions: {
    deterministic: number;
    enriched: number;
  };
  providerProfiles: {
    total: number;
    enabled: number;
  };
  warnings: Array<{ code: string; message: string }>;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const CLI_ALLOWED_PROVIDER_ORIGIN_ENV = 'ARIADNE_KNOWLEDGE_PROVIDER_ALLOWED_ORIGIN';
const MAX_STATUS_FAILURE_CODES = 5;
const MAX_STATUS_LEASES = 8;
const MAX_STATUS_ANALYZER_VERSIONS = 8;
const MAX_STATUS_WARNINGS = 8;
const LEGACY_COMPLETION_BATCH_SIZE = 100;
const LOOPBACK_PROVIDER_HOSTS = new Set(['127.0.0.1', '::1']);

/** Opens the shared workspace state database (knowledge tables live alongside task tables) and guarantees it is closed, mirroring `withStore` in index.ts but without requiring a `TaskStore`. */
function withKnowledgeDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(stateDbPath(findWorkspaceRoot()));
  try {
    const result = fn(db);
    if (result instanceof Promise) {
      return result.finally(() => db.close()) as T;
    }
    db.close();
    return result;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Runs a knowledge command handler with consistent success/error reporting:
 * `--json` always emits a single `{ ok, data }` or `{ ok: false, error }`
 * line to stdout; human mode prints via `format` (or the default JSON dump)
 * on success and a plain message to stderr on failure. Always sets
 * `process.exitCode = 1` on failure so scripts can rely on it.
 */
async function runKnowledgeAction<T>(
  opts: KnowledgeGlobalOptions,
  fn: () => T | Promise<T>,
  format?: (result: T) => void,
): Promise<void> {
  try {
    const result = await fn();
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, data: result }, null, 2));
    } else if (format) {
      format(result);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const capability =
      err instanceof ResearchProviderRequiredError || err instanceof KnowledgeProviderRequiredError
        ? (err as { capability?: string }).capability ?? 'research'
        : undefined;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: { message, ...(capability ? { capability } : {}) } }, null, 2));
    } else {
      console.error(`Error: ${message}`);
    }
    process.exitCode = 1;
  }
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requirePositiveInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeApprovedOrigins(): Set<string> {
  const configured = process.env[CLI_ALLOWED_PROVIDER_ORIGIN_ENV];
  const allowed = new Set<string>();
  for (const candidate of parseCsv(configured) ?? []) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    allowed.add(parsed.origin);
  }
  return allowed;
}

function isCliSafeLoopbackEndpoint(endpoint: string): boolean {
  const normalized = normalizeOpenAICompatibleEndpoint(endpoint);
  const url = new URL(normalized);
  return url.protocol === 'http:' && LOOPBACK_PROVIDER_HOSTS.has(url.hostname.replace(/^\[/, '').replace(/\]$/, ''));
}

function createCliHostPolicy(): OpenAICompatibleHostPolicy {
  const approvedOrigins = normalizeApprovedOrigins();
  return {
    isOriginAllowed: ({ origin, profile }) => {
      if (isCliSafeLoopbackEndpoint(profile.endpoint) && new URL(normalizeOpenAICompatibleEndpoint(profile.endpoint)).origin === origin) {
        return true;
      }
      return approvedOrigins.has(origin);
    },
  };
}

function createCliCredentialPolicy(profiles: readonly KnowledgeProviderProfile[]) {
  const allowedEnvironmentVariables = new Set<string>();
  for (const profile of profiles) {
    if (profile.apiKeyEnv) {
      allowedEnvironmentVariables.add(profile.apiKeyEnv);
    }
  }
  return { allowedEnvironmentVariables };
}

function createCliProviderStore(
  db: KnowledgeDb,
  projectId: string,
  options: { includeDisabled?: boolean; testProfileName?: string } = {},
): KnowledgeProviderProfileStore {
  const baseStore = new KnowledgeProviderProfileStore(db);
  const listed = baseStore.listWithDiagnostics(projectId);
  const selectedProfiles = listed.profiles.filter((profile) => {
    if (options.testProfileName && profile.profileName.toLowerCase() === options.testProfileName.toLowerCase()) {
      return true;
    }
    return options.includeDisabled ? true : profile.enabled;
  });
  return new KnowledgeProviderProfileStore(db, {
    adapter: new OpenAICompatibleProvider({
      credentialPolicy: createCliCredentialPolicy(selectedProfiles),
      hostPolicy: createCliHostPolicy(),
    }),
    credentialPolicy: createCliCredentialPolicy(selectedProfiles),
  });
}

export function createCliKnowledgeWorker(
  db: KnowledgeDb,
  projectId: string,
  options: CliWorkerOptions,
): KnowledgeWorker {
  const profileStore = createCliProviderStore(db, projectId);
  const enabledProfiles = profileStore.list(projectId).filter((profile) => profile.enabled);
  if (enabledProfiles.length === 0) {
    return new KnowledgeWorker(db, {
      workerId: options.workerId,
      signal: options.signal,
    });
  }
  return new KnowledgeWorker(
    db,
    {
      workerId: options.workerId,
      signal: options.signal,
      enrich: new OpenAICompatibleEnrichmentService(db, {
        profileStore,
        provider: new OpenAICompatibleProvider({
          credentialPolicy: createCliCredentialPolicy(enabledProfiles),
          hostPolicy: createCliHostPolicy(),
        }),
      }),
    },
  );
}

function summarizeLegacyCompletionModes(db: KnowledgeDb, projectId: string): {
  deterministic: number;
  enriched: number;
  warnings: Array<{ code: string; message: string }>;
} {
  const warnings: Array<{ code: string; message: string }> = [];
  let deterministic = 0;
  let enriched = 0;
  let afterId = '';
  const recordInvalidResultWarning = (): void => {
    if (!warnings.some((warning) => warning.code === 'job_result_invalid')) {
      warnings.push({
        code: 'job_result_invalid',
        message: 'Skipped one or more malformed completed job results while summarizing processing modes.',
      });
    }
  };
  const statement = db.prepare(
    `SELECT id, result_json
     FROM knowledge_jobs
     WHERE project_id = ?
       AND status = 'completed'
       AND result_processing_mode IS NULL
       AND result_json IS NOT NULL
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  );

  while (true) {
    const rows = statement.all(projectId, afterId, LEGACY_COMPLETION_BATCH_SIZE) as Array<{
      id: string;
      result_json: string;
    }>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      try {
        const result = JSON.parse(row.result_json) as { processingMode?: string };
        if (result.processingMode === 'enriched') {
          enriched += 1;
        } else if (result.processingMode === 'deterministic') {
          deterministic += 1;
        } else {
          recordInvalidResultWarning();
        }
      } catch {
        recordInvalidResultWarning();
      }
    }
    afterId = rows.at(-1)?.id ?? afterId;
  }

  return { deterministic, enriched, warnings };
}

export function buildCliWorkerStatus(db: KnowledgeDb, projectId: string): CliWorkerStatus {
  const scopedProjectId = projectId.trim();
  if (scopedProjectId.length === 0) {
    throw new Error('Knowledge worker project ID must not be empty');
  }
  const project = new KnowledgeProjectStore(db).get(scopedProjectId);
  if (!project) {
    throw new Error(`Knowledge project not found: ${scopedProjectId}`);
  }

  const observedNow = new Date().toISOString();
  const queue = new KnowledgeQueue(db, { now: () => observedNow });
  const queueStatus = queue.getQueueStatus(scopedProjectId);
  const oldestQueuedRequestedAt = (
    db.prepare(
      `SELECT requested_at
       FROM knowledge_jobs
       WHERE project_id = ? AND status = 'queued'
       ORDER BY requested_at ASC, id ASC
       LIMIT 1`,
    ).get(scopedProjectId) as { requested_at: string } | undefined
  )?.requested_at ?? null;
  const leaseRows = db.prepare(
    `SELECT worker_id, COUNT(*) AS running_count, MAX(lease_expires_at) AS lease_expires_at
     FROM knowledge_jobs
     WHERE project_id = ?
       AND status = 'running'
       AND worker_id IS NOT NULL
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at > ?
     GROUP BY worker_id
     ORDER BY lease_expires_at ASC, worker_id ASC
     LIMIT ?`,
  ).all(scopedProjectId, observedNow, MAX_STATUS_LEASES) as Array<{
    worker_id: string;
    running_count: number;
    lease_expires_at: string;
  }>;
  const activeWorkerSummary = (
    db.prepare(
      `SELECT COUNT(DISTINCT worker_id) AS worker_count, COUNT(*) AS running_count
       FROM knowledge_jobs
       WHERE project_id = ?
         AND status = 'running'
         AND worker_id IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > ?`,
    ).get(scopedProjectId, observedNow) as { worker_count: number; running_count: number }
  );
  const failureRows = db.prepare(
    `SELECT failure_code, completed_at
     FROM knowledge_jobs
     WHERE project_id = ?
       AND status = 'failed'
       AND failure_code IS NOT NULL
     ORDER BY completed_at DESC, id DESC
     LIMIT ?`,
  ).all(scopedProjectId, MAX_STATUS_FAILURE_CODES * 4) as Array<{
    failure_code: string;
    completed_at: string | null;
  }>;
  const failures = new Map<string, { code: string; count: number; lastCompletedAt: string | null }>();
  for (const row of failureRows) {
    const existing = failures.get(row.failure_code);
    if (existing) {
      existing.count += 1;
      if (existing.lastCompletedAt === null || (row.completed_at !== null && row.completed_at > existing.lastCompletedAt)) {
        existing.lastCompletedAt = row.completed_at;
      }
      continue;
    }
    if (failures.size >= MAX_STATUS_FAILURE_CODES) {
      continue;
    }
    failures.set(row.failure_code, {
      code: row.failure_code,
      count: 1,
      lastCompletedAt: row.completed_at,
    });
  }
  const analyzerRows = db.prepare(
    `SELECT analyzer_id, analyzer_version, COUNT(*) AS extraction_count
     FROM knowledge_extractions
     WHERE project_id = ?
     GROUP BY analyzer_id, analyzer_version
     ORDER BY extraction_count DESC, analyzer_id ASC, analyzer_version ASC
     LIMIT ?`,
  ).all(scopedProjectId, MAX_STATUS_ANALYZER_VERSIONS) as Array<{
    analyzer_id: string;
    analyzer_version: string;
    extraction_count: number;
  }>;
  const completionCounts = db.prepare(
    `SELECT
       SUM(CASE WHEN result_processing_mode = 'deterministic' THEN 1 ELSE 0 END) AS deterministic_count,
       SUM(CASE WHEN result_processing_mode = 'enriched' THEN 1 ELSE 0 END) AS enriched_count
     FROM knowledge_jobs
     WHERE project_id = ?
       AND status = 'completed'
       AND result_processing_mode IS NOT NULL`,
  ).get(scopedProjectId) as {
    deterministic_count: number | null;
    enriched_count: number | null;
  };
  const legacyCompletionSummary = summarizeLegacyCompletionModes(db, scopedProjectId);

  const providerStore = new KnowledgeProviderProfileStore(db);
  const listedProviders = providerStore.listWithDiagnostics(scopedProjectId);
  return {
    projectId: scopedProjectId,
    queue: {
      queuedCount: queueStatus.queuedCount,
      runningCount: queueStatus.runningCount,
      completedCount: queueStatus.completedCount,
      failedCount: queueStatus.failedCount,
      cancelledCount: queueStatus.cancelledCount,
      oldestQueuedRequestedAt,
      oldestQueuedAgeMs: queueStatus.oldestQueuedAgeMs,
    },
    activeWorkers: {
      workerCount: activeWorkerSummary.worker_count ?? 0,
      runningCount: activeWorkerSummary.running_count ?? 0,
      leases: leaseRows.map((row) => ({
        workerId: row.worker_id,
        runningCount: row.running_count,
        leaseExpiresAt: row.lease_expires_at,
      })),
    },
    recentFailureCodes: [...failures.values()],
    analyzerVersions: analyzerRows.map((row) => ({
      analyzerId: row.analyzer_id,
      analyzerVersion: row.analyzer_version,
      extractionCount: row.extraction_count,
    })),
    completions: {
      deterministic: (completionCounts.deterministic_count ?? 0) + legacyCompletionSummary.deterministic,
      enriched: (completionCounts.enriched_count ?? 0) + legacyCompletionSummary.enriched,
    },
    providerProfiles: {
      total: listedProviders.profiles.length,
      enabled: listedProviders.profiles.filter((profile) => profile.enabled).length,
    },
    warnings: [...legacyCompletionSummary.warnings, ...listedProviders.warnings].slice(0, MAX_STATUS_WARNINGS),
  };
}

function selectIngestor(inputPath: string): KnowledgeIngestor {
  const ingestor = INGESTORS.find((candidate) => candidate.supports({ content: '', path: inputPath }));
  return ingestor ?? new PlainTextIngestor();
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function sanitizeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

function isCliPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertCliNoSymlinkComponents(root: string, target: string, label: string): void {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isCliPathWithinRoot(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} must stay within the workspace`);
  }

  const relative = path.relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} must not traverse symbolic links`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

function storeImmutableKnowledgeSourceContent(workspaceRoot: string, sourcePath: string, content: string): string {
  const canonicalWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const normalizedPath = normalizeKnowledgePath(sourcePath);
  const contentHash = sha256Hex(content).slice(0, 16);
  const extension = path.posix.extname(normalizedPath);
  const stem = extension ? normalizedPath.slice(0, -extension.length) : normalizedPath;
  const directory = path.posix.dirname(stem);
  const baseName = sanitizeStorageSegment(path.posix.basename(stem));
  const storedDirectory = directory === '.' ? 'workspace' : path.posix.join('workspace', directory);
  const storedRelativePath = path.posix.join('sources', storedDirectory, `${baseName}-${contentHash}${extension}`);
  const absolutePath = path.join(canonicalWorkspaceRoot, '.ariadne', 'knowledge', storedRelativePath);
  assertCliNoSymlinkComponents(canonicalWorkspaceRoot, absolutePath, 'Knowledge source content path');
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const canonicalParent = fs.realpathSync(path.dirname(absolutePath));
  if (!isCliPathWithinRoot(canonicalWorkspaceRoot, canonicalParent)) {
    throw new Error('Knowledge source content path must stay within the workspace');
  }
  fs.writeFileSync(absolutePath, content, 'utf8');
  return storedRelativePath;
}

/**
 * Registers the `ariadne knowledge ...` command tree onto `program`. Every
 * leaf command opens the shared workspace `state.db`, delegates to the
 * matching `@ariadne-dev/core` knowledge service, and closes the database
 * before returning — no command holds core state across invocations, since
 * each CLI call is a fresh process. Worker/provider commands stay local-first:
 * deterministic worker processing needs no provider, provider profiles persist
 * only non-secret metadata, and named/public hosts fail closed unless a safe
 * host policy plus pinned transport exists. Research/chat commands still fail
 * deterministically with a `provider_required`-style error because this CLI
 * does not yet wire provider-backed execution for those surfaces.
 */
export function registerKnowledgeCommands(program: Command): void {
  const knowledge = program.commands.find((cmd) => cmd.name() === 'knowledge') ?? program.command('knowledge').description('Manage the local-first knowledge workspace (projects, sources, pages, graph, review, research, chat)');

  // -----------------------------------------------------------------
  // project
  // -----------------------------------------------------------------
  const project = knowledge.command('project').description('Manage knowledge projects');

  project
    .command('create <name>')
    .description('Create a knowledge project')
    .option('-w, --workspace-root <path>', 'Workspace root the project is scoped to (default: current workspace)')
    .option('-d, --description <text>', 'Project description')
    .option('-r, --roots <csv>', 'Comma-separated source roots (relative to the workspace root)')
    .option('--json', 'Output JSON')
    .action(async (name: string, opts: { workspaceRoot?: string; description?: string; roots?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) =>
          new KnowledgeProjectStore(db).create({
            name,
            workspaceRoot: opts.workspaceRoot ?? findWorkspaceRoot(),
            description: opts.description,
            roots: parseCsv(opts.roots),
          }),
        ),
      (result) => console.log(`Created knowledge project ${result.id}: ${result.name}`));
    });

  project
    .command('list')
    .description('List knowledge projects')
    .option('-s, --status <status>', 'Filter by status (active|archived)')
    .option('--json', 'Output JSON')
    .action(async (opts: { status?: 'active' | 'archived'; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => new KnowledgeProjectStore(db).list(opts.status ? { status: opts.status } : undefined)),
      (results) => {
        if (results.length === 0) {
          console.log('No knowledge projects found.');
          return;
        }
        for (const item of results) console.log(`[${item.status}] ${item.id}  ${item.name}  (${item.workspaceRoot})`);
      });
    });

  project
    .command('show <project-id>')
    .description('Show a knowledge project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => {
        return withKnowledgeDb((db) => {
          const found = new KnowledgeProjectStore(db).get(projectId);
          if (!found) throw new Error(`Knowledge project not found: ${projectId}`);
          return found;
        });
      });
    });

  project
    .command('archive <project-id>')
    .description('Archive a knowledge project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeProjectStore(db).archive(projectId)),
        (result) => console.log(`Archived knowledge project ${result.id}.`));
    });

  // -----------------------------------------------------------------
  // source
  // -----------------------------------------------------------------
  const source = knowledge.command('source').description('Inspect knowledge sources');

  source
    .command('scan <project-id> <root>')
    .description('Preview policy-approved files under a root without registering anything')
    .option('--max-bytes <n>', 'Maximum file size in bytes to consider', (v) => parseInt(v, 10))
    .option('--allow-binary', 'Allow binary files')
    .option('--json', 'Output JSON')
    .action(async (_projectId: string, root: string, opts: { maxBytes?: number; allowBinary?: boolean; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        scanKnowledgeSources(path.resolve(findWorkspaceRoot(), root), {
          workspaceRoot: findWorkspaceRoot(),
          maxBytes: opts.maxBytes,
          allowBinary: opts.allowBinary,
        }),
      (candidates) => {
        if (candidates.length === 0) {
          console.log('No policy-approved files found.');
          return;
        }
        for (const candidate of candidates) console.log(`${candidate.path}  (${candidate.size} bytes)`);
      });
    });

  source
    .command('list <project-id>')
    .description('List registered knowledge sources')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeSourceStore(db).list(projectId)),
        (results) => {
          if (results.length === 0) {
            console.log('No knowledge sources registered.');
            return;
          }
          for (const item of results) console.log(`[${item.extractionStatus}] ${item.id}  ${item.canonicalPath}`);
        });
    });

  source
    .command('show <project-id> <source-id>')
    .description('Show a registered knowledge source and its versions')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, sourceId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const store = new KnowledgeSourceStore(db);
          const found = store.get(projectId, sourceId as never);
          if (!found) throw new Error(`Knowledge source not found: ${sourceId}`);
          return { source: found, versions: store.listVersions(projectId, sourceId as never) };
        }),
      );
    });

  // -----------------------------------------------------------------
  // ingest
  // -----------------------------------------------------------------
  const ingest = knowledge.command('ingest').description('Register sources and queue knowledge generation jobs');

  ingest
    .command('file <project-id> <path>')
    .description('Extract, register, and queue a single file for knowledge generation')
    .option('-k, --job-kind <kind>', 'Queue job kind')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, filePath: string, opts: { jobKind?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, async () => {
        const workspaceRoot = findWorkspaceRoot();
        const relativePath = normalizeKnowledgePath(filePath);
        const decision = shouldIngestSource(relativePath, { workspaceRoot });
        if (decision.action !== 'ingest' || !decision.path) {
          throw new Error(`File is not eligible for ingestion (${decision.reason ?? 'rejected'}): ${relativePath}`);
        }
        const absolutePath = path.resolve(workspaceRoot, decision.path);
        const canonicalWorkspace = fs.realpathSync(workspaceRoot);
        const canonicalPath = fs.realpathSync(absolutePath);
        const relativeToWorkspace = path.relative(canonicalWorkspace, canonicalPath);
        const fileStats = fs.lstatSync(absolutePath);
        if (relativeToWorkspace.startsWith('..') || path.isAbsolute(relativeToWorkspace) || fileStats.isSymbolicLink() || !fileStats.isFile()) {
          throw new Error(`File must be a regular non-symlink file within the workspace: ${relativePath}`);
        }
        const content = fs.readFileSync(canonicalPath, 'utf8');
        const storedContentPath = storeImmutableKnowledgeSourceContent(workspaceRoot, decision.path, content);
        const ingestor = selectIngestor(decision.path);
        const extracted = await ingestor.extract({ content, path: decision.path });
        return withKnowledgeDb((db) => {
          const sourceStore = new KnowledgeSourceStore(db);
          const registered = sourceStore.register({
            projectId,
            kind: 'file',
            path: decision.path,
            content,
            contentPath: storedContentPath,
          });
          const versions = sourceStore.listVersions(projectId, registered.id);
          const latestVersion = versions.at(-1);
          const job = new KnowledgeQueue(db).enqueue({
            projectId,
            jobKind: opts.jobKind ?? 'analyze',
            sourceVersionId: latestVersion?.id,
            payload: { sourceId: registered.id, path: decision.path, headingCount: extracted.headings.length, linkCount: extracted.links.length },
          });
          return { source: registered, sourceVersionId: latestVersion?.id ?? null, job };
        });
      }, (result) => console.log(`Registered source ${result.source.id} and queued job ${result.job.id} (${result.job.status}).`));
    });

  ingest
    .command('folder <project-id> <root>')
    .description('Scan a folder for policy-approved files and ingest each one')
    .option('-k, --job-kind <kind>', 'Queue job kind')
    .option('--max-bytes <n>', 'Maximum file size in bytes to consider', (v) => parseInt(v, 10))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, root: string, opts: { jobKind?: string; maxBytes?: number; json?: boolean }) => {
      await runKnowledgeAction(opts, async () => {
        const workspaceRoot = findWorkspaceRoot();
        const candidates = await scanKnowledgeSources(path.resolve(workspaceRoot, root), {
          workspaceRoot,
          maxBytes: opts.maxBytes,
        });
        const results: Array<{ path: string; sourceId: string; jobId: string }> = [];
        for (const candidate of candidates) {
          const content = fs.readFileSync(candidate.absolutePath, 'utf8');
          const storedContentPath = storeImmutableKnowledgeSourceContent(workspaceRoot, candidate.path, content);
          await withKnowledgeDb(async (db) => {
            const sourceStore = new KnowledgeSourceStore(db);
            const registered = sourceStore.register({
              projectId,
              kind: 'file',
              path: candidate.path,
              content,
              contentPath: storedContentPath,
            });
            const versions = sourceStore.listVersions(projectId, registered.id);
            const latestVersion = versions.at(-1);
            const job = new KnowledgeQueue(db).enqueue({
              projectId,
              jobKind: opts.jobKind ?? 'analyze',
              sourceVersionId: latestVersion?.id,
              payload: { sourceId: registered.id, path: candidate.path },
            });
            results.push({ path: candidate.path, sourceId: registered.id, jobId: job.id });
          });
        }
        return results;
      }, (results) => {
        if (results.length === 0) {
          console.log('No policy-approved files found to ingest.');
          return;
        }
        for (const result of results) console.log(`${result.path} -> source ${result.sourceId}, job ${result.jobId}`);
      });
    });

  // -----------------------------------------------------------------
  // queue
  // -----------------------------------------------------------------
  const queue = knowledge.command('queue').description('Inspect and manage the knowledge generation queue');

  queue
    .command('list <project-id>')
    .description('List knowledge jobs for a project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeQueue(db).list(projectId)),
        (jobs) => {
          if (jobs.length === 0) {
            console.log('No knowledge jobs found.');
            return;
          }
          for (const job of jobs) console.log(`[${job.status}] ${job.id}  ${job.jobKind}  retries=${job.retryCount}/${job.maxRetries}`);
        });
    });

  queue
    .command('show <job-id>')
    .description('Show a knowledge job and its progress events')
    .option('--json', 'Output JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const queueStore = new KnowledgeQueue(db);
          const job = queueStore.get(jobId);
          if (!job) throw new Error(`Knowledge job not found: ${jobId}`);
          return { job, progress: queueStore.listProgress(jobId) };
        }),
      );
    });

  queue
    .command('claim <project-id>')
    .description('Claim the next queued job for a worker')
    .option('--worker <id>', 'Worker id')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { worker?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeQueue(db).claim(projectId, opts.worker ?? `cli-${process.pid}`)),
        (job) => console.log(job ? `Claimed job ${job.id} (${job.jobKind}).` : 'No queued jobs available.'));
    });

  queue
    .command('cancel <job-id>')
    .description('Cancel a queued or running job')
    .option('--json', 'Output JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeQueue(db).cancel(jobId)),
        (job) => console.log(`Cancelled job ${job.id}.`));
    });

  queue
    .command('retry <job-id>')
    .description('Retry a failed job')
    .option('--json', 'Output JSON')
    .action(async (jobId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeQueue(db).retry(jobId)),
        (job) => console.log(`Requeued job ${job.id}.`));
    });

  // -----------------------------------------------------------------
  // worker
  // -----------------------------------------------------------------
  const worker = knowledge.command('worker').description('Run and inspect the offline knowledge worker');

  worker
    .command('run <project-id>')
    .description('Drain queued knowledge jobs once or keep polling for new work')
    .option('--once', 'Drain currently eligible jobs and exit')
    .option('--watch', 'Keep polling for new jobs until interrupted')
    .option('--poll-ms <n>', 'Watch-mode poll interval in milliseconds', (value) => parseInt(value, 10))
    .option('--concurrency <n>', 'Worker concurrency (currently only 1 is supported)', (value) => parseInt(value, 10))
    .option('--worker <id>', 'Worker id (default: cli-<pid>)')
    .option('--json', 'Output JSON (supported only with --once)')
    .action(async (
      projectId: string,
      opts: { once?: boolean; watch?: boolean; pollMs?: number; concurrency?: number; worker?: string; json?: boolean },
    ) => {
      await runKnowledgeAction(opts, async () => {
        if (opts.once === opts.watch) {
          throw new Error('Knowledge worker run requires exactly one of --once or --watch');
        }
        const concurrency = requirePositiveInteger(opts.concurrency, 'Knowledge worker concurrency') ?? 1;
        if (concurrency !== 1) {
          throw new Error('Knowledge worker concurrency values above 1 are not supported by this CLI yet');
        }
        if (opts.watch && opts.json) {
          throw new Error('Knowledge worker --watch does not support --json because it must preserve a single JSON envelope');
        }

        const workerId = opts.worker?.trim() || `cli-${process.pid}`;
        if (opts.once) {
          return withKnowledgeDb((db) => createCliKnowledgeWorker(db, projectId, { workerId }).runOnce(projectId));
        }

        const pollMs = requirePositiveInteger(opts.pollMs, 'Knowledge worker poll interval') ?? 1_000;
        const controller = new AbortController();
        const handleSignal = (signal: NodeJS.Signals): void => {
          controller.abort(new Error(`Knowledge worker interrupted by ${signal}`));
        };
        process.on('SIGINT', handleSignal);
        process.on('SIGTERM', handleSignal);
        try {
          await withKnowledgeDb((db) => createCliKnowledgeWorker(db, projectId, { workerId, signal: controller.signal }).runWatch(projectId, { pollMs }));
          return { projectId, workerId, mode: 'watch', stopped: true };
        } finally {
          process.off('SIGINT', handleSignal);
          process.off('SIGTERM', handleSignal);
        }
      }, (result) => {
        if ('claimed' in result) {
          console.log(
            `Worker ${opts.worker ?? `cli-${process.pid}`} processed project ${result.projectId}: claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}, cancelled ${result.cancelled}.`,
          );
          if (result.warnings.length > 0) {
            console.log(`Warnings: ${result.warnings.length}`);
          }
          return;
        }
        console.log(`Worker ${result.workerId} stopped watching project ${result.projectId}.`);
      });
    });

  worker
    .command('status <project-id>')
    .description('Show bounded queue, lease, analyzer, and completion status for a project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => buildCliWorkerStatus(db, projectId)),
        (status) => {
          console.log(
            [
              `Queue: ${status.queue.queuedCount} queued, ${status.queue.runningCount} running (${status.activeWorkers.runningCount} with active leases), ${status.queue.completedCount} completed, ${status.queue.failedCount} failed, ${status.queue.cancelledCount} cancelled.`,
              `Workers: ${status.activeWorkers.workerCount} active.`,
              `Completions: ${status.completions.deterministic} deterministic, ${status.completions.enriched} enriched.`,
            ].join(' '),
          );
          if (status.queue.oldestQueuedRequestedAt) {
            console.log(`Oldest queued job: ${status.queue.oldestQueuedRequestedAt} (${status.queue.oldestQueuedAgeMs ?? 0}ms old).`);
          }
          if (status.recentFailureCodes.length > 0) {
            console.log(`Recent failure codes: ${status.recentFailureCodes.map((item) => `${item.code}×${item.count}`).join(', ')}`);
          }
        });
    });

  // -----------------------------------------------------------------
  // provider
  // -----------------------------------------------------------------
  const provider = knowledge.command('provider').description('Manage knowledge provider profiles');

  provider
    .command('add <project-id> <profile-name>')
    .description('Add a non-secret knowledge provider profile')
    .requiredOption('--kind <kind>', 'Provider kind (currently only openai-compatible)')
    .requiredOption('--endpoint <url>', 'Provider endpoint URL')
    .requiredOption('--model <model>', 'Provider model name')
    .requiredOption('--capabilities <csv>', 'Comma-separated capabilities (analysis,generation)')
    .option('--timeout-ms <n>', 'Provider timeout in milliseconds', (value) => parseInt(value, 10))
    .option('--api-key-env <name>', 'Environment-variable name containing the provider API key')
    .option('--json', 'Output JSON')
    .action(async (
      projectId: string,
      profileName: string,
      opts: {
        kind: string;
        endpoint: string;
        model: string;
        capabilities: string;
        timeoutMs?: number;
        apiKeyEnv?: string;
        json?: boolean;
      },
    ) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          if (opts.kind !== 'openai-compatible') {
            throw new Error(`Unsupported knowledge provider kind: ${opts.kind}`);
          }
          const capabilities = parseCsv(opts.capabilities);
          if (!capabilities || capabilities.length === 0) {
            throw new Error('Knowledge provider capabilities must not be empty');
          }
          return new KnowledgeProviderProfileStore(db).create({
            projectId,
            profileName,
            endpoint: opts.endpoint,
            model: opts.model,
            capabilities: capabilities as KnowledgeProviderCapability[],
            timeoutMs: opts.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
            apiKeyEnv: opts.apiKeyEnv,
          });
        }),
      (result) => console.log(`Added provider profile ${result.profileName} (${result.providerKind}).`));
    });

  provider
    .command('list <project-id>')
    .description('List provider profiles for a project')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => new KnowledgeProviderProfileStore(db).listWithDiagnostics(projectId)),
      (result) => {
        if (result.profiles.length === 0) {
          console.log('No knowledge provider profiles found.');
          return;
        }
        for (const profile of result.profiles) {
          console.log(
            `[${profile.enabled ? 'enabled' : 'disabled'}] ${profile.profileName}  ${profile.providerKind}  ${profile.model}  ${profile.endpoint}`,
          );
        }
      });
    });

  provider
    .command('test <project-id> <profile-name>')
    .description('Validate a provider profile without persisting any secret value')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, profileName: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => createCliProviderStore(db, projectId, { includeDisabled: true, testProfileName: profileName }).test(projectId, profileName, process.env)),
      (result) => {
        console.log(
          result.success
            ? `Provider profile ${result.profile.profileName} passed validation.`
            : `Provider profile ${result.profile.profileName} failed validation.`,
        );
        for (const warning of result.warnings) {
          console.log(`warning: ${warning.code} ${warning.message}`);
        }
        for (const diagnostic of result.diagnostics) {
          console.log(`diagnostic: ${diagnostic}`);
        }
      });
    });

  provider
    .command('enable <project-id> <profile-name>')
    .description('Enable a provider profile')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, profileName: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeProviderProfileStore(db).setEnabled(projectId, profileName, true)),
        (result) => console.log(`Enabled provider profile ${result.profileName}.`));
    });

  provider
    .command('disable <project-id> <profile-name>')
    .description('Disable a provider profile')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, profileName: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeProviderProfileStore(db).setEnabled(projectId, profileName, false)),
        (result) => console.log(`Disabled provider profile ${result.profileName}.`));
    });

  provider
    .command('remove <project-id> <profile-name>')
    .description('Remove a provider profile')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, profileName: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const store = new KnowledgeProviderProfileStore(db);
          const profile = store.get(projectId, profileName);
          if (!profile) {
            throw new Error(`Knowledge provider profile not found: ${profileName}`);
          }
          store.remove(projectId, profileName);
          return { removed: true, profileName: profile.profileName };
        }),
      (result) => console.log(`Removed provider profile ${result.profileName}.`));
    });

  // -----------------------------------------------------------------
  // page
  // -----------------------------------------------------------------
  const page = knowledge.command('page').description('Inspect generated knowledge pages');

  page
    .command('list <project-id>')
    .description('List knowledge pages')
    .option('-t, --type <type>', 'Filter by page type')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { type?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => new KnowledgePageStore(db).listPages(projectId, opts.type as never)),
      (pages) => {
        if (pages.length === 0) {
          console.log('No knowledge pages found.');
          return;
        }
        for (const item of pages) console.log(`[${item.status}] ${item.id}  v${item.currentVersion}  ${item.title}  (${item.slug})`);
      });
    });

  page
    .command('show <project-id> <page-id>')
    .description('Show the current version of a knowledge page')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, pageId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const found = new KnowledgePageStore(db).getCurrentPage(projectId, pageId as never);
          if (!found) throw new Error(`Knowledge page not found: ${pageId}`);
          return found;
        }),
      );
    });

  // -----------------------------------------------------------------
  // search
  // -----------------------------------------------------------------
  knowledge
    .command('search <project-id> <query>')
    .description('Search knowledge pages, sources, and tasks with citations')
    .option('-m, --mode <mode>', 'knowledge|sources|tasks|hybrid|read-sources-only')
    .option('-l, --limit <n>', 'Max results', (v) => parseInt(v, 10))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, query: string, opts: { mode?: KnowledgeSearchMode; limit?: number; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => searchKnowledge(query, { db, projectId, mode: opts.mode ?? 'hybrid', limit: opts.limit })),
      (results) => {
        if (results.length === 0) {
          console.log('No results.');
          return;
        }
        for (const result of results) {
          console.log(`[${result.kind}] ${result.title}  (score ${result.score.toFixed(2)})`);
          console.log(`  ${result.snippet}`);
          for (const citation of result.citations) {
            console.log(`  citation: ${citation.pageId ?? citation.sourceId ?? ''}${citation.path ? ` (${citation.path})` : ''}`);
          }
        }
      });
    });

  // -----------------------------------------------------------------
  // graph
  // -----------------------------------------------------------------
  const graph = knowledge.command('graph').description('Inspect the native knowledge graph');

  graph
    .command('nodes <project-id>')
    .description('List graph nodes')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeGraph(db).listGraphNodes(projectId)),
        (nodes) => {
          if (nodes.length === 0) {
            console.log('No graph nodes found.');
            return;
          }
          for (const node of nodes) console.log(`${node.id}  [${node.nodeType}]  ${node.label}`);
        });
    });

  graph
    .command('edges <project-id>')
    .description('List graph edges')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeGraph(db).listGraphEdges(projectId)),
        (edges) => {
          if (edges.length === 0) {
            console.log('No graph edges found.');
            return;
          }
          for (const edge of edges) console.log(`${edge.sourceNodeId} -[${edge.edgeType}]-> ${edge.targetNodeId}  (weight ${edge.weight.toFixed(2)})`);
        });
    });

  graph
    .command('neighborhood <project-id> <node-id>')
    .description('Show a node neighborhood')
    .option('--max-hops <n>', 'Max hops', (v) => parseInt(v, 10))
    .option('--json', 'Output JSON')
    .action(async (projectId: string, nodeId: string, opts: { maxHops?: number; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => new KnowledgeGraph(db).getGraphNeighborhood(nodeId, { projectId, maxHops: opts.maxHops })),
      );
    });

  graph
    .command('path <project-id> <from-node-id> <to-node-id>')
    .description('Find a path between two graph nodes')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, fromNodeId: string, toNodeId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const found = new KnowledgeGraph(db).findGraphPath(fromNodeId, toNodeId, { projectId });
          if (!found) throw new Error(`No path found between ${fromNodeId} and ${toNodeId}`);
          return found;
        }),
      );
    });

  graph
    .command('import-graphify <project-id> <file>')
    .description('Import a Graphify JSON export into the native knowledge graph')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, file: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, async () => {
        const { importGraphifyJson } = await import('@ariadne-dev/core');
        const raw = fs.readFileSync(path.resolve(findWorkspaceRoot(), file), 'utf8');
        const imported = importGraphifyJson(raw);
        return withKnowledgeDb((db) => {
          const graphStore = new KnowledgeGraph(db);
          const idMap = new Map<string, string>();
          for (const node of imported.nodes) {
            const created = graphStore.upsertGraphNode({
              id: createKnowledgeId('graph-node', `${projectId}:${node.id}`),
              projectId,
              nodeType: node.nodeType,
              label: node.label,
              sourceId: node.id,
            });
            idMap.set(node.id, created.id);
          }
          let edgeCount = 0;
          for (const edge of imported.edges) {
            const sourceNodeId = idMap.get(edge.sourceNodeId);
            const targetNodeId = idMap.get(edge.targetNodeId);
            if (!sourceNodeId || !targetNodeId) continue;
            graphStore.upsertGraphEdge({
              projectId,
              sourceNodeId,
              targetNodeId,
              edgeType: edge.edgeType,
              evidence: edge.evidence,
              confidence: edge.confidence,
            });
            edgeCount += 1;
          }
          return { nodeCount: imported.nodes.length, edgeCount, rejectedEdges: imported.rejectedEdges };
        });
      });
    });

  // -----------------------------------------------------------------
  // review
  // -----------------------------------------------------------------
  const review = knowledge.command('review').description('Manage the knowledge review queue');

  review
    .command('list <project-id>')
    .description('List knowledge reviews')
    .option('-s, --status <status>', 'pending|approved|rejected|dismissed')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { status?: KnowledgeReviewStatus; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => listKnowledgeReviews(db, projectId, opts.status ? { status: opts.status } : undefined)),
      (reviews) => {
        if (reviews.length === 0) {
          console.log('No knowledge reviews found.');
          return;
        }
        for (const item of reviews) console.log(`[${item.status}] ${item.id}  ${item.summary ?? '(no summary)'}`);
      });
    });

  review
    .command('create <project-id>')
    .description('Create a pending knowledge review')
    .option('--page-version <id>', 'Related page version id')
    .option('--summary <text>', 'Review summary')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { pageVersion?: string; summary?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => createKnowledgeReview(db, { projectId, pageVersionId: opts.pageVersion, summary: opts.summary })),
      (result) => console.log(`Created knowledge review ${result.id}.`));
    });

  review
    .command('resolve <review-id> <action>')
    .description(`Resolve a review (action: accept|reject|edit|merge|skip|research|create_task|label)`)
    .requiredOption('--actor <id>', 'Actor id (person or automation) performing the resolution')
    .requiredOption('--source <source>', 'Where this resolution came from (e.g. "cli")')
    .option('--evidence-kind <kind>', 'Evidence kind')
    .option('--evidence-id <id>', 'Evidence id')
    .option('--evidence-detail <detail>', 'Evidence detail')
    .option('--comment <text>', 'Resolution comment')
    .option('--json', 'Output JSON')
    .action(async (
      reviewId: string,
      action: KnowledgeReviewAction,
      opts: { actor: string; source: string; evidenceKind?: string; evidenceId?: string; evidenceDetail?: string; comment?: string; json?: boolean },
    ) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) =>
          resolveKnowledgeReview(db, reviewId, {
            action,
            actorId: opts.actor,
            source: opts.source,
            comment: opts.comment,
            evidence: opts.evidenceKind && opts.evidenceId ? { kind: opts.evidenceKind, id: opts.evidenceId, detail: opts.evidenceDetail } : undefined,
          }),
        ),
      (result) => console.log(`Resolved review ${result.id} as ${result.status}.`));
    });

  review
    .command('reopen <review-id>')
    .description('Reopen a resolved review back to pending')
    .requiredOption('--actor <id>', 'Actor id')
    .requiredOption('--source <source>', 'Source of this action')
    .option('--comment <text>', 'Comment')
    .option('--json', 'Output JSON')
    .action(async (reviewId: string, opts: { actor: string; source: string; comment?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => reopenKnowledgeReview(db, reviewId, { actorId: opts.actor, source: opts.source, comment: opts.comment })),
      (result) => console.log(`Reopened review ${result.id}.`));
    });

  // -----------------------------------------------------------------
  // research
  // -----------------------------------------------------------------
  knowledge
    .command('research <project-id> <query>')
    .description(
      'Run a research request end-to-end (create, confirm, and execute in a single call). Provider profiles do not ' +
        'currently enable research execution in the CLI, so this still fails with a clear "provider required" error ' +
        'rather than making any implicit network call.',
    )
    .option('--parent-task <id>', 'Parent Ariadne task id')
    .option('--child-task', 'Create a child task for the research result')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, query: string, opts: { parentTask?: string; childTask?: boolean; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb(async (db) => {
          const service = new KnowledgeResearchService({
            sourceStore: new KnowledgeSourceStore(db),
            pageStore: new KnowledgePageStore(db),
            queue: new KnowledgeQueue(db),
          });
          const request = service.createResearchRequest({ projectId, query, parentTaskId: opts.parentTask, createChildTask: opts.childTask });
          service.confirmResearchRequest(request.id);
          return service.runResearchRequest(request.id);
        }),
      );
    });

  // -----------------------------------------------------------------
  // chat
  // -----------------------------------------------------------------
  const chat = knowledge.command('chat').description('Knowledge-aware chat conversations');

  chat
    .command('create <project-id>')
    .description('Create a knowledge chat conversation')
    .option('--title <title>', 'Conversation title')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { title?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) =>
          new KnowledgeChatService(db, new KnowledgeProviderRegistry(), UNCONFIGURED_CHAT_PROVIDER).createConversation({ projectId, title: opts.title }),
        ),
      (result) => console.log(`Created conversation ${result.id}.`));
    });

  chat
    .command('list <project-id>')
    .description('List knowledge chat conversations')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) =>
          new KnowledgeChatService(db, new KnowledgeProviderRegistry(), UNCONFIGURED_CHAT_PROVIDER).listConversations(projectId),
        ),
      (conversations) => {
        if (conversations.length === 0) {
          console.log('No conversations found.');
          return;
        }
        for (const item of conversations) console.log(`${item.id}  ${item.title ?? '(untitled)'}`);
      });
    });

  chat
    .command('history <conversation-id>')
    .description('Show messages in a knowledge chat conversation')
    .option('--json', 'Output JSON')
    .action(async (conversationId: string, opts: { json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) =>
          new KnowledgeChatService(db, new KnowledgeProviderRegistry(), UNCONFIGURED_CHAT_PROVIDER).listMessages(conversationId),
        ),
      (messages) => {
        if (messages.length === 0) {
          console.log('No messages found.');
          return;
        }
        for (const item of messages) console.log(`[${item.role}] ${item.content}`);
      });
    });

  chat
    .command('send <conversation-id> <message>')
    .description(
      'Send a message in a knowledge chat conversation. Provider profiles do not currently enable chat execution in ' +
        'the CLI, so this still fails with a clear "provider required" error.',
    )
    .option('-m, --mode <mode>', 'knowledge|sources|tasks|hybrid|read-sources-only')
    .option('--json', 'Output JSON')
    .action(async (conversationId: string, message: string, opts: { mode?: KnowledgeSearchMode; json?: boolean }) => {
      await runKnowledgeAction(opts, async () => {
        const providers = new KnowledgeProviderRegistry();
        if (!providers.supports('chat')) throw new KnowledgeProviderRequiredError('chat');
        return withKnowledgeDb(async (db) => {
          const service = new KnowledgeChatService(db, providers, UNCONFIGURED_CHAT_PROVIDER);
          const events = [];
          for await (const event of service.streamKnowledgeChat({ conversationId, query: message, mode: opts.mode ?? 'hybrid' })) {
            events.push(event);
          }
          return events;
        });
      });
    });

  // -----------------------------------------------------------------
  // export / import
  // -----------------------------------------------------------------
  knowledge
    .command('export <project-id> <output-dir>')
    .description('Export a knowledge project (pages, graph, and metadata) to a portable, Obsidian-compatible directory')
    .option('--obsidian', 'Include Obsidian vault config files')
    .option('--json', 'Output JSON')
    .action(async (projectId: string, outputDir: string, opts: { obsidian?: boolean; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const archive = exportKnowledgeProject(db, { projectId, includeObsidian: opts.obsidian });
          const resolvedOutputDir = path.resolve(findWorkspaceRoot(), outputDir);
          fs.mkdirSync(resolvedOutputDir, { recursive: true });
          fs.writeFileSync(path.join(resolvedOutputDir, 'manifest.json'), `${JSON.stringify(archive.manifest, null, 2)}\n`, 'utf8');
          for (const [relativePath, content] of Object.entries(archive.files)) {
            const target = path.join(resolvedOutputDir, relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content as KnowledgeArchiveFile);
          }
          return { outputDir: resolvedOutputDir, fileCount: archive.manifest.entries.length };
        }),
      (result) => console.log(`Exported ${result.fileCount} file(s) to ${result.outputDir}.`));
    });

  knowledge
    .command('import <project-id> <input-dir>')
    .description('Import a knowledge project previously written by "ariadne knowledge export"')
    .option('--replace', 'Replace an existing project with the same id')
    .option('--json', 'Output JSON')
    .action(async (_projectId: string, inputDir: string, opts: { replace?: boolean; json?: boolean }) => {
      await runKnowledgeAction(opts, () =>
        withKnowledgeDb((db) => {
          const resolvedInputDir = fs.realpathSync(path.resolve(findWorkspaceRoot(), inputDir));
          const manifestPath = path.join(resolvedInputDir, 'manifest.json');
          if (fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error('Knowledge archive manifest must not be a symbolic link');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as KnowledgeArchive['manifest'];
          const files: Record<string, KnowledgeArchiveFile> = {};
          for (const entry of manifest.entries) {
            const normalized = entry.path.replaceAll('\\', '/');
            if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..') || path.posix.normalize(normalized) !== normalized) {
              throw new Error(`Knowledge archive path traversal rejected: ${entry.path}`);
            }
            const target = path.resolve(resolvedInputDir, normalized);
            const canonicalTarget = fs.realpathSync(target);
            const relativeToInput = path.relative(resolvedInputDir, canonicalTarget);
            const entryStats = fs.lstatSync(target);
            if (relativeToInput.startsWith('..') || path.isAbsolute(relativeToInput) || entryStats.isSymbolicLink() || !entryStats.isFile()) {
              throw new Error(`Knowledge archive entry must stay within the input directory: ${entry.path}`);
            }
            files[normalized] = fs.readFileSync(canonicalTarget);
          }
          return importKnowledgeProject(db, { manifest, files }, { replaceExisting: opts.replace });
        }),
      (result) => console.log(`Imported project ${result.projectId}: ${result.tables} table(s), ${result.rows} row(s), ${result.files.length} file(s).`));
    });
}
