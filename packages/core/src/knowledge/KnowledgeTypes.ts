type KnowledgeId<Brand extends string> = string & {
  readonly __knowledgeId: Brand;
};

export type KnowledgeProjectId = KnowledgeId<'project'>;
export type KnowledgeSourceId = KnowledgeId<'source'>;
export type KnowledgePageId = KnowledgeId<'page'>;
export type KnowledgeJobId = KnowledgeId<'job'>;
export type KnowledgeReviewId = KnowledgeId<'review'>;
export type KnowledgeGraphNodeId = string;

export type KnowledgePageType =
  | 'overview'
  | 'concept'
  | 'entity'
  | 'architecture'
  | 'decision'
  | 'source'
  | 'failure'
  | 'workstream'
  | 'synthesis'
  | 'comparison'
  | 'query'
  | 'gap'
  | 'review';

export type KnowledgeSourceKind =
  | 'file'
  | 'url'
  | 'task_history'
  | 'web_clip'
  | 'manual';

export type KnowledgeJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type KnowledgeReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'dismissed';

export type KnowledgeGraphEdgeType =
  | 'imports'
  | 'exports'
  | 'defines'
  | 'contains'
  | 'inherits'
  | 'implements'
  | 'calls'
  | 'references'
  | 'links_to'
  | 'related_to'
  | 'relates_to'
  | 'link'
  | 'supports';

export type KnowledgeEdgeEvidence =
  | 'explicit_link'
  | 'shared_source'
  | 'provenance_overlap'
  | 'semantic_relationship'
  | 'contradiction'
  | 'supersession';

export type KnowledgeProvenanceKind =
  | 'task'
  | 'checkpoint'
  | 'decision'
  | 'file'
  | 'commit'
  | 'source'
  | 'page';

export interface KnowledgeProvenanceRef {
  kind: KnowledgeProvenanceKind;
  id: string;
  path?: string;
  sourceVersionId?: string;
  /** Exact persisted span to reuse; validated against the source and project before it is stored. */
  sourceSpanId?: string;
  startOffset?: number;
  endOffset?: number;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  label?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgePageRecord {
  id: KnowledgePageId;
  projectId: KnowledgeProjectId;
  type: KnowledgePageType;
  title: string;
  slug: string;
  summary: string | null;
  status: 'active' | 'archived' | 'stale';
  currentVersion: number;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface KnowledgeSourceRecord {
  id: KnowledgeSourceId;
  projectId: KnowledgeProjectId;
  kind: KnowledgeSourceKind;
  canonicalPath: string;
  contentHash: string;
  format: string;
  extractionStatus: 'pending' | 'completed' | 'failed' | 'skipped';
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
