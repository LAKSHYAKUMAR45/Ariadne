import type { KnowledgePageType, KnowledgeProvenanceRef } from './KnowledgeTypes.js';
import type { KnowledgePage } from './KnowledgePageStore.js';

export interface KnowledgePageRenderInput {
  id: string;
  type: KnowledgePageType;
  title: string;
  slug: string;
  status?: string;
  content: string;
  sourceIds?: string[];
  provenance?: KnowledgeProvenanceRef[];
  confidence?: number | null;
  generatorVersion?: string;
  generatedAt?: string;
  version?: number;
}

export interface KnowledgeIndexEntry {
  id: string;
  type: KnowledgePageType;
  title: string;
  slug: string;
  summary: string | null;
  status: string;
  version: number;
  updatedAt: string;
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`');
}

function safeRelativeLink(type: string, slug: string): string {
  return `<pages/${type}/${slug.replace(/>/g, '%3E')}.md>`;
}

function yamlList(values: string[]): string {
  return values.length === 0 ? '[]' : `\n${values.map((value) => `  - ${yamlScalar(value)}`).join('\n')}`;
}

function requireFiniteConfidence(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Knowledge page confidence must be between 0 and 1');
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function renderKnowledgePage(page: KnowledgePageRenderInput | KnowledgePage): string {
  const confidence = requireFiniteConfidence(page.confidence);
  const sources = 'sourceIds' in page ? page.sourceIds ?? [] : [];
  const provenance = 'provenance' in page ? page.provenance ?? [] : [];
  const generatedAt =
    'generatedAt' in page
      ? page.generatedAt ?? new Date().toISOString()
      : 'updatedAt' in page
        ? page.updatedAt
        : new Date().toISOString();
  const generatorVersion = page.generatorVersion ?? 'unknown';
  const version = 'version' in page ? page.version ?? 1 : 'currentVersion' in page ? page.currentVersion : 1;
  const status = page.status ?? 'active';
  const provenanceYaml =
    provenance.length === 0
      ? '[]'
      : `\n${provenance
          .map(
            (reference) =>
              `  - kind: ${yamlScalar(reference.kind)}\n    id: ${yamlScalar(reference.id)}${
                reference.path ? `\n    path: ${yamlScalar(reference.path)}` : ''
              }${reference.sourceVersionId ? `\n    source_version_id: ${yamlScalar(reference.sourceVersionId)}` : ''}${
                optionalFiniteNumber(reference.startOffset) !== undefined
                  ? `\n    start_offset: ${optionalFiniteNumber(reference.startOffset)}`
                  : ''
              }${optionalFiniteNumber(reference.endOffset) !== undefined
                  ? `\n    end_offset: ${optionalFiniteNumber(reference.endOffset)}`
                  : ''
              }${optionalFiniteNumber(reference.startLine) !== undefined
                ? `\n    start_line: ${optionalFiniteNumber(reference.startLine)}`
                : ''}${optionalFiniteNumber(reference.startColumn) !== undefined
                ? `\n    start_column: ${optionalFiniteNumber(reference.startColumn)}`
                : ''}${optionalFiniteNumber(reference.endLine) !== undefined
                ? `\n    end_line: ${optionalFiniteNumber(reference.endLine)}`
                : ''}${optionalFiniteNumber(reference.endColumn) !== undefined
                ? `\n    end_column: ${optionalFiniteNumber(reference.endColumn)}`
                : ''}${
                reference.label ? `\n    label: ${yamlScalar(reference.label)}` : ''
              }${requireFiniteConfidence(reference.confidence) !== null
                ? `\n    confidence: ${requireFiniteConfidence(reference.confidence)}`
                : ''}`,
          )
          .join('\n')}`;

  return [
    '---',
    `id: ${yamlScalar(page.id)}`,
    `type: ${yamlScalar(page.type)}`,
    `title: ${yamlScalar(page.title)}`,
    `slug: ${yamlScalar(page.slug)}`,
    `status: ${yamlScalar(status)}`,
    `version: ${version}`,
    `sources:${yamlList(sources)}`,
    `provenance:${provenanceYaml}`,
    `confidence: ${confidence === null ? 'null' : confidence}`,
    `generated_at: ${yamlScalar(generatedAt)}`,
    `generator_version: ${yamlScalar(generatorVersion)}`,
    '---',
    '',
    (page.content ?? '').trimEnd(),
    '',
  ].join('\n');
}

export function renderKnowledgeIndex(entries: KnowledgeIndexEntry[]): string {
  const sorted = [...entries].sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id));
  return [
    '# Knowledge Index',
    '',
    ...sorted.flatMap((entry) => [
      `- [${escapeMarkdownText(entry.title)}](${safeRelativeLink(entry.type, entry.slug)}) — ${entry.type}; version ${entry.version}; updated ${entry.updatedAt}`,
      entry.summary ? `  ${escapeMarkdownText(entry.summary)}` : '',
    ]),
    '',
  ].filter((line) => line !== '').join('\n');
}

export function renderKnowledgeOverview(
  projectName: string,
  entries: KnowledgeIndexEntry[],
  summary?: string | null,
): string {
  const sorted = [...entries].sort((left, right) => left.slug.localeCompare(right.slug) || left.id.localeCompare(right.id));
  return [
    `# ${escapeMarkdownText(projectName)}`,
    '',
    summary?.trim() ? escapeMarkdownText(summary.trim()) : 'Generated knowledge overview.',
    '',
    `Pages: ${sorted.length}`,
    '',
    ...sorted.map((entry) => `- ${escapeMarkdownText(entry.title)} (${entry.type})`),
    '',
  ].join('\n');
}

export function renderKnowledgeLog(
  operation: { jobId: string; generatedAt: string; pageCount: number },
  existing = '',
): string {
  const prefix = existing.trimEnd();
  const heading = prefix.length === 0 ? '# Knowledge Log' : prefix;
  return `${heading}\n\n- generated: ${operation.generatedAt}; job: ${operation.jobId}; pages: ${operation.pageCount}\n`;
}

export class KnowledgeRenderer {
  public renderKnowledgePage(page: KnowledgePageRenderInput | KnowledgePage): string {
    return renderKnowledgePage(page);
  }
}
