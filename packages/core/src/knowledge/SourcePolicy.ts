import path from 'node:path';
import { isAlwaysExcludedCapturePath } from '../FileCapture.js';
import { normalizeKnowledgePath } from './KnowledgeIds.js';
export { isPathWithinRoot } from './KnowledgePathSecurity.js';

export type SourceDecisionAction = 'ingest' | 'skip' | 'reject';
export type SourceDecisionReason =
  | 'outside_workspace'
  | 'sensitive_path'
  | 'ariadneignore'
  | 'binary'
  | 'file_too_large';

export interface SourceDecision {
  action: SourceDecisionAction;
  path?: string;
  reason?: SourceDecisionReason;
}

export interface SourcePolicy {
  workspaceRoot: string;
  maxBytes?: number;
  size?: number;
  isBinary?: boolean;
  allowBinary?: boolean;
  ignorePatterns?: string[];
}

const SENSITIVE_PATH_PATTERN =
  /(^|\/)(?:\.env(?:\..*)?|.*(?:credential|token|secret|password|passwd|api[-_]?key).*)$/i;

function matchesIgnorePattern(pattern: string, candidate: string): boolean {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('#')) return false;
  const escaped = normalized
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}(?:/.*)?$`).test(candidate);
}

/**
 * Applies conservative, path-only source admission checks. Content is never
 * stored or inspected by this function; callers can use Redactor before
 * persisting content after a source has been admitted.
 */
export function shouldIngestSource(sourcePath: string, policy: SourcePolicy): SourceDecision {
  let normalized: string;
  try {
    normalized = normalizeKnowledgePath(sourcePath);
  } catch {
    return { action: 'reject', reason: 'outside_workspace' };
  }

  const absolute = path.resolve(policy.workspaceRoot, normalized);
  const root = path.resolve(policy.workspaceRoot);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return { action: 'reject', path: normalized, reason: 'outside_workspace' };
  }
  if (isAlwaysExcludedCapturePath(normalized) || SENSITIVE_PATH_PATTERN.test(normalized)) {
    return { action: 'reject', path: normalized, reason: 'sensitive_path' };
  }
  if ((policy.ignorePatterns ?? []).some((pattern) => matchesIgnorePattern(pattern, normalized))) {
    return { action: 'skip', path: normalized, reason: 'ariadneignore' };
  }
  if (policy.isBinary && !policy.allowBinary) {
    return { action: 'skip', path: normalized, reason: 'binary' };
  }
  if (policy.size !== undefined && policy.maxBytes !== undefined && policy.size > policy.maxBytes) {
    return { action: 'skip', path: normalized, reason: 'file_too_large' };
  }
  return { action: 'ingest', path: normalized };
}
