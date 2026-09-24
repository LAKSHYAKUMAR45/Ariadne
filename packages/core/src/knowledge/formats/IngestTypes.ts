import type { KnowledgeProvenanceRef } from '../KnowledgeTypes.js';

export interface IngestInput {
  content: string;
  data?: Uint8Array;
  path?: string;
  sourceId?: string;
  sourceKind?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, string>;
  mediaRefs?: IngestMediaReference[];
}

export interface IngestMediaReference {
  kind: 'image' | 'audio' | 'video' | 'attachment';
  uri: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestSpan {
  label: string;
  text: string;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, string>;
}

export interface IngestHeading {
  level: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface IngestLink {
  text: string;
  target: string;
  startOffset: number;
  endOffset: number;
}

export interface ExtractedSource {
  text: string;
  normalizedText: string;
  metadata: Record<string, unknown>;
  spans: IngestSpan[];
  headings: IngestHeading[];
  links: IngestLink[];
  provenance: KnowledgeProvenanceRef[];
  mediaRefs?: IngestMediaReference[];
}

export interface KnowledgeIngestor {
  supports(input: IngestInput): boolean;
  extract(input: IngestInput): Promise<ExtractedSource>;
}

export function baseExtraction(input: IngestInput, text: string): ExtractedSource {
  return {
    text,
    normalizedText: text,
    metadata: { ...input.metadata },
    spans: [],
    headings: [],
    links: [],
    provenance: input.sourceId
      ? [{ kind: 'source', id: input.sourceId, path: input.path }]
      : input.path
        ? [{ kind: 'file', id: input.path, path: input.path }]
        : [],
    mediaRefs: input.mediaRefs?.map((reference) => ({
      ...reference,
      metadata: reference.metadata ? { ...reference.metadata } : undefined,
    })),
  };
}
