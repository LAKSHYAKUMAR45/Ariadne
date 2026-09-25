import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { KnowledgeSourceKind } from './KnowledgeTypes.js';
import { assertNoSymlinkComponents, isPathWithinRoot } from './KnowledgePathSecurity.js';
import { normalizeKnowledgePath } from './KnowledgeIds.js';

export interface LoadedKnowledgeSourceVersion {
  projectId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceKind: KnowledgeSourceKind;
  sourcePath: string | null;
  contentPath: string;
  contentHash: string;
  mimeType: string | null;
  byteLength: number;
  content: string;
}

export class KnowledgeSourceVersionLoadError extends Error {
  public readonly code:
    | 'source_version_missing'
    | 'source_content_missing'
    | 'source_hash_mismatch'
    | 'source_path_rejected'
    | 'source_too_large'
    | 'unsupported_source';

  public constructor(
    code: KnowledgeSourceVersionLoadError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KnowledgeSourceVersionLoadError';
    this.code = code;
  }
}

interface SourceVersionRow {
  project_id: string;
  source_id: string;
  source_kind: KnowledgeSourceKind;
  source_path: string | null;
  content_path: string;
  content_hash: string;
  mime_type: string | null;
  byte_length: number;
  workspace_root: string;
}

function knowledgeRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ariadne', 'knowledge');
}

function knowledgeSourceStorageRoot(workspaceRoot: string): string {
  return path.join(knowledgeRoot(workspaceRoot), 'sources');
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8(content: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (decoded.includes('\u0000')) {
      throw new Error('Knowledge source content must not contain NUL bytes');
    }
    return decoded;
  } catch (error: unknown) {
    throw new KnowledgeSourceVersionLoadError(
      'unsupported_source',
      'Knowledge source content must be valid UTF-8 text',
      { cause: error },
    );
  }
}

function resolveStoredContentPath(workspaceRoot: string, contentPath: string): string {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeKnowledgePath(contentPath);
  } catch (error: unknown) {
    throw new KnowledgeSourceVersionLoadError('source_path_rejected', 'Knowledge source content path is invalid', {
      cause: error,
    });
  }

  const outputRoot = knowledgeRoot(workspaceRoot);
  const sourceStorageRoot = knowledgeSourceStorageRoot(workspaceRoot);
  const candidate = path.resolve(outputRoot, normalizedPath);
  if (!isPathWithinRoot(sourceStorageRoot, candidate)) {
    throw new KnowledgeSourceVersionLoadError(
      'source_path_rejected',
      'Knowledge source content path must stay within .ariadne/knowledge/sources',
    );
  }

  try {
    assertNoSymlinkComponents(sourceStorageRoot, candidate, 'Knowledge source content path');
  } catch (error: unknown) {
    throw new KnowledgeSourceVersionLoadError(
      'source_path_rejected',
      'Knowledge source content path must not traverse symbolic links',
      { cause: error },
    );
  }

  if (!existsSync(candidate)) {
    throw new KnowledgeSourceVersionLoadError('source_content_missing', 'Knowledge source content file is missing');
  }

  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(candidate);
  } catch (error: unknown) {
    throw new KnowledgeSourceVersionLoadError('source_content_missing', 'Knowledge source content file is missing', {
      cause: error,
    });
  }

  if (!stats.isFile()) {
    throw new KnowledgeSourceVersionLoadError(
      'source_path_rejected',
      'Knowledge source content path must resolve to a regular file',
    );
  }

  try {
    const canonicalStorageRoot = realpathSync(sourceStorageRoot);
    const canonicalCandidate = realpathSync(candidate);
    if (!isPathWithinRoot(canonicalStorageRoot, canonicalCandidate)) {
      throw new KnowledgeSourceVersionLoadError(
        'source_path_rejected',
        'Knowledge source content path must stay within .ariadne/knowledge/sources',
      );
    }
    return canonicalCandidate;
  } catch (error: unknown) {
    if (error instanceof KnowledgeSourceVersionLoadError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KnowledgeSourceVersionLoadError(
        'source_content_missing',
        'Knowledge source content file is missing',
        { cause: error },
      );
    }
    throw new KnowledgeSourceVersionLoadError(
      'source_path_rejected',
      'Knowledge source content path could not be resolved safely',
      { cause: error },
    );
  }
}

export function loadKnowledgeSourceVersion(
  db: Database.Database,
  input: { projectId: string; sourceVersionId: string; maxBytes?: number },
): LoadedKnowledgeSourceVersion {
  const row = db
    .prepare(
      `SELECT v.project_id, v.source_id, v.content_path, v.content_hash, v.mime_type, v.byte_length,
              s.source_kind, s.source_path, p.workspace_root
       FROM knowledge_source_versions v
       JOIN knowledge_sources s
         ON s.project_id = v.project_id AND s.id = v.source_id
       JOIN knowledge_projects p
         ON p.id = v.project_id
       WHERE v.project_id = ? AND v.id = ?`,
    )
    .get(input.projectId, input.sourceVersionId) as SourceVersionRow | undefined;

  if (!row) {
    throw new KnowledgeSourceVersionLoadError(
      'source_version_missing',
      `Knowledge source version not found: ${input.sourceVersionId}`,
    );
  }

  const absolutePath = resolveStoredContentPath(row.workspace_root, row.content_path);
  const bytes = readFileSync(absolutePath);
  const maxBytes = input.maxBytes;
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new KnowledgeSourceVersionLoadError(
      'source_too_large',
      `Knowledge source content exceeds the ${maxBytes} byte limit`,
    );
  }

  const contentHash = sha256(bytes);
  if (contentHash !== row.content_hash) {
    throw new KnowledgeSourceVersionLoadError(
      'source_hash_mismatch',
      `Knowledge source content hash mismatch for ${input.sourceVersionId}`,
    );
  }

  const content = decodeUtf8(bytes);

  return {
    projectId: row.project_id,
    sourceId: row.source_id,
    sourceVersionId: input.sourceVersionId,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    contentPath: row.content_path,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    content,
  };
}
