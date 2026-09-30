import type Database from 'better-sqlite3';
import { deriveCitationContext, type KnowledgeCitationFieldKind } from './KnowledgeCitationContext.js';
import { knowledgeSourceSpanId, KnowledgeExtractionStore } from './KnowledgeExtractionStore.js';
import { createKnowledgeId } from './KnowledgeIds.js';
import type { KnowledgeSearchCitation } from './KnowledgeSearch.js';
import type { KnowledgeSemanticSummaryEvidence, KnowledgeSummaryScopeKind } from './KnowledgeSemanticSummaryTypes.js';
import { clip, type TextRedactor } from './KnowledgeSynthesisEvidence.js';

export const MAX_SUMMARY_SYMBOLS = 4;
export const MAX_SUMMARY_SECTIONS = 3;
export const MAX_SUMMARY_PAGES = 5;
export const MAX_SUMMARY_PROVENANCE = 4;
const MAX_EVIDENCE_TEXT = 200;
const MAX_EVIDENCE_TITLE = 120;
const MAX_BULLET = 240;
const MAX_SUMMARY = 500;
const MAX_TITLE = 120;

export interface SummaryDraft {
  title: string;
  summary: string;
  bullets: string[];
  bulletEvidenceIds: string[][];
  evidence: KnowledgeSemanticSummaryEvidence[];
}

export class KnowledgeSummaryScopeNotFoundError extends Error {
  public constructor(scopeKind: KnowledgeSummaryScopeKind) {
    super(`Knowledge summary scope not found: ${scopeKind}`);
    this.name = 'KnowledgeSummaryScopeNotFoundError';
  }
}

interface DraftBuilder {
  evidence: KnowledgeSemanticSummaryEvidence[];
  bullets: string[];
  bulletEvidenceIds: string[][];
  addEvidence(key: string, title: string, text: string, citation: KnowledgeSearchCitation | null): string;
  addBullet(text: string, evidenceIds: string[]): void;
}

function createBuilder(scopeKind: KnowledgeSummaryScopeKind, scopeId: string, redactText: TextRedactor): DraftBuilder {
  const evidence: KnowledgeSemanticSummaryEvidence[] = [];
  const bullets: string[] = [];
  const bulletEvidenceIds: string[][] = [];
  return {
    evidence,
    bullets,
    bulletEvidenceIds,
    addEvidence(key, title, text, citation) {
      const id = createKnowledgeId('summary-evidence', `${scopeKind}|${scopeId}|${key}`);
      evidence.push({ id, title: clip(redactText(title), MAX_EVIDENCE_TITLE), citation, text: clip(redactText(text), MAX_EVIDENCE_TEXT) });
      return id;
    },
    addBullet(text, evidenceIds) {
      bullets.push(clip(redactText(text), MAX_BULLET));
      bulletEvidenceIds.push(evidenceIds);
    },
  };
}

function finish(builder: DraftBuilder, title: string, summary: string, redactText: TextRedactor): SummaryDraft {
  return {
    title: clip(redactText(title), MAX_TITLE),
    summary: clip(redactText(summary), MAX_SUMMARY),
    bullets: builder.bullets,
    bulletEvidenceIds: builder.bulletEvidenceIds,
    evidence: builder.evidence,
  };
}

interface SourceVersionRow {
  source_id: string;
  source_path: string | null;
  source_url: string | null;
}

interface ExtractionIdentityRow {
  analyzer_id: string;
  analyzer_version: string;
}

export function buildSourceVersionDraft(
  db: Database.Database,
  projectId: string,
  sourceVersionId: string,
  redactText: TextRedactor,
): SummaryDraft {
  const row = db
    .prepare(
      `SELECT v.source_id AS source_id, s.source_path AS source_path, s.source_url AS source_url
       FROM knowledge_source_versions v
       JOIN knowledge_sources s ON s.project_id = v.project_id AND s.id = v.source_id
       WHERE v.project_id = ? AND v.id = ?`,
    )
    .get(projectId, sourceVersionId) as SourceVersionRow | undefined;
  if (row === undefined) throw new KnowledgeSummaryScopeNotFoundError('source_version');
  const location = row.source_path ?? row.source_url ?? row.source_id;
  const builder = createBuilder('source_version', sourceVersionId, redactText);
  const sourceCitation = (span: KnowledgeSearchCitation['span'], hint?: KnowledgeCitationFieldKind): KnowledgeSearchCitation => {
    const citation = { pageId: null, sourceId: row.source_id, path: row.source_path, url: row.source_url, span } as KnowledgeSearchCitation;
    return { ...citation, context: deriveCitationContext(db, projectId, citation, hint) };
  };

  const identity = db
    .prepare(
      `SELECT analyzer_id, analyzer_version FROM knowledge_extractions
       WHERE project_id = ? AND source_version_id = ? AND analyzer_id IS NOT NULL AND analyzer_version IS NOT NULL
         AND extraction_hash IS NOT NULL AND result_json IS NOT NULL AND completed_at IS NOT NULL
       ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1`,
    )
    .get(projectId, sourceVersionId) as ExtractionIdentityRow | undefined;
  const record =
    identity === undefined
      ? null
      : new KnowledgeExtractionStore(db).getCurrent(projectId, sourceVersionId, identity.analyzer_id, identity.analyzer_version);
  const symbols = record?.extraction.symbols ?? [];
  const sections = record?.sections ?? [];

  const baseText = record?.extraction.summary ?? `No extraction is available for ${location}.`;
  const baseId = builder.addEvidence('source', location, baseText, sourceCitation(null));
  builder.addBullet(
    record === null
      ? `No extraction is available for ${location} yet.`
      : `${location} declares ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} and ${sections.length} section${sections.length === 1 ? '' : 's'}.`,
    [baseId],
  );

  for (const [index, symbol] of symbols.slice(0, MAX_SUMMARY_SYMBOLS).entries()) {
    const span = { ...symbol.span, id: knowledgeSourceSpanId(sourceVersionId, symbol.span), label: symbol.span.label ?? null };
    const id = builder.addEvidence(`symbol:${index}`, symbol.name, `${symbol.kind} ${symbol.name} ${symbol.signature ?? ''}`, sourceCitation(span, 'symbol'));
    builder.addBullet(`Defines ${symbol.kind} "${symbol.name}".`, [id]);
  }
  for (const [index, section] of sections.slice(0, MAX_SUMMARY_SECTIONS).entries()) {
    const label = section.title ?? section.kind;
    const id = builder.addEvidence(`section:${index}`, label, `${label} ${section.text}`, sourceCitation({ ...section.span, label: section.span.label ?? null }, 'section'));
    builder.addBullet(`Covers section "${label}".`, [id]);
  }

  return finish(builder, `Source summary: ${location}`, baseText, redactText);
}

interface PageVersionRow {
  page_id: string;
  title: string;
  page_type: string;
  version_number: number;
  summary: string | null;
}

interface ProvenanceRow {
  source_id: string;
  source_span_id: string | null;
  source_path: string | null;
  source_url: string | null;
  start_offset: number | null;
  end_offset: number | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  label: string | null;
}

function optional(name: string, value: number | null): Record<string, number> {
  return value === null ? {} : { [name]: value };
}

export function buildPageVersionDraft(
  db: Database.Database,
  projectId: string,
  pageVersionId: string,
  redactText: TextRedactor,
): SummaryDraft {
  const page = db
    .prepare(
      `SELECT pv.page_id AS page_id, p.title AS title, p.page_type AS page_type, pv.version_number AS version_number, pv.summary AS summary
       FROM knowledge_page_versions pv
       JOIN knowledge_pages p ON p.project_id = pv.project_id AND p.id = pv.page_id
       WHERE pv.project_id = ? AND pv.id = ?`,
    )
    .get(projectId, pageVersionId) as PageVersionRow | undefined;
  if (page === undefined) throw new KnowledgeSummaryScopeNotFoundError('page_version');
  const builder = createBuilder('page_version', pageVersionId, redactText);
  const pageCitation = (extra: Partial<KnowledgeSearchCitation>): KnowledgeSearchCitation => {
    const citation = { pageId: page.page_id, sourceId: null, path: null, url: null, span: null, ...extra } as KnowledgeSearchCitation;
    return { ...citation, context: deriveCitationContext(db, projectId, citation) };
  };

  const summary = page.summary?.trim() ? page.summary : `${page.page_type} page "${page.title}".`;
  const baseId = builder.addEvidence('page', page.title, summary, pageCitation({}));
  builder.addBullet(`Version ${page.version_number} of the ${page.page_type} page "${page.title}".`, [baseId]);

  const linked = db
    .prepare('SELECT COUNT(*) AS n FROM knowledge_page_sources WHERE project_id = ? AND page_version_id = ?')
    .get(projectId, pageVersionId) as { n: number };
  builder.addBullet(`Derived from ${linked.n} linked source version${linked.n === 1 ? '' : 's'}.`, [baseId]);

  const provenance = db
    .prepare(
      `SELECT prov.source_id AS source_id, prov.source_span_id AS source_span_id, s.source_path AS source_path, s.source_url AS source_url,
              span.start_offset AS start_offset, span.end_offset AS end_offset, span.start_line AS start_line,
              span.start_column AS start_column, span.end_line AS end_line, span.end_column AS end_column, span.label AS label
       FROM knowledge_page_provenance prov
       LEFT JOIN knowledge_sources s ON s.project_id = prov.project_id AND s.id = prov.source_id
       LEFT JOIN knowledge_source_spans span ON span.project_id = prov.project_id AND span.id = prov.source_span_id
       WHERE prov.project_id = ? AND prov.page_version_id = ?
       ORDER BY prov.confidence DESC, prov.id ASC LIMIT ?`,
    )
    .all(projectId, pageVersionId, MAX_SUMMARY_PROVENANCE) as ProvenanceRow[];
  for (const [index, row] of provenance.entries()) {
    const span =
      row.source_span_id === null || row.start_offset === null || row.end_offset === null
        ? null
        : {
            id: row.source_span_id,
            startOffset: row.start_offset,
            endOffset: row.end_offset,
            ...optional('startLine', row.start_line),
            ...optional('startColumn', row.start_column),
            ...optional('endLine', row.end_line),
            ...optional('endColumn', row.end_column),
            label: row.label,
          };
    const where = row.source_path ?? row.source_url ?? row.source_id;
    const id = builder.addEvidence(
      `provenance:${index}`,
      where,
      `Provenance from ${where}${row.label === null ? '' : ` (${row.label})`}`,
      pageCitation({ sourceId: row.source_id as KnowledgeSearchCitation['sourceId'], path: row.source_path, url: row.source_url, span }),
    );
    builder.addBullet(`Cites ${where}${row.label === null ? '' : ` at "${row.label}"`}.`, [id]);
  }
  return finish(builder, `Page summary: ${page.title}`, summary, redactText);
}

interface ProjectPageRow {
  page_id: string;
  title: string;
  page_type: string;
  summary: string | null;
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

export function buildProjectDraft(db: Database.Database, projectId: string, redactText: TextRedactor): SummaryDraft {
  const project = db.prepare('SELECT name FROM knowledge_projects WHERE id = ?').get(projectId) as { name: string } | undefined;
  if (project === undefined) throw new KnowledgeSummaryScopeNotFoundError('project');
  const builder = createBuilder('project', projectId, redactText);

  const pageCount = count(db, "SELECT COUNT(*) AS n FROM knowledge_pages WHERE project_id = ? AND status = 'active'", projectId);
  const nodes = count(db, 'SELECT COUNT(*) AS n FROM knowledge_graph_nodes WHERE project_id = ?', projectId);
  const edges = count(db, 'SELECT COUNT(*) AS n FROM knowledge_graph_edges WHERE project_id = ?', projectId);
  const pendingReviews = count(db, "SELECT COUNT(*) AS n FROM knowledge_reviews WHERE project_id = ? AND status = 'pending'", projectId);
  const partial = count(db, "SELECT COUNT(*) AS n FROM knowledge_analysis_coverage WHERE project_id = ? AND status = 'partial'", projectId);
  const unsupported = count(db, "SELECT COUNT(*) AS n FROM knowledge_analysis_coverage WHERE project_id = ? AND status IN ('unsupported', 'failed')", projectId);

  const pages = db
    .prepare(
      `SELECT p.id AS page_id, p.title AS title, p.page_type AS page_type, pv.summary AS summary
       FROM knowledge_pages p
       JOIN knowledge_page_versions pv ON pv.project_id = p.project_id AND pv.page_id = p.id
        AND pv.version_number = (SELECT MAX(version_number) FROM knowledge_page_versions WHERE project_id = p.project_id AND page_id = p.id)
       WHERE p.project_id = ? AND p.status = 'active'
       ORDER BY p.updated_at DESC, p.id ASC LIMIT ?`,
    )
    .all(projectId, MAX_SUMMARY_PAGES) as ProjectPageRow[];

  const metrics = `${pageCount} active pages, ${nodes} graph nodes, ${edges} graph edges, ${pendingReviews} pending reviews, ${partial} partial and ${unsupported} unsupported analyzer coverage records`;
  const metricsId = builder.addEvidence('metrics', 'Project metrics', metrics, null);
  for (const page of pages) {
    const citation = { pageId: page.page_id, sourceId: null, path: null, url: null, span: null } as KnowledgeSearchCitation;
    const id = builder.addEvidence(`page:${page.page_id}`, page.title, page.summary ?? page.title, {
      ...citation,
      context: deriveCitationContext(db, projectId, citation),
    });
    builder.addBullet(`Page "${page.title}": ${page.summary?.trim() ? page.summary : `${page.page_type} page`}`, [id]);
  }
  builder.addBullet(`Knowledge graph: ${nodes} node${nodes === 1 ? '' : 's'} and ${edges} edge${edges === 1 ? '' : 's'}.`, [metricsId]);
  builder.addBullet(`${pendingReviews} pending review${pendingReviews === 1 ? '' : 's'}; ${partial} partial and ${unsupported} unsupported analyzer coverage record${partial + unsupported === 1 ? '' : 's'}.`, [metricsId]);

  const summary = `Project "${project.name}" has ${pageCount} active page${pageCount === 1 ? '' : 's'}, ${nodes} graph node${nodes === 1 ? '' : 's'} and ${edges} edge${edges === 1 ? '' : 's'}.`;
  return finish(builder, `Project summary: ${project.name}`, summary, redactText);
}
