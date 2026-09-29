import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeKnowledgePath } from './KnowledgeIds.js';
import { assertNoSymlinkComponents, isPathWithinRoot } from './KnowledgePathSecurity.js';

function sanitizeStorageSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';
}

/**
 * Writes content-addressed source content below `.ariadne/knowledge/sources` and returns the path relative to
 * `.ariadne/knowledge`, which is what `knowledge_source_versions.content_path` stores. Rewriting the same content is
 * idempotent because the file name embeds the content hash.
 */
export function storeImmutableKnowledgeSourceContent(workspaceRoot: string, sourcePath: string, content: string): string {
  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  const normalizedPath = normalizeKnowledgePath(sourcePath);
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  const extension = path.posix.extname(normalizedPath);
  const stem = extension ? normalizedPath.slice(0, -extension.length) : normalizedPath;
  const directory = path.posix.dirname(stem);
  const baseName = sanitizeStorageSegment(path.posix.basename(stem));
  const storedDirectory = directory === '.' ? 'workspace' : path.posix.join('workspace', directory);
  const storedRelativePath = path.posix.join('sources', storedDirectory, `${baseName}-${contentHash}${extension}`);
  const absolutePath = path.join(canonicalWorkspaceRoot, '.ariadne', 'knowledge', storedRelativePath);
  assertNoSymlinkComponents(canonicalWorkspaceRoot, absolutePath, 'Knowledge source content path');
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  if (!isPathWithinRoot(canonicalWorkspaceRoot, realpathSync(path.dirname(absolutePath)))) {
    throw new Error('Knowledge source content path must stay within the workspace');
  }
  writeFileSync(absolutePath, content, 'utf8');
  return storedRelativePath;
}
