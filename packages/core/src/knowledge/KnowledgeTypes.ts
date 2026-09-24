type KnowledgeId<Brand extends string> = string & {
  readonly __knowledgeId: Brand;
};

export type KnowledgeProjectId = KnowledgeId<'project'>;
export type KnowledgeSourceId = KnowledgeId<'source'>;
export type KnowledgePageId = KnowledgeId<'page'>;
export type KnowledgeJobId = KnowledgeId<'job'>;
export type KnowledgeReviewId = KnowledgeId<'review'>;
export type KnowledgeGraphNodeId = KnowledgeId<'graph-node'>;

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
  startLine?: number;
  endLine?: number;
  confidence?: number;
}

export interface KnowledgePageRecord {
  id: KnowledgePageId;
  projectId: KnowledgeProjectId;
  type: KnowledgePageType;
  title: string;
  slug: string;
  summary: string | null;
  status: 'active' | 'archived';
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
