import { createHash } from 'node:crypto';

export interface SourceVersion {
  hash: string;
  size: number;
}

export type SourceContent = string | Uint8Array;

/** Computes the stable SHA-256 identity and UTF-8 byte size of source content. */
export function computeSourceVersion(content: SourceContent): SourceVersion {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  return {
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

/** Produces the seed used for deterministic source ids. */
export function sourceIdentitySeed(projectId: string, kind: string, canonicalPath: string): string {
  return `${projectId}\0${kind}\0${canonicalPath}`;
}
