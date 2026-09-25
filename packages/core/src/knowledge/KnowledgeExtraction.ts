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
  confidence: number;
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
  confidence: number;
  metadata?: ExtractedMetadata | null;
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
  fromId?: string | null;
  toId?: string | null;
  sourceSymbolId?: string | null;
  targetSymbolId?: string | null;
  targetReference?: string | null;
  span?: KnowledgeSourceSpan | null;
  detail?: string | null;
  confidence: number;
  metadata?: ExtractedMetadata | null;
}

export interface ExtractedLink {
  id: string;
  target: string;
  title?: string | null;
  span?: KnowledgeSourceSpan | null;
  confidence: number;
}

export type ExtractedMetadataValue = string | string[] | null;
export type ExtractedMetadata = Record<string, ExtractedMetadataValue>;

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

function expectSourceText(value: unknown, label: string, options?: { allowEmpty?: boolean }): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  if (options?.allowEmpty && value.length === 0) {
    return value;
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function optionalConfidence(value: unknown, label: string): number {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
  return value;
}

function optionalMetadata(value: unknown, label: string): ExtractedMetadata | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const candidate = expectObject(value, label);
  const metadata: ExtractedMetadata = {};
  for (const [key, entry] of Object.entries(candidate)) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
      continue;
    }
    if (entry === null) {
      metadata[key] = null;
      continue;
    }
    if (Array.isArray(entry) && entry.every((item) => typeof item === 'string')) {
      metadata[key] = [...entry];
      continue;
    }
    throw new Error(`${label}.${key} must be a string, null, or string array`);
  }
  return metadata;
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
  const labelValue = optionalString(candidate.label, `${label}.label`);
  return {
    startOffset,
    endOffset,
    startLine,
    startColumn,
    endLine,
    endColumn,
    ...(labelValue !== undefined ? { label: labelValue ?? undefined } : {}),
  };
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function validateSection(value: unknown, index: number): ExtractedSection {
  const candidate = expectObject(value, `sections[${index}]`);
  const title = optionalString(candidate.title, `sections[${index}].title`);
  return {
    id: expectString(candidate.id, `sections[${index}].id`),
    kind: expectString(candidate.kind, `sections[${index}].kind`),
    text: expectSourceText(candidate.text, `sections[${index}].text`),
    span: validateSpan(candidate.span, `sections[${index}].span`),
    confidence: optionalConfidence(candidate.confidence, `sections[${index}].confidence`),
    ...(title !== undefined ? { title } : {}),
  };
}

function validateSymbol(value: unknown, index: number): ExtractedSymbol {
  const candidate = expectObject(value, `symbols[${index}]`);
  const kind = expectString(candidate.kind, `symbols[${index}].kind`) as ExtractedSymbolKind;
  if (!SYMBOL_KINDS.has(kind)) {
    throw new Error(`symbols[${index}].kind must be one of ${[...SYMBOL_KINDS].join(', ')}`);
  }
  const qualifiedName = optionalString(candidate.qualifiedName, `symbols[${index}].qualifiedName`);
  const signature = optionalString(candidate.signature, `symbols[${index}].signature`);
  const detail = optionalString(candidate.detail, `symbols[${index}].detail`);
  const metadata = optionalMetadata(candidate.metadata, `symbols[${index}].metadata`);
  return {
    id: expectString(candidate.id, `symbols[${index}].id`),
    kind,
    name: expectString(candidate.name, `symbols[${index}].name`),
    span: validateSpan(candidate.span, `symbols[${index}].span`),
    confidence: optionalConfidence(candidate.confidence, `symbols[${index}].confidence`),
    ...(qualifiedName !== undefined ? { qualifiedName } : {}),
    ...(signature !== undefined ? { signature } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function validateRelationship(value: unknown, index: number): ExtractedRelationship {
  const candidate = expectObject(value, `relationships[${index}]`);
  const type = expectString(candidate.type, `relationships[${index}].type`) as ExtractedRelationshipType;
  if (!RELATIONSHIP_TYPES.has(type)) {
    throw new Error(`relationships[${index}].type must be one of ${[...RELATIONSHIP_TYPES].join(', ')}`);
  }
  const fromId = optionalString(candidate.fromId, `relationships[${index}].fromId`);
  const toId = optionalString(candidate.toId, `relationships[${index}].toId`);
  const sourceSymbolId = optionalString(candidate.sourceSymbolId, `relationships[${index}].sourceSymbolId`);
  const targetSymbolId = optionalString(candidate.targetSymbolId, `relationships[${index}].targetSymbolId`);
  const targetReference = optionalString(candidate.targetReference, `relationships[${index}].targetReference`);
  const span = optionalSpan(candidate.span, `relationships[${index}].span`);
  const detail = optionalString(candidate.detail, `relationships[${index}].detail`);
  const metadata = optionalMetadata(candidate.metadata, `relationships[${index}].metadata`);
  return {
    id: expectString(candidate.id, `relationships[${index}].id`),
    type,
    confidence: optionalConfidence(candidate.confidence, `relationships[${index}].confidence`),
    ...(fromId !== undefined ? { fromId } : {}),
    ...(toId !== undefined ? { toId } : {}),
    ...(sourceSymbolId !== undefined ? { sourceSymbolId } : {}),
    ...(targetSymbolId !== undefined ? { targetSymbolId } : {}),
    ...(targetReference !== undefined ? { targetReference } : {}),
    ...(span !== undefined ? { span } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function validateLink(value: unknown, index: number): ExtractedLink {
  const candidate = expectObject(value, `links[${index}]`);
  const title = optionalString(candidate.title, `links[${index}].title`);
  const span = optionalSpan(candidate.span, `links[${index}].span`);
  return {
    id: expectString(candidate.id, `links[${index}].id`),
    target: expectString(candidate.target, `links[${index}].target`),
    confidence: optionalConfidence(candidate.confidence, `links[${index}].confidence`),
    ...(title !== undefined ? { title } : {}),
    ...(span !== undefined ? { span } : {}),
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
  const symbolIds = new Set(symbols.map((symbol) => symbol.id));
  for (const relationship of relationships) {
    const hasLegacyEndpoints = relationship.fromId !== undefined || relationship.toId !== undefined;
    const hasSymbolEndpoints =
      relationship.sourceSymbolId !== undefined ||
      relationship.targetSymbolId !== undefined ||
      relationship.targetReference !== undefined;

    if (!hasLegacyEndpoints && !hasSymbolEndpoints) {
      throw new Error(`Relationship "${relationship.id}" must reference legacy or symbol endpoints`);
    }

    if (
      hasLegacyEndpoints &&
      (!relationship.fromId || !relationship.toId || !endpointIds.has(relationship.fromId) || !endpointIds.has(relationship.toId))
    ) {
      throw new Error(`Relationship "${relationship.id}" references an unknown endpoint`);
    }

    if (relationship.sourceSymbolId !== undefined && relationship.sourceSymbolId !== null && !symbolIds.has(relationship.sourceSymbolId)) {
      throw new Error(`Relationship "${relationship.id}" references an unknown source symbol`);
    }

    if (relationship.targetSymbolId !== undefined && relationship.targetSymbolId !== null && !symbolIds.has(relationship.targetSymbolId)) {
      throw new Error(`Relationship "${relationship.id}" references an unknown target symbol`);
    }

    if (relationship.targetSymbolId === null && !relationship.targetReference) {
      throw new Error(`Relationship "${relationship.id}" must include a targetReference when targetSymbolId is null`);
    }
  }
}

export function offsetToPosition(content: string, offset: number): KnowledgeSourcePosition {
  if (!Number.isInteger(offset) || offset < 0 || offset > content.length) {
    throw new Error('Offset must be an integer within the content length');
  }
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; ) {
    if (content[index] === '\r') {
      if (content[index + 1] === '\n' && index + 1 < offset) {
        index += 2;
      } else {
        index += 1;
      }
      line += 1;
      column = 1;
      continue;
    }
    if (content[index] === '\n') {
      index += 1;
      line += 1;
      column = 1;
      continue;
    }
    index += 1;
    column += 1;
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
    summary: expectSourceText(candidate.summary, 'summary', { allowEmpty: true }),
    sections: expectArray(candidate.sections, 'sections').map((item, index) => validateSection(item, index)),
    symbols: expectArray(candidate.symbols, 'symbols').map((item, index) => validateSymbol(item, index)),
    relationships: expectArray(candidate.relationships, 'relationships').map((item, index) => validateRelationship(item, index)),
    links: expectArray(candidate.links, 'links').map((item, index) => validateLink(item, index)),
    diagnostics: expectArray(candidate.diagnostics, 'diagnostics').map((item, index) => validateDiagnostic(item, index)),
  };
  assertSummaryMatchesExtractedContent(extraction);
  assertUniqueIds([
    { label: 'sections', items: extraction.sections },
    { label: 'symbols', items: extraction.symbols },
    { label: 'relationships', items: extraction.relationships },
    { label: 'links', items: extraction.links },
  ]);
  assertRelationshipEndpoints(extraction.relationships, extraction.sections, extraction.symbols);
  return extraction;
}

function assertSummaryMatchesExtractedContent(extraction: DeterministicExtraction): void {
  if (extraction.summary.length === 0 && extraction.sections.length > 0) {
    throw new Error('summary must be a non-empty string');
  }
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
