import type Database from 'better-sqlite3';
import type { DeterministicExtraction, ExtractedSymbolKind } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeExtractionStore } from '../../src/knowledge/KnowledgeExtractionStore.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeSearchIndex } from '../../src/knowledge/KnowledgeSearchIndex.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';

export const FIXTURE_PROJECT_ID = 'project_1';
const NOW = '2026-09-29T00:00:00.000Z';

export interface FixtureSymbol {
  name: string;
  kind?: ExtractedSymbolKind;
  startLine: number;
  endLine: number;
}

export interface FixtureSection {
  title: string;
  text: string;
  startLine: number;
  endLine: number;
}

export interface FixtureSource {
  path: string;
  title?: string;
  summary?: string;
  symbols?: FixtureSymbol[];
  sections?: FixtureSection[];
}

export interface IndexedFixtureSource {
  sourceId: string;
  sourceVersionId: string;
  extractionId: string;
}

function lineSpan(startLine: number, endLine: number) {
  const startOffset = startLine * 100;
  return { startOffset, endOffset: endLine * 100 + 99, startLine, startColumn: 1, endLine, endColumn: 40 };
}

export function indexFixtureSource(
  db: Database.Database,
  source: FixtureSource,
  projectId = FIXTURE_PROJECT_ID,
): IndexedFixtureSource {
  const sources = new KnowledgeSourceStore(db);
  const registered = sources.register({
    projectId,
    kind: 'file',
    path: source.path,
    content: `raw contents of ${source.path} that must never be read by synthesis`,
    format: 'markdown',
  });
  const versions = sources.listVersions(projectId, registered.id);
  const sourceVersionId = versions[versions.length - 1].id;
  const extraction: DeterministicExtraction = {
    analyzerId: 'fixture',
    analyzerVersion: '1',
    sourceVersionId,
    title: source.title ?? source.path,
    summary: source.summary ?? 'Fixture source.',
    sections: (source.sections ?? []).map((section, index) => ({
      id: `section:${index}`,
      kind: 'code',
      title: section.title,
      text: section.text,
      span: { ...lineSpan(section.startLine, section.endLine), label: section.title },
      confidence: 1,
    })),
    symbols: (source.symbols ?? []).map((symbol, index) => ({
      id: `symbol:${index}`,
      kind: symbol.kind ?? 'function',
      name: symbol.name,
      qualifiedName: null,
      signature: null,
      detail: null,
      span: { ...lineSpan(symbol.startLine, symbol.endLine), label: symbol.name },
      confidence: 1,
      metadata: null,
    })),
    relationships: [],
    links: [],
    diagnostics: [],
  };
  const saved = new KnowledgeExtractionStore(db).save({ projectId, extraction });
  new KnowledgeSearchIndex(db, { now: () => NOW }).replaceForSourceVersion({
    projectId,
    sourceVersionId,
    coverage: 'extraction',
    extractionId: saved.id,
  });
  return { sourceId: registered.id, sourceVersionId, extractionId: saved.id };
}

export function seedAuthCorpus(db: Database.Database, projectId = FIXTURE_PROJECT_ID) {
  return {
    login: indexFixtureSource(
      db,
      {
        path: 'src/auth/login.ts',
        symbols: [{ name: 'authenticateUser', startLine: 3, endLine: 9 }],
        sections: [{ title: 'Login flow', text: 'authenticate user credentials against the directory', startLine: 1, endLine: 2 }],
      },
      projectId,
    ),
    session: indexFixtureSource(
      db,
      {
        path: 'src/auth/session.ts',
        symbols: [{ name: 'createSession', startLine: 5, endLine: 12 }],
        sections: [{ title: 'Session creation', text: 'authenticate user then create a session token', startLine: 1, endLine: 4 }],
      },
      projectId,
    ),
  };
}

export function seedNearTieCorpus(db: Database.Database, projectId = FIXTURE_PROJECT_ID) {
  const doc = (path: string, text: string): FixtureSource => ({
    path,
    sections: [{ title: 'Notes', text, startLine: 1, endLine: 2 }],
  });
  return {
    a: indexFixtureSource(db, doc('src/a.ts', 'invoice ledger entries'), projectId),
    b: indexFixtureSource(db, doc('src/b.ts', 'invoice billing statements'), projectId),
    c: indexFixtureSource(db, doc('src/c.ts', 'invoice billing ledger'), projectId),
    d: indexFixtureSource(db, doc('src/d.ts', 'billing statement generator'), projectId),
  };
}

export function seedPageOnly(db: Database.Database, projectId = FIXTURE_PROJECT_ID) {
  const indexed = indexFixtureSource(
    db,
    { path: 'docs/overview.md', title: 'Overview', sections: [{ title: 'Overview', text: 'unrelated prose', startLine: 1, endLine: 2 }] },
    projectId,
  );
  const page = new KnowledgePageStore(db).createPageVersion({
    projectId,
    type: 'concept',
    title: 'Zeppelin routing',
    slug: 'zeppelin-routing',
    content: 'Generated page content',
    summary: 'Explains zeppelin routing tables.',
    sourceVersionIds: [indexed.sourceVersionId],
  });
  db.prepare(
    `INSERT INTO knowledge_source_spans (id, project_id, source_version_id, start_offset, end_offset, label, created_at)
     VALUES ('span_zeppelin', ?, ?, 0, 11, 'heading', ?)`,
  ).run(projectId, indexed.sourceVersionId, NOW);
  db.prepare(
    `INSERT INTO knowledge_page_provenance
     (id, project_id, page_version_id, source_kind, source_id, source_span_id, confidence, created_at)
     VALUES ('prov_zeppelin', ?, ?, 'source', ?, 'span_zeppelin', 0.9, ?)`,
  ).run(projectId, page.id, indexed.sourceId, NOW);
  return { page, ...indexed };
}
