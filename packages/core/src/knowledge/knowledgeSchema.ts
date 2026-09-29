export const KNOWLEDGE_SCHEMA_VERSION = 6;
export const KNOWLEDGE_HOST_SETTING_PREFIX = 'host.';
export const KNOWLEDGE_JOB_COMPLETION_MODES = ['deterministic', 'enriched', 'unknown'] as const;

export const KNOWLEDGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_projects (
  id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_projects_workspace_root ON knowledge_projects(workspace_root);

CREATE TABLE IF NOT EXISTS knowledge_project_roots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, root_path)
);

CREATE TABLE IF NOT EXISTS knowledge_settings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, setting_key)
);

CREATE TABLE IF NOT EXISTS knowledge_provider_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  provider_kind TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  configuration_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, profile_name)
);

CREATE TABLE IF NOT EXISTS knowledge_schema_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  source_url TEXT,
  title TEXT,
  current_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_path IS NOT NULL OR source_url IS NOT NULL),
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_project_hash ON knowledge_sources(project_id, current_hash);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_project_status ON knowledge_sources(project_id, status);

CREATE TABLE IF NOT EXISTS knowledge_source_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_path TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, version_number),
  UNIQUE (source_id, content_hash),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, source_id) REFERENCES knowledge_sources(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_versions_project_hash ON knowledge_source_versions(project_id, content_hash);

CREATE TABLE IF NOT EXISTS knowledge_source_assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL,
  asset_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT,
  byte_length INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_version_id, asset_path),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_source_spans (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  label TEXT,
  created_at TEXT NOT NULL,
  CHECK (start_offset >= 0),
  CHECK (end_offset >= start_offset),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_spans_version_offsets
  ON knowledge_source_spans(source_version_id, start_offset, end_offset);

CREATE TABLE IF NOT EXISTS knowledge_extractions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL,
  extractor_kind TEXT NOT NULL,
  analyzer_id TEXT,
  analyzer_version TEXT,
  result_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  extraction_hash TEXT,
  result_json TEXT,
  diagnostics_json TEXT,
  status TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_analyzer
  ON knowledge_extractions(
    project_id,
    source_version_id,
    extractor_kind,
    analyzer_id,
    analyzer_version
  );

CREATE TABLE IF NOT EXISTS knowledge_pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  page_type TEXT NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, slug),
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_pages_project_type ON knowledge_pages(project_id, page_type);

CREATE TABLE IF NOT EXISTS knowledge_page_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_path TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (page_id, version_number),
  UNIQUE (page_id, content_hash),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, page_id) REFERENCES knowledge_pages(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_page_versions_project_hash ON knowledge_page_versions(project_id, content_hash);

CREATE TABLE IF NOT EXISTS knowledge_page_sources (
  page_version_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (page_version_id, source_version_id),
  FOREIGN KEY (project_id, page_version_id)
    REFERENCES knowledge_page_versions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_version_id)
    REFERENCES knowledge_source_versions(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_page_provenance (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  page_version_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_span_id TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (confidence >= 0 AND confidence <= 1),
  FOREIGN KEY (project_id, page_version_id)
    REFERENCES knowledge_page_versions(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_span_id)
    REFERENCES knowledge_source_spans(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_page_provenance_page ON knowledge_page_provenance(page_version_id);

CREATE TABLE IF NOT EXISTS knowledge_page_aliases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, alias),
  FOREIGN KEY (project_id, page_id) REFERENCES knowledge_pages(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_page_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL,
  target_page_id TEXT,
  target_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_page_id, target_reference),
  FOREIGN KEY (project_id, source_page_id) REFERENCES knowledge_pages(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_page_id) REFERENCES knowledge_pages(project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_page_links_project_target ON knowledge_page_links(project_id, target_page_id);

CREATE TABLE IF NOT EXISTS knowledge_graph_nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL,
  label TEXT NOT NULL,
  source_kind TEXT,
  source_id TEXT,
  qualified_name TEXT,
  source_version_id TEXT,
  start_offset INTEGER,
  end_offset INTEGER,
  start_line INTEGER,
  start_column INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  span_label TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (confidence >= 0 AND confidence <= 1),
  UNIQUE (project_id, node_type, source_kind, source_id),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_node_id <> target_node_id),
  CHECK (confidence >= 0 AND confidence <= 1),
  UNIQUE (project_id, source_node_id, target_node_id, edge_type),
  FOREIGN KEY (project_id, source_node_id)
    REFERENCES knowledge_graph_nodes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_node_id)
    REFERENCES knowledge_graph_nodes(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_graph_edges_project_source_target
  ON knowledge_graph_edges(project_id, source_node_id, target_node_id);

CREATE TRIGGER IF NOT EXISTS trg_knowledge_graph_nodes_source_version_delete
AFTER DELETE ON knowledge_source_versions
BEGIN
  DELETE FROM knowledge_graph_nodes
  WHERE project_id = OLD.project_id AND source_version_id = OLD.id;
END;


CREATE TABLE IF NOT EXISTS knowledge_graph_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  snapshot_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, snapshot_number),
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_communities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  graph_snapshot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES knowledge_graph_snapshots(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_insights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  graph_snapshot_id TEXT,
  insight_type TEXT NOT NULL,
  content_path TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (confidence >= 0 AND confidence <= 1),
  FOREIGN KEY (project_id, graph_snapshot_id)
    REFERENCES knowledge_graph_snapshots(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS knowledge_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  job_kind TEXT NOT NULL,
  source_version_id TEXT,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  result_processing_mode TEXT CHECK (result_processing_mode IN ('deterministic', 'enriched', 'unknown') OR result_processing_mode IS NULL),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  worker_id TEXT,
  lease_expires_at TEXT,
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_project_status ON knowledge_jobs(project_id, status, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_source_version
  ON knowledge_jobs(project_id, job_kind, source_version_id)
  WHERE source_version_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_job_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, job_id) REFERENCES knowledge_jobs(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_job_events_job_created ON knowledge_job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  page_version_id TEXT,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer_id TEXT,
  summary TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, page_version_id)
    REFERENCES knowledge_page_versions(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_reviews_project_status ON knowledge_reviews(project_id, status, requested_at);

CREATE TABLE IF NOT EXISTS knowledge_review_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, review_id) REFERENCES knowledge_reviews(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_research_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  failure_message TEXT,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_research_results (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  research_run_id TEXT NOT NULL,
  result_url TEXT NOT NULL,
  title TEXT,
  content_hash TEXT,
  content_path TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (research_run_id, result_url),
  FOREIGN KEY (project_id, research_run_id)
    REFERENCES knowledge_research_runs(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, conversation_id)
    REFERENCES knowledge_conversations(project_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_messages_conversation_created
  ON knowledge_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS knowledge_outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  output_kind TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, output_kind, content_hash)
);

CREATE TABLE IF NOT EXISTS knowledge_operation_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
  operation_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_knowledge_operation_log_project_created
  ON knowledge_operation_log(project_id, created_at);
`;
