import { createHash } from 'node:crypto';
import path from 'node:path';
import { ulid } from 'ulid';

/**
 * Creates a stable knowledge identifier. Seeded identifiers are deterministic
 * so repeated imports of the same source can be reconciled without duplication.
 */
export function createKnowledgeId(prefix: string, seed?: string): string {
  const normalizedPrefix = prefix.trim();
  if (normalizedPrefix.length === 0) {
    throw new Error('Knowledge ID prefix must not be empty');
  }

  const suffix =
    seed === undefined
      ? ulid()
      : createHash('sha256').update(seed).digest('hex').slice(0, 32);

  return `${normalizedPrefix}_${suffix}`;
}

/**
 * Converts a workspace-relative path to its canonical POSIX representation.
 */
export function normalizeKnowledgePath(value: string): string {
  const candidate = value.trim().replace(/\\/g, '/');
  const normalized = path.posix
    .normalize(candidate)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (
    normalized.length === 0 ||
    normalized === '.' ||
    /^[A-Za-z]:/.test(candidate) ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error('Knowledge path must stay within the workspace');
  }

  return normalized;
}
