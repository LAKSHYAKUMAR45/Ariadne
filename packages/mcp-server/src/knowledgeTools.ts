import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  KnowledgeGraph,
  KnowledgePageStore,
  KnowledgeProjectStore,
  KnowledgeQueue,
  KnowledgeSourceStore,
  buildKnowledgeManifest,
  buildKnowledgeSearchContext,
  createKnowledgeReview,
  createPageVersion,
  getCurrentPage,
  listKnowledgeReviews,
  listPages,
  readKnowledgeManifest,
  reopenKnowledgeReview,
  renderKnowledgeOverview,
  resolveKnowledgeReview,
  searchKnowledge,
  writeKnowledgeManifest,
  type KnowledgePageType,
  type KnowledgeReviewAction,
  type KnowledgeSearchMode,
  openDatabase,
} from '@ariadne-dev/core';
import { KNOWLEDGE_MCP_LIMITS, validateKnowledgeLimit } from './tools.js';

const MAX_LIMIT = KNOWLEDGE_MCP_LIMITS.maxResults;
const MAX_CONTENT = KNOWLEDGE_MCP_LIMITS.maxContentCharacters;

export interface KnowledgeMcpContext {
  db: ReturnType<typeof openDatabase>;
  workspaceRoot: string;
}

export interface KnowledgeCitation {
  kind: 'project' | 'source' | 'page' | 'graph' | 'review' | 'job';
  id: string;
}

interface KnowledgeEnvelope<T> {
  data: T;
  citations: KnowledgeCitation[];
}

function boundedLimit(value: number | undefined): number {
  return validateKnowledgeLimit(value);
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Knowledge ${label} must not be empty`);
  return normalized;
}

function requireWrite(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new Error('Knowledge mutation requires confirm=true');
  }
}

function envelope<T>(data: T, citations: KnowledgeCitation[] = []): KnowledgeEnvelope<T> {
  return { data, citations };
}

function project(db: ReturnType<typeof openDatabase>, projectId: string) {
  const result = new KnowledgeProjectStore(db).get(requiredText(projectId, 'project ID'));
  if (!result) throw new Error(`Knowledge project not found: ${projectId}`);
  return result;
}

function page(db: ReturnType<typeof openDatabase>, projectId: string, pageId: string) {
  const result = getCurrentPage(db, requiredText(projectId, 'project ID'), requiredText(pageId, 'page ID') as never);
  if (!result) throw new Error(`Knowledge page not found: ${pageId}`);
  return result;
}

function source(db: ReturnType<typeof openDatabase>, projectId: string, sourceId: string) {
  const result = new KnowledgeSourceStore(db).get(requiredText(projectId, 'project ID'), requiredText(sourceId, 'source ID') as never);
  if (!result) throw new Error(`Knowledge source not found: ${sourceId}`);
  return result;
}

function jsonResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
}

export function registerKnowledgeTools(server: McpServer, context: KnowledgeMcpContext): void {
  const { db, workspaceRoot } = context;
  const projects = new KnowledgeProjectStore(db);
  const sources = new KnowledgeSourceStore(db);
  const queue = new KnowledgeQueue(db);
  const graph = new KnowledgeGraph(db);
  const pages = new KnowledgePageStore(db);

  server.registerTool(
    'knowledge_project_list',
    {
      title: 'List knowledge projects',
      description: 'Lists knowledge projects in this Ariadne workspace.',
      inputSchema: { status: z.enum(['active', 'archived']).optional() },
    },
    async (args) => {
      try {
        return jsonResult(envelope(projects.list(args.status ? { status: args.status } : {})));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_project_create',
    {
      title: 'Create a knowledge project',
      description: 'Creates a project configuration. Set confirm=true to authorize the mutation.',
      inputSchema: {
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        roots: z.array(z.string()).max(MAX_LIMIT).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const created = projects.create({
          name: args.name,
          description: args.description,
          roots: args.roots,
          workspaceRoot,
        });
        return jsonResult(envelope(created, [{ kind: 'project', id: created.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_project_archive',
    {
      title: 'Archive a knowledge project',
      description: 'Archives a project without deleting its sources or pages. Set confirm=true to authorize.',
      inputSchema: { projectId: z.string().min(1), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const archived = projects.archive(args.projectId);
        return jsonResult(envelope(archived, [{ kind: 'project', id: archived.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_source_list',
    {
      title: 'List knowledge sources',
      description: 'Lists registered sources for a project, including stale sources.',
      inputSchema: { projectId: z.string().min(1), limit: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = sources.list(args.projectId).slice(0, boundedLimit(args.limit));
        return jsonResult(envelope(result, result.map((item) => ({ kind: 'source', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_source_get',
    {
      title: 'Get a knowledge source',
      description: 'Returns one source and its version history.',
      inputSchema: { projectId: z.string().min(1), sourceId: z.string().min(1) },
    },
    async (args) => {
      try {
        const result = source(db, args.projectId, args.sourceId);
        return jsonResult(envelope({ source: result, versions: sources.listVersions(args.projectId, result.id) }, [{ kind: 'source', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_source_register',
    {
      title: 'Register a knowledge source',
      description: 'Registers source metadata and a content hash. Content itself is not accepted through MCP.',
      inputSchema: {
        projectId: z.string().min(1),
        kind: z.enum(['file', 'url', 'task_history', 'web_clip', 'manual']),
        path: z.string().optional(),
        url: z.string().url().optional(),
        contentHash: z.string().min(1),
        contentPath: z.string().min(1),
        mimeType: z.string().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        project(db, args.projectId);
        const result = sources.register(args);
        return jsonResult(envelope(result, [{ kind: 'source', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_source_delete',
    {
      title: 'Mark a knowledge source stale',
      description: 'Marks a source stale while preserving its provenance. Set confirm=true to authorize.',
      inputSchema: { projectId: z.string().min(1), sourceId: z.string().min(1), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const result = sources.markDeleted(args.projectId, args.sourceId as never);
        return jsonResult(envelope(result, [{ kind: 'source', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_queue_list',
    {
      title: 'List knowledge queue jobs',
      description: 'Lists bounded queue state for a project.',
      inputSchema: { projectId: z.string().min(1), limit: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = queue.list(args.projectId).slice(0, boundedLimit(args.limit));
        return jsonResult(envelope(result, result.map((item) => ({ kind: 'job', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_queue_enqueue',
    {
      title: 'Enqueue knowledge work',
      description: 'Enqueues deterministic or provider-backed work for a project.',
      inputSchema: {
        projectId: z.string().min(1),
        jobKind: z.string().min(1),
        payload: z.record(z.unknown()).default({}),
        sourceVersionId: z.string().optional(),
        maxRetries: z.number().int().nonnegative().max(10).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        project(db, args.projectId);
        const result = queue.enqueue(args);
        return jsonResult(envelope(result, [{ kind: 'job', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_queue_cancel',
    {
      title: 'Cancel a knowledge job',
      description: 'Cancels queued or running work. Set confirm=true to authorize.',
      inputSchema: { jobId: z.string().min(1), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const result = queue.cancel(args.jobId);
        return jsonResult(envelope(result, [{ kind: 'job', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_page_list',
    {
      title: 'List knowledge pages',
      description: 'Lists pages for a project with a bounded result count.',
      inputSchema: { projectId: z.string().min(1), type: z.string().optional(), limit: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = listPages(db, args.projectId, args.type as KnowledgePageType | undefined).slice(0, boundedLimit(args.limit));
        return jsonResult(envelope(result, result.map((item) => ({ kind: 'page', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_page_get',
    {
      title: 'Get a knowledge page',
      description: 'Returns page metadata, current provenance, and its generated content path.',
      inputSchema: { projectId: z.string().min(1), pageId: z.string().min(1) },
    },
    async (args) => {
      try {
        const result = page(db, args.projectId, args.pageId);
        return jsonResult(envelope(result, [{ kind: 'page', id: result.id }, ...result.provenance.map((item) => ({ kind: 'source' as const, id: item.id }))]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_page_create',
    {
      title: 'Create a knowledge page version',
      description: 'Creates a page version with explicit provenance. Set confirm=true to authorize.',
      inputSchema: {
        projectId: z.string().min(1),
        pageId: z.string().optional(),
        type: z.string().min(1),
        title: z.string().min(1),
        slug: z.string().min(1),
        content: z.string().min(1).max(MAX_CONTENT),
        summary: z.string().nullable().optional(),
        sourceVersionIds: z.array(z.string()).max(MAX_LIMIT).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        project(db, args.projectId);
        const result = createPageVersion(db, args as never);
        return jsonResult(envelope(result, [{ kind: 'page', id: result.pageId }, ...result.provenance.map((item) => ({ kind: 'source' as const, id: item.id }))]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_search',
    {
      title: 'Search knowledge',
      description: 'Searches pages, sources, and tasks with citations and bounded graph expansion.',
      inputSchema: {
        projectId: z.string().min(1),
        query: z.string().min(1),
        mode: z.enum(['knowledge', 'sources', 'tasks', 'hybrid', 'read-sources-only']).optional(),
        limit: z.number().int().positive().max(MAX_LIMIT).optional(),
        tokenBudget: z.number().int().positive().max(20_000).optional(),
      },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const results = searchKnowledge(requiredText(args.query, 'search query'), {
          db,
          projectId: args.projectId,
          mode: args.mode as KnowledgeSearchMode | undefined,
          limit: boundedLimit(args.limit),
        });
        return jsonResult(envelope(buildKnowledgeSearchContext(results, { tokenBudget: args.tokenBudget }), results.flatMap((item) => item.citations.map((citation) => ({ kind: citation.pageId ? 'page' as const : 'source' as const, id: citation.pageId ?? citation.sourceId ?? item.id })))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_graph_neighborhood',
    {
      title: 'Read graph neighborhood',
      description: 'Reads a bounded graph neighborhood around a node.',
      inputSchema: { projectId: z.string().min(1), nodeId: z.string().min(1), maxHops: z.number().int().nonnegative().max(5).optional(), maxNodes: z.number().int().positive().max(MAX_LIMIT).optional(), maxEdges: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = graph.getGraphNeighborhood(args.nodeId, { projectId: args.projectId, maxHops: args.maxHops, maxNodes: args.maxNodes ?? MAX_LIMIT, maxEdges: args.maxEdges ?? MAX_LIMIT });
        return jsonResult(envelope(result, result.nodes.map((item) => ({ kind: 'graph', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_graph_path',
    {
      title: 'Find a graph path',
      description: 'Finds a bounded directed or undirected path between two graph nodes.',
      inputSchema: { projectId: z.string().min(1), sourceNodeId: z.string().min(1), targetNodeId: z.string().min(1), maxHops: z.number().int().nonnegative().max(5).optional(), maxNodes: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = graph.findGraphPath(args.sourceNodeId, args.targetNodeId, { projectId: args.projectId, maxHops: args.maxHops, maxNodes: args.maxNodes ?? MAX_LIMIT });
        if (!result) throw new Error('Knowledge graph path not found');
        return jsonResult(envelope(result, result.nodes.map((item) => ({ kind: 'graph', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_review_list',
    {
      title: 'List knowledge reviews',
      description: 'Lists pending or resolved reviews with a bounded limit.',
      inputSchema: { projectId: z.string().min(1), status: z.enum(['pending', 'approved', 'rejected', 'dismissed']).optional(), limit: z.number().int().positive().max(MAX_LIMIT).optional() },
    },
    async (args) => {
      try {
        project(db, args.projectId);
        const result = listKnowledgeReviews(db, args.projectId, { status: args.status, limit: boundedLimit(args.limit) });
        return jsonResult(envelope(result, result.map((item) => ({ kind: 'review', id: item.id }))));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_review_resolve',
    {
      title: 'Resolve a knowledge review',
      description: 'Records an auditable review decision. Set confirm=true to authorize.',
      inputSchema: { reviewId: z.string().min(1), action: z.enum(['accept', 'reject', 'edit', 'merge', 'skip', 'research', 'create_task', 'label']), actorId: z.string().min(1), source: z.string().min(1), evidence: z.object({ kind: z.string().min(1), id: z.string().min(1), detail: z.string().optional() }), comment: z.string().optional(), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const result = resolveKnowledgeReview(db, args.reviewId, { ...args, action: args.action as KnowledgeReviewAction });
        return jsonResult(envelope(result, [{ kind: 'review', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_research',
    {
      title: 'Queue knowledge research',
      description: 'Queues a research request without making network calls in the MCP adapter.',
      inputSchema: { projectId: z.string().min(1), query: z.string().min(1), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        project(db, args.projectId);
        const result = queue.enqueue({ projectId: args.projectId, jobKind: 'research', payload: { query: requiredText(args.query, 'research query') } });
        return jsonResult(envelope(result, [{ kind: 'job', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_chat',
    {
      title: 'Queue knowledge chat',
      description: 'Queues a chat turn for later provider execution while preserving project scope.',
      inputSchema: { projectId: z.string().min(1), message: z.string().min(1).max(MAX_CONTENT), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        project(db, args.projectId);
        const result = queue.enqueue({ projectId: args.projectId, jobKind: 'chat', payload: { message: requiredText(args.message, 'chat message') } });
        return jsonResult(envelope(result, [{ kind: 'job', id: result.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_export',
    {
      title: 'Export knowledge manifest',
      description: 'Writes the current project manifest to the workspace knowledge directory.',
      inputSchema: { projectId: z.string().min(1), confirm: z.boolean().optional() },
    },
    async (args) => {
      try {
        requireWrite(args.confirm);
        const current = project(db, args.projectId);
        const manifest = buildKnowledgeManifest(current.id);
        writeKnowledgeManifest(workspaceRoot, manifest);
        return jsonResult(envelope(manifest, [{ kind: 'project', id: current.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_import',
    {
      title: 'Read knowledge manifest',
      description: 'Validates and reads an existing knowledge manifest without importing untrusted content.',
      inputSchema: { projectId: z.string().min(1) },
    },
    async (args) => {
      try {
        const current = project(db, args.projectId);
        return jsonResult(envelope(readKnowledgeManifest(workspaceRoot, current.id), [{ kind: 'project', id: current.id }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerResource(
    'knowledge-project-overview',
    'ariadne://knowledge/project/current',
    { title: 'Current knowledge project overview', description: 'Project overview and bounded page/source counts.', mimeType: 'application/json' },
    async (uri) => {
      try {
        const current = projects.list({ status: 'active' })[0];
        if (!current) throw new Error('No active knowledge project found');
        const overview = renderKnowledgeOverview(
          current.name,
          listPages(db, current.id).slice(0, MAX_LIMIT).map((item) => ({
            id: item.id,
            slug: item.slug,
            title: item.title,
            type: item.type,
            summary: item.summary,
            status: item.status,
            version: item.currentVersion,
            updatedAt: item.updatedAt,
          })),
          current.description,
        );
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: overview }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );

  server.registerResource(
    'knowledge-page',
    new ResourceTemplate('ariadne://knowledge/project/{projectId}/page/{pageId}', { list: async () => ({ resources: [] }) }),
    { title: 'Knowledge page', description: 'A specific knowledge page and citations.', mimeType: 'application/json' },
    async (uri, variables) => {
      try {
        const projectId = Array.isArray(variables.projectId) ? variables.projectId[0] : variables.projectId;
        const pageId = Array.isArray(variables.pageId) ? variables.pageId[0] : variables.pageId;
        const result = page(db, projectId, pageId);
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(envelope(result, [{ kind: 'page', id: result.id }]), null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );

  server.registerResource(
    'knowledge-queue-status',
    new ResourceTemplate('ariadne://knowledge/project/{projectId}/queue', { list: async () => ({ resources: [] }) }),
    { title: 'Knowledge queue status', description: 'Bounded queue status for a project.', mimeType: 'application/json' },
    async (uri, variables) => {
      const projectId = Array.isArray(variables.projectId) ? variables.projectId[0] : variables.projectId;
      try {
        const result = queue.list(projectId).slice(0, MAX_LIMIT);
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(envelope(result, result.map((item) => ({ kind: 'job', id: item.id }))), null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );

  server.registerResource(
    'knowledge-reviews',
    new ResourceTemplate('ariadne://knowledge/project/{projectId}/reviews', { list: async () => ({ resources: [] }) }),
    { title: 'Unresolved knowledge reviews', description: 'Pending reviews for a project.', mimeType: 'application/json' },
    async (uri, variables) => {
      const projectId = Array.isArray(variables.projectId) ? variables.projectId[0] : variables.projectId;
      try {
        const result = listKnowledgeReviews(db, projectId, { status: 'pending', limit: MAX_LIMIT });
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(envelope(result, result.map((item) => ({ kind: 'review', id: item.id }))), null, 2) }] };
      } catch (err) {
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: err instanceof Error ? err.message : String(err) }] };
      }
    },
  );
}
