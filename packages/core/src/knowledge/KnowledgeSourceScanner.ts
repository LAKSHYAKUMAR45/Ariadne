import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isAlwaysExcludedCapturePath } from '../FileCapture.js';
import { shouldIngestSource } from './SourcePolicy.js';
import type { SourcePolicy } from './SourcePolicy.js';
import { isPathWithinRoot } from './KnowledgePathSecurity.js';

export interface SourceCandidate {
  path: string;
  absolutePath: string;
  directory: string;
  size: number;
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  const file = await fs.open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(8 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await file.close();
  }
}

async function scanDirectory(
  root: string,
  relativeDirectory: string,
  policy: SourcePolicy,
  candidates: SourceCandidate[],
): Promise<void> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory.replace(/\\/g, '/'), entry.name);
    if (entry.isDirectory()) {
      if (isAlwaysExcludedCapturePath(relativePath)) continue;
      await scanDirectory(root, relativePath, policy, candidates);
      continue;
    }
    if (!entry.isFile()) continue;

    const absolutePath = path.join(root, relativePath);
    const stats = await fs.stat(absolutePath);
    const workspaceRelativePath = path.relative(policy.workspaceRoot, absolutePath).replace(/\\/g, '/');
    const decision = shouldIngestSource(workspaceRelativePath, { ...policy, size: stats.size });
    if (decision.action !== 'ingest' || !decision.path) continue;

    const binaryDecision = shouldIngestSource(decision.path, {
      ...policy,
      size: stats.size,
      isBinary: await isBinaryFile(absolutePath),
    });
    if (binaryDecision.action !== 'ingest' || !binaryDecision.path) continue;

    candidates.push({
      path: binaryDecision.path,
      absolutePath,
      directory: path.posix.dirname(binaryDecision.path) === '.' ? '.' : path.posix.dirname(binaryDecision.path),
      size: stats.size,
    });
  }
}

/**
 * Recursively discovers policy-approved regular files below a source root.
 * Paths are workspace-relative POSIX paths, ordered lexicographically for
 * deterministic imports.
 */
export async function scanKnowledgeSources(
  root: string,
  policy: SourcePolicy,
): Promise<SourceCandidate[]> {
  const workspaceRoot = await fs.realpath(policy.workspaceRoot);
  const absoluteRoot = await fs.realpath(root);
  if (!isPathWithinRoot(workspaceRoot, absoluteRoot)) {
    throw new Error('Knowledge scan root must stay within the workspace');
  }
  const candidates: SourceCandidate[] = [];
  await scanDirectory(absoluteRoot, '.', { ...policy, workspaceRoot }, candidates);
  return candidates.sort((left, right) => left.path.localeCompare(right.path));
}
