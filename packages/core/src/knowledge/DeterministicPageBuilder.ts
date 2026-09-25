import { createKnowledgeId } from './KnowledgeIds.js';
import type {
  DeterministicExtraction,
  ExtractedRelationship,
  ExtractedSection,
  ExtractedSymbol,
  ExtractionDiagnostic,
  KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';
import type { KnowledgeGenerationPayload } from './KnowledgeGeneratorService.js';
import type { KnowledgeProvenanceRef } from './KnowledgeTypes.js';

export interface DeterministicPageBuildInput {
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourcePath: string | null;
  extraction: DeterministicExtraction;
}

const MAX_SECTION_EXCERPT = 320;
const MAX_SUMMARY_LENGTH = 280;
const MAX_SYMBOL_DETAIL_LENGTH = 160;

function compareNullable(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

function compareSpans(left: KnowledgeSourceSpan, right: KnowledgeSourceSpan): number {
  return (
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    compareNullable(left.label, right.label)
  );
}

function sortSections(sections: ExtractedSection[]): ExtractedSection[] {
  return [...sections].sort(
    (left, right) => compareSpans(left.span, right.span) || left.id.localeCompare(right.id),
  );
}

function sortSymbols(symbols: ExtractedSymbol[]): ExtractedSymbol[] {
  return [...symbols].sort(
    (left, right) => compareSpans(left.span, right.span) || left.id.localeCompare(right.id),
  );
}

function sortRelationships(relationships: ExtractedRelationship[]): ExtractedRelationship[] {
  return [...relationships].sort((left, right) => {
    const spanOrder = left.span && right.span ? compareSpans(left.span, right.span) : left.span ? -1 : right.span ? 1 : 0;
    return spanOrder || left.id.localeCompare(right.id);
  });
}

function sortDiagnostics(diagnostics: ExtractionDiagnostic[]): ExtractionDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const spanOrder = left.span && right.span ? compareSpans(left.span, right.span) : left.span ? -1 : right.span ? 1 : 0;
    return spanOrder || left.severity.localeCompare(right.severity) || left.code.localeCompare(right.code);
  });
}

function slugify(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'source';
}

function bounded(value: string, limit: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function escapeInline(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/!/g, '\\!')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ');
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "'").replace(/\r/g, ' ').replace(/\n/g, ' ');
}

function escapeTableCell(value: string | null | undefined): string {
  const collapsed = escapeInline(value).replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : '—';
}

function codeFence(text: string): string {
  const runs = text.match(/~+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  return '~'.repeat(longest + 1);
}

function renderSourceExcerpt(text: string): string {
  const excerpt = bounded(text, MAX_SECTION_EXCERPT);
  const fence = codeFence(excerpt);
  return `${fence}text\n${excerpt.trimEnd()}\n${fence}`;
}

function citation(path: string | null, span: KnowledgeSourceSpan): string {
  const source = escapeInlineCode(path ?? 'unknown-source');
  return `${source}:${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`;
}

function findLastSpan(extraction: DeterministicExtraction): KnowledgeSourceSpan | null {
  const spans = [
    ...extraction.sections.map((section) => section.span),
    ...extraction.symbols.map((symbol) => symbol.span),
    ...extraction.relationships.flatMap((relationship) => (relationship.span ? [relationship.span] : [])),
    ...extraction.links.flatMap((link) => (link.span ? [link.span] : [])),
    ...extraction.diagnostics.flatMap((diagnostic) => (diagnostic.span ? [diagnostic.span] : [])),
  ];
  if (spans.length === 0) return null;
  return spans.reduce((latest, candidate) =>
    candidate.endLine > latest.endLine ||
    (candidate.endLine === latest.endLine && candidate.endColumn > latest.endColumn) ||
    (candidate.endLine === latest.endLine &&
      candidate.endColumn === latest.endColumn &&
      candidate.endOffset > latest.endOffset)
      ? candidate
      : latest,
  );
}

function fallbackLineRange(extraction: DeterministicExtraction): Pick<
  KnowledgeProvenanceRef,
  'startLine' | 'startColumn' | 'endLine' | 'endColumn' | 'startOffset' | 'endOffset'
> {
  const lastSpan = findLastSpan(extraction);
  if (!lastSpan) {
    return {
      startOffset: 0,
      endOffset: 0,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    };
  }
  return {
    startOffset: 0,
    endOffset: lastSpan.endOffset,
    startLine: 1,
    startColumn: 1,
    endLine: lastSpan.endLine,
    endColumn: lastSpan.endColumn,
  };
}

function renderSections(sourcePath: string | null, extraction: DeterministicExtraction): string[] {
  const sections = sortSections(extraction.sections);
  if (sections.length === 0) {
    return ['## Sections', '', 'No extracted sections.', ''];
  }
  return [
    '## Sections',
    '',
    ...sections.flatMap((section, index) => [
      `### ${index + 1}. ${escapeInline(section.title ?? section.kind)}`,
      `- Kind: \`${escapeInline(section.kind)}\``,
      `- Citation: \`${citation(sourcePath, section.span)}\``,
      '',
      renderSourceExcerpt(section.text),
      '',
    ]),
  ];
}

function renderSymbols(sourcePath: string | null, extraction: DeterministicExtraction): string[] {
  const symbols = sortSymbols(extraction.symbols);
  if (symbols.length === 0) {
    return ['## Symbols', '', 'No extracted symbols.', ''];
  }
  return [
    '## Symbols',
    '',
    '| Kind | Name | Qualified name | Detail | Citation |',
    '| --- | --- | --- | --- | --- |',
    ...symbols.map((symbol) =>
      `| ${escapeTableCell(symbol.kind)} | ${escapeTableCell(symbol.name)} | ${escapeTableCell(
        symbol.qualifiedName ?? '—',
      )} | ${escapeTableCell(
        bounded(symbol.detail ?? symbol.signature ?? '', MAX_SYMBOL_DETAIL_LENGTH) || '—',
      )} | ${escapeTableCell(citation(sourcePath, symbol.span))} |`,
    ),
    '',
  ];
}

function relationshipTarget(relationship: ExtractedRelationship): string {
  if (relationship.targetReference) return relationship.targetReference;
  if (relationship.targetSymbolId) return relationship.targetSymbolId;
  if (relationship.toId) return relationship.toId;
  return 'unresolved';
}

function renderRelationships(sourcePath: string | null, extraction: DeterministicExtraction): string[] {
  const relationships = sortRelationships(extraction.relationships);
  if (relationships.length === 0) {
    return ['## Relationships', '', 'No extracted relationships.', ''];
  }
  return [
    '## Relationships',
    '',
    ...relationships.map((relationship) => {
      const prefix = `- \`${escapeInline(relationship.type)}\` from \`${escapeInline(
        relationship.fromId ?? relationship.sourceSymbolId ?? 'source',
      )}\` to \`${escapeInline(relationshipTarget(relationship))}\``;
      const detail = relationship.detail ? ` — ${escapeInline(relationship.detail)}` : '';
      const spanCitation = relationship.span ? ` (\`${citation(sourcePath, relationship.span)}\`)` : '';
      return `${prefix}${detail}${spanCitation}`;
    }),
    '',
  ];
}

function renderDiagnostics(sourcePath: string | null, extraction: DeterministicExtraction): string[] {
  const diagnostics = sortDiagnostics(extraction.diagnostics);
  if (diagnostics.length === 0) {
    return ['## Diagnostics', '', 'No diagnostics.', ''];
  }
  return [
    '## Diagnostics',
    '',
    ...diagnostics.map((diagnostic) => {
      const spanCitation = diagnostic.span ? ` (\`${citation(sourcePath, diagnostic.span)}\`)` : '';
      return `- ${escapeInline(diagnostic.severity)} \`${escapeInline(diagnostic.code)}\`: ${escapeInline(
        diagnostic.message,
      )}${spanCitation}`;
    }),
    '',
  ];
}

export function buildDeterministicPagePayload(input: DeterministicPageBuildInput): KnowledgeGenerationPayload {
  const sourcePath = input.sourcePath ?? input.extraction.title;
  const generatorVersion = `deterministic:${input.extraction.analyzerId}:${input.extraction.analyzerVersion}`;
  const slugSeed = sourcePath ? slugify(sourcePath) : slugify(input.sourceId);
  const suffix = input.sourceVersionId.slice(-8);
  const slugPrefix = 'source-';
  const baseLimit = Math.max(1, 96 - slugPrefix.length - 1 - suffix.length);
  const slugBase = slugSeed.slice(0, baseLimit).replace(/-+$/g, '') || 'source';
  const slug = `${slugPrefix}${slugBase}-${suffix}`;
  const pageId = createKnowledgeId('page', `${input.projectId}:${input.sourceId}:${input.sourceVersionId}`);
  const provenance: KnowledgeProvenanceRef = {
    kind: 'source',
    id: input.sourceId,
    path: input.sourcePath ?? undefined,
    sourceVersionId: input.sourceVersionId,
    ...fallbackLineRange(input.extraction),
    confidence: 1,
  };
  const lines = [
    `# ${escapeInline(sourcePath ?? input.sourceId)}`,
    '',
    `- Source ID: \`${escapeInline(input.sourceId)}\``,
    `- Source version: \`${escapeInline(input.sourceVersionId)}\``,
    `- Analyzer: \`${escapeInline(input.extraction.analyzerId)}@${escapeInline(input.extraction.analyzerVersion)}\``,
    `- Generator: \`${escapeInline(generatorVersion)}\``,
    '',
    '## Summary',
    '',
    bounded(escapeInline(input.extraction.summary), MAX_SUMMARY_LENGTH),
    '',
    ...renderSections(input.sourcePath, input.extraction),
    ...renderSymbols(input.sourcePath, input.extraction),
    ...renderRelationships(input.sourcePath, input.extraction),
    ...renderDiagnostics(input.sourcePath, input.extraction),
  ];

  return {
    generatorVersion,
    pages: [
      {
        pageId,
        type: 'source',
        title: sourcePath ?? input.extraction.title,
        slug,
        content: `${lines.join('\n').trimEnd()}\n`,
        summary: bounded(input.extraction.summary, MAX_SUMMARY_LENGTH),
        sourceVersionIds: [input.sourceVersionId],
        provenance: [provenance],
        confidence: 1,
      },
    ],
  };
}
