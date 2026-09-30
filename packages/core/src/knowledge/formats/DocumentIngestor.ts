import path from 'node:path';
import type { ExtractedSource, IngestInput } from './IngestTypes.js';

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'ods' | 'epub' | 'mobi';

export interface DocumentAdapter {
  readonly format: DocumentFormat;
  supports(input: IngestInput): boolean;
  extract(input: IngestInput): Promise<ExtractedSource>;
}

export interface OptionalIngestUnsupported {
  status: 'unsupported';
  format: string | null;
  reason: 'no_adapter' | 'unknown_format';
  metadata: Record<string, string>;
}

export interface OptionalIngestFailed {
  status: 'failed';
  format: string | null;
  code: 'parser_failed' | 'size_limit_exceeded';
  error: string;
  metadata: Record<string, string>;
}

export type OptionalIngestResult = ExtractedSource | OptionalIngestUnsupported | OptionalIngestFailed;

export interface DocumentIngestorOptions {
  adapters?: readonly DocumentAdapter[];
  maxSizeBytes?: number;
}

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  docx: 'docx',
  epub: 'epub',
  mobi: 'mobi',
  ods: 'ods',
  pdf: 'pdf',
  pptx: 'pptx',
  xlsx: 'xlsx',
};

const MIME_BY_FORMAT: Record<string, DocumentFormat> = {
  'application/epub+zip': 'epub',
  'application/pdf': 'pdf',
  'application/vnd.amazon.ebook': 'mobi',
  'application/vnd.ms-excel': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
};

export function documentFormat(input: Pick<IngestInput, 'path' | 'mimeType'>): DocumentFormat | null {
  const mimeType = input.mimeType?.split(';', 1)[0].trim().toLowerCase();
  const extension = path.extname(input.path ?? '').slice(1).toLowerCase();
  return (mimeType ? MIME_BY_FORMAT[mimeType] : undefined) ?? (extension ? FORMAT_BY_EXTENSION[extension] : undefined) ?? null;
}

export class DocumentIngestor {
  private readonly adapters: readonly DocumentAdapter[];
  private readonly maxSizeBytes: number;

  constructor(options: DocumentIngestorOptions = {}) {
    this.adapters = options.adapters ?? [];
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  }

  supports(input: IngestInput): boolean {
    return documentFormat(input) !== null;
  }

  async extract(input: IngestInput): Promise<OptionalIngestResult> {
    const format = documentFormat(input);
    const metadata = { ...input.metadata };
    if (!format) return { status: 'unsupported', format: null, reason: 'unknown_format', metadata };

    const sizeBytes = input.sizeBytes ?? input.data?.byteLength ?? Buffer.byteLength(input.content, 'utf8');
    if (sizeBytes > this.maxSizeBytes) {
      return {
        status: 'failed',
        format,
        code: 'size_limit_exceeded',
        error: `Document exceeds the ${this.maxSizeBytes}-byte limit`,
        metadata,
      };
    }

    const adapter = this.adapters.find((candidate) => candidate.format === format && candidate.supports(input));
    if (!adapter) return { status: 'unsupported', format, reason: 'no_adapter', metadata };

    try {
      return mergeMediaReferences(input, await adapter.extract(input));
    } catch (error: unknown) {
      return {
        status: 'failed',
        format,
        code: 'parser_failed',
        error: error instanceof Error ? error.message : 'Document parser failed',
        metadata,
      };
    }
  }
}

function mergeMediaReferences(input: IngestInput, result: ExtractedSource): ExtractedSource {
  const references = [...(input.mediaRefs ?? []), ...(result.mediaRefs ?? [])];
  const unique = references.filter(
    (reference, index) => references.findIndex((candidate) => candidate.kind === reference.kind && candidate.uri === reference.uri) === index,
  );
  return { ...result, metadata: { ...input.metadata, ...result.metadata }, mediaRefs: unique };
}
