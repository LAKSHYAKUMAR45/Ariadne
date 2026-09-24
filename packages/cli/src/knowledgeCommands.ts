import * as fs from 'node:fs';
import * as path from 'node:path';
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
} from '@ariadne-dev/core';
import type {
  KnowledgeIngestor,
  KnowledgeSearchMode,
  KnowledgeReviewAction,
  KnowledgeReviewStatus,
  KnowledgeArchive,
  KnowledgeArchiveFile,
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

function selectIngestor(inputPath: string): KnowledgeIngestor {
  const ingestor = INGESTORS.find((candidate) => candidate.supports({ content: '', path: inputPath }));
  return ingestor ?? new PlainTextIngestor();
}

/**
 * Registers the `ariadne knowledge ...` command tree onto `program`. Every
 * leaf command opens the shared workspace `state.db`, delegates to the
 * matching `@ariadne-dev/core` knowledge service, and closes the database
 * before returning — no command holds core state across invocations, since
 * each CLI call is a fresh process. Chat/research commands that require an
 * LLM/search provider fail deterministically with a `provider_required`-style
 * error when no provider is configured (which is always true today: this
 * CLI does not yet persist provider configuration), matching the "works
 * fully offline/no-provider" contract for the rest of the knowledge surface.
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
        const content = fs.readFileSync(absolutePath, 'utf8');
        const ingestor = selectIngestor(decision.path);
        const extracted = await ingestor.extract({ content, path: decision.path });
        return withKnowledgeDb((db) => {
          const sourceStore = new KnowledgeSourceStore(db);
          const registered = sourceStore.register({ projectId, kind: 'file', path: decision.path, content });
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
          await withKnowledgeDb(async (db) => {
            const sourceStore = new KnowledgeSourceStore(db);
            const registered = sourceStore.register({ projectId, kind: 'file', path: candidate.path, content });
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
    .action(async (_projectId: string, opts: { worker?: string; json?: boolean }) => {
      await runKnowledgeAction(opts, () => withKnowledgeDb((db) => new KnowledgeQueue(db).claim(opts.worker ?? `cli-${process.pid}`)),
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
      'Run a research request end-to-end (create, confirm, and execute in a single call). Requires a configured ' +
        'research provider; the CLI does not persist provider configuration, so this currently always fails with a ' +
        'clear "provider required" error rather than making any network call.',
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
      'Send a message in a knowledge chat conversation. Requires a configured chat provider; the CLI does not ' +
        'persist provider configuration, so this currently always fails with a clear "provider required" error.',
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
          const resolvedInputDir = path.resolve(findWorkspaceRoot(), inputDir);
          const manifest = JSON.parse(fs.readFileSync(path.join(resolvedInputDir, 'manifest.json'), 'utf8')) as KnowledgeArchive['manifest'];
          const files: Record<string, KnowledgeArchiveFile> = {};
          for (const entry of manifest.entries) {
            files[entry.path] = fs.readFileSync(path.join(resolvedInputDir, entry.path));
          }
          return importKnowledgeProject(db, { manifest, files }, { replaceExisting: opts.replace });
        }),
      (result) => console.log(`Imported project ${result.projectId}: ${result.tables} table(s), ${result.rows} row(s), ${result.files.length} file(s).`));
    });
}
