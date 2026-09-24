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
              }${reference.startLine !== undefined ? `\n    start_line: ${reference.startLine}` : ''}${
                reference.endLine !== undefined ? `\n    end_line: ${reference.endLine}` : ''
              }${reference.confidence !== undefined ? `\n    confidence: ${reference.confidence}` : ''}`,
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
      `- [${entry.title}](pages/${entry.type}/${entry.slug}.md) — ${entry.type}; version ${entry.version}; updated ${entry.updatedAt}`,
      entry.summary ? `  ${entry.summary}` : '',
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
    `# ${projectName}`,
    '',
    summary?.trim() || 'Generated knowledge overview.',
    '',
    `Pages: ${sorted.length}`,
    '',
    ...sorted.map((entry) => `- ${entry.title} (${entry.type})`),
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
