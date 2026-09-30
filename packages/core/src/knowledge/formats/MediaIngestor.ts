import path from 'node:path';
import type { ExtractedSource, IngestInput } from './IngestTypes.js';
import type { OptionalIngestFailed, OptionalIngestResult, OptionalIngestUnsupported } from './DocumentIngestor.js';

export type MediaFormat = 'image' | 'audio' | 'video';

export interface MediaAdapter {
  readonly format: MediaFormat;
  supports(input: IngestInput): boolean;
  extract(input: IngestInput): Promise<ExtractedSource>;
}

export interface MediaIngestorOptions {
  adapters?: readonly MediaAdapter[];
  maxSizeBytes?: number;
}

const DEFAULT_MAX_SIZE_BYTES = 200 * 1024 * 1024;
const EXTENSION_FORMATS: Record<string, MediaFormat> = {
  aac: 'audio',
  avi: 'video',
  flac: 'audio',
  gif: 'image',
  jpeg: 'image',
  jpg: 'image',
  m4a: 'audio',
  mkv: 'video',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  png: 'image',
  svg: 'image',
  wav: 'audio',
  webm: 'video',
  webp: 'image',
};

const MIME_FORMATS: Record<string, MediaFormat> = {
  'audio/aac': 'audio',
  'audio/flac': 'audio',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'image/gif': 'image',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/svg+xml': 'image',
  'image/webp': 'image',
  'video/avi': 'video',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
};

export function mediaFormat(input: Pick<IngestInput, 'path' | 'mimeType'>): MediaFormat | null {
  const mimeType = input.mimeType?.split(';', 1)[0].trim().toLowerCase();
  const extension = path.extname(input.path ?? '').slice(1).toLowerCase();
  return (mimeType ? MIME_FORMATS[mimeType] : undefined) ?? (extension ? EXTENSION_FORMATS[extension] : undefined) ?? null;
}

export class MediaIngestor {
  private readonly adapters: readonly MediaAdapter[];
  private readonly maxSizeBytes: number;

  constructor(options: MediaIngestorOptions = {}) {
    this.adapters = options.adapters ?? [];
    this.maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  }

  supports(input: IngestInput): boolean {
    return mediaFormat(input) !== null;
  }

  async extract(input: IngestInput): Promise<OptionalIngestResult> {
    const format = mediaFormat(input);
    const metadata = { ...input.metadata };
    if (!format) return { status: 'unsupported', format: null, reason: 'unknown_format', metadata } satisfies OptionalIngestUnsupported;

    const sizeBytes = input.sizeBytes ?? input.data?.byteLength ?? Buffer.byteLength(input.content, 'utf8');
    if (sizeBytes > this.maxSizeBytes) {
      return {
        status: 'failed',
        format,
        code: 'size_limit_exceeded',
        error: `Media exceeds the ${this.maxSizeBytes}-byte limit`,
        metadata,
      } satisfies OptionalIngestFailed;
    }

    const adapter = this.adapters.find((candidate) => candidate.format === format && candidate.supports(input));
    if (!adapter) return { status: 'unsupported', format, reason: 'no_adapter', metadata };

    try {
      const result = await adapter.extract(input);
      const references = [...(input.mediaRefs ?? []), ...(result.mediaRefs ?? [])];
      const unique = references.filter(
        (reference, index) => references.findIndex((candidate) => candidate.kind === reference.kind && candidate.uri === reference.uri) === index,
      );
      return { ...result, metadata: { ...input.metadata, ...result.metadata }, mediaRefs: unique };
    } catch (error: unknown) {
      return {
        status: 'failed',
        format,
        code: 'parser_failed',
        error: error instanceof Error ? error.message : 'Media parser failed',
        metadata,
      } satisfies OptionalIngestFailed;
    }
  }
}
