import { createHash } from 'node:crypto';

export interface KnowledgeSourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface KnowledgeSourceSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  label?: string | null;
}

export interface ExtractedSection {
  id: string;
  kind: string;
  title?: string | null;
  text: string;
  span: KnowledgeSourceSpan;
}

export type ExtractedSymbolKind =
  | 'module'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'constant';

export interface ExtractedSymbol {
  id: string;
  kind: ExtractedSymbolKind;
  name: string;
  qualifiedName?: string | null;
  signature?: string | null;
  detail?: string | null;
  span: KnowledgeSourceSpan;
}

export type ExtractedRelationshipType =
  | 'imports'
  | 'exports'
  | 'defines'
  | 'contains'
  | 'inherits'
  | 'implements'
  | 'calls'
  | 'references'
  | 'links_to';

export interface ExtractedRelationship {
  id: string;
  type: ExtractedRelationshipType;
  fromId: string;
  toId: string;
  span?: KnowledgeSourceSpan | null;
  detail?: string | null;
}

export interface ExtractedLink {
  id: string;
  target: string;
  title?: string | null;
  span?: KnowledgeSourceSpan | null;
}

export type ExtractionDiagnosticSeverity = 'info' | 'warning' | 'error';

export interface ExtractionDiagnostic {
  code: string;
  message: string;
  severity: ExtractionDiagnosticSeverity;
  span?: KnowledgeSourceSpan | null;
}

export interface DeterministicExtraction {
  analyzerId: string;
  analyzerVersion: string;
  sourceVersionId: string;
  title: string;
  summary: string;
  sections: ExtractedSection[];
  symbols: ExtractedSymbol[];
  relationships: ExtractedRelationship[];
  links: ExtractedLink[];
  diagnostics: ExtractionDiagnostic[];
}

const SYMBOL_KINDS = new Set<ExtractedSymbolKind>([
  'module',
  'class',
  'interface',
  'type',
  'enum',
  'function',
  'method',
  'property',
  'constant',
]);

const RELATIONSHIP_TYPES = new Set<ExtractedRelationshipType>([
  'imports',
  'exports',
  'defines',
  'contains',
  'inherits',
  'implements',
  'calls',
  'references',
  'links_to',
]);

const DIAGNOSTIC_SEVERITIES = new Set<ExtractionDiagnosticSeverity>(['info', 'warning', 'error']);

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function expectInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  return value;
}

function optionalSpan(value: unknown, label: string): KnowledgeSourceSpan | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return validateSpan(value, label);
}

function validateSpan(value: unknown, label: string): KnowledgeSourceSpan {
  const candidate = expectObject(value, label);
  const startOffset = expectInteger(candidate.startOffset, `${label}.startOffset`);
  const endOffset = expectInteger(candidate.endOffset, `${label}.endOffset`);
  const startLine = expectInteger(candidate.startLine, `${label}.startLine`);
  const startColumn = expectInteger(candidate.startColumn, `${label}.startColumn`);
  const endLine = expectInteger(candidate.endLine, `${label}.endLine`);
  const endColumn = expectInteger(candidate.endColumn, `${label}.endColumn`);
  if (startOffset < 0 || endOffset < startOffset) {
    throw new Error(`${label} has invalid offsets`);
  }
  if (startLine <= 0 || endLine <= 0 || startColumn <= 0 || endColumn <= 0) {
    throw new Error(`${label} has invalid line or column positions`);
  }
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
    throw new Error(`${label} has invalid line or column positions`);
  }
  return {
    startOffset,
    endOffset,
    startLine,
    startColumn,
    endLine,
    endColumn,
    label: optionalString(candidate.label, `${label}.label`) ?? undefined,
  };
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function validateSection(value: unknown, index: number): ExtractedSection {
  const candidate = expectObject(value, `sections[${index}]`);
  return {
    id: expectString(candidate.id, `sections[${index}].id`),
    kind: expectString(candidate.kind, `sections[${index}].kind`),
    title: optionalString(candidate.title, `sections[${index}].title`) ?? undefined,
    text: expectString(candidate.text, `sections[${index}].text`),
    span: validateSpan(candidate.span, `sections[${index}].span`),
  };
}

function validateSymbol(value: unknown, index: number): ExtractedSymbol {
  const candidate = expectObject(value, `symbols[${index}]`);
  const kind = expectString(candidate.kind, `symbols[${index}].kind`) as ExtractedSymbolKind;
  if (!SYMBOL_KINDS.has(kind)) {
    throw new Error(`symbols[${index}].kind must be one of ${[...SYMBOL_KINDS].join(', ')}`);
  }
  return {
    id: expectString(candidate.id, `symbols[${index}].id`),
    kind,
    name: expectString(candidate.name, `symbols[${index}].name`),
    qualifiedName: optionalString(candidate.qualifiedName, `symbols[${index}].qualifiedName`) ?? undefined,
    signature: optionalString(candidate.signature, `symbols[${index}].signature`) ?? undefined,
    detail: optionalString(candidate.detail, `symbols[${index}].detail`) ?? undefined,
    span: validateSpan(candidate.span, `symbols[${index}].span`),
  };
}

function validateRelationship(value: unknown, index: number): ExtractedRelationship {
  const candidate = expectObject(value, `relationships[${index}]`);
  const type = expectString(candidate.type, `relationships[${index}].type`) as ExtractedRelationshipType;
  if (!RELATIONSHIP_TYPES.has(type)) {
    throw new Error(`relationships[${index}].type must be one of ${[...RELATIONSHIP_TYPES].join(', ')}`);
  }
  return {
    id: expectString(candidate.id, `relationships[${index}].id`),
    type,
    fromId: expectString(candidate.fromId, `relationships[${index}].fromId`),
    toId: expectString(candidate.toId, `relationships[${index}].toId`),
    span: optionalSpan(candidate.span, `relationships[${index}].span`) ?? undefined,
    detail: optionalString(candidate.detail, `relationships[${index}].detail`) ?? undefined,
  };
}

function validateLink(value: unknown, index: number): ExtractedLink {
  const candidate = expectObject(value, `links[${index}]`);
  return {
    id: expectString(candidate.id, `links[${index}].id`),
    target: expectString(candidate.target, `links[${index}].target`),
    title: optionalString(candidate.title, `links[${index}].title`) ?? undefined,
    span: optionalSpan(candidate.span, `links[${index}].span`) ?? undefined,
  };
}

function validateDiagnostic(value: unknown, index: number): ExtractionDiagnostic {
  const candidate = expectObject(value, `diagnostics[${index}]`);
  const severity = expectString(candidate.severity, `diagnostics[${index}].severity`) as ExtractionDiagnosticSeverity;
  if (!DIAGNOSTIC_SEVERITIES.has(severity)) {
    throw new Error(`diagnostics[${index}].severity must be one of ${[...DIAGNOSTIC_SEVERITIES].join(', ')}`);
  }
  return {
    code: expectString(candidate.code, `diagnostics[${index}].code`),
    message: expectString(candidate.message, `diagnostics[${index}].message`),
    severity,
    span: optionalSpan(candidate.span, `diagnostics[${index}].span`) ?? undefined,
  };
}

function assertUniqueIds(groups: Array<{ label: string; items: Array<{ id: string }> }>): void {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      const previous = seen.get(item.id);
      if (previous) {
        throw new Error(`Found duplicate extracted ID "${item.id}" in ${previous} and ${group.label}`);
      }
      seen.set(item.id, group.label);
    }
  }
}

function assertRelationshipEndpoints(
  relationships: ExtractedRelationship[],
  sections: ExtractedSection[],
  symbols: ExtractedSymbol[],
): void {
  const endpointIds = new Set([...sections, ...symbols].map((item) => item.id));
  for (const relationship of relationships) {
    if (!endpointIds.has(relationship.fromId) || !endpointIds.has(relationship.toId)) {
      throw new Error(`Relationship "${relationship.id}" references an unknown endpoint`);
    }
  }
}

export function offsetToPosition(content: string, offset: number): KnowledgeSourcePosition {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
    throw new Error('Offset must be an integer within the content length');
  }
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { offset, line, column };
}

export function validateDeterministicExtraction(value: unknown): DeterministicExtraction {
  const candidate = expectObject(value, 'deterministic extraction');
  const extraction: DeterministicExtraction = {
    analyzerId: expectString(candidate.analyzerId, 'analyzerId'),
    analyzerVersion: expectString(candidate.analyzerVersion, 'analyzerVersion'),
    sourceVersionId: expectString(candidate.sourceVersionId, 'source version ID'),
    title: expectString(candidate.title, 'title'),
    summary: expectString(candidate.summary, 'summary'),
    sections: expectArray(candidate.sections, 'sections').map((item, index) => validateSection(item, index)),
    symbols: expectArray(candidate.symbols, 'symbols').map((item, index) => validateSymbol(item, index)),
    relationships: expectArray(candidate.relationships, 'relationships').map((item, index) => validateRelationship(item, index)),
    links: expectArray(candidate.links, 'links').map((item, index) => validateLink(item, index)),
    diagnostics: expectArray(candidate.diagnostics, 'diagnostics').map((item, index) => validateDiagnostic(item, index)),
  };
  assertUniqueIds([
    { label: 'sections', items: extraction.sections },
    { label: 'symbols', items: extraction.symbols },
    { label: 'relationships', items: extraction.relationships },
    { label: 'links', items: extraction.links },
  ]);
  assertRelationshipEndpoints(extraction.relationships, extraction.sections, extraction.symbols);
  return extraction;
}

function compareNullableStrings(left: string | null | undefined, right: string | null | undefined): number {
  return (left ?? '').localeCompare(right ?? '');
}

function compareSpans(left: KnowledgeSourceSpan | null | undefined, right: KnowledgeSourceSpan | null | undefined): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return (
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    left.startLine - right.startLine ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn ||
    compareNullableStrings(left.label, right.label)
  );
}

export function canonicalizeDeterministicExtraction(extraction: DeterministicExtraction): DeterministicExtraction {
  return {
    ...extraction,
    sections: [...extraction.sections].sort((left, right) => left.id.localeCompare(right.id)),
    symbols: [...extraction.symbols].sort((left, right) => left.id.localeCompare(right.id)),
    relationships: [...extraction.relationships].sort((left, right) => left.id.localeCompare(right.id)),
    links: [...extraction.links].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: [...extraction.diagnostics].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message) ||
        left.severity.localeCompare(right.severity) ||
        compareSpans(left.span, right.span),
    ),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeys(entry));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) {
          result[key] = sortKeys(entry);
        }
        return result;
      }, {});
  }
  return value;
}

export function stableExtractionStringify(extraction: DeterministicExtraction): string {
  return JSON.stringify(sortKeys(canonicalizeDeterministicExtraction(extraction)));
}

export function hashDeterministicExtraction(extraction: DeterministicExtraction): string {
  return createHash('sha256').update(stableExtractionStringify(extraction)).digest('hex');
}
