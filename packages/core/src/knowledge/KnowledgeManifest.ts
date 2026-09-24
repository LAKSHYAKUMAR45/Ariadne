import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KnowledgeProjectId } from './KnowledgeTypes.js';

export const KNOWLEDGE_MANIFEST_VERSION = 1 as const;

export interface KnowledgeManifest {
  manifestVersion: typeof KNOWLEDGE_MANIFEST_VERSION;
  projectId: KnowledgeProjectId;
  generatedAt: string;
  format: 'ariadne-knowledge';
}

function validateManifest(value: unknown): KnowledgeManifest {
  if (value === null || typeof value !== 'object') throw new Error('Invalid knowledge manifest');
  const manifest = value as Partial<KnowledgeManifest>;
  if (manifest.manifestVersion !== KNOWLEDGE_MANIFEST_VERSION) {
    throw new Error(`Unsupported knowledge manifest version: ${String(manifest.manifestVersion)}`);
  }
  if (typeof manifest.projectId !== 'string' || manifest.projectId.trim().length === 0) {
    throw new Error('Knowledge manifest project ID must not be empty');
  }
  if (typeof manifest.generatedAt !== 'string' || manifest.generatedAt.trim().length === 0) {
    throw new Error('Knowledge manifest generatedAt must not be empty');
  }
  if (manifest.format !== 'ariadne-knowledge') throw new Error('Invalid knowledge manifest format');
  return manifest as KnowledgeManifest;
}

export function buildKnowledgeManifest(projectId: string, generatedAt = new Date().toISOString()): KnowledgeManifest {
  if (projectId.trim().length === 0) throw new Error('Knowledge manifest project ID must not be empty');
  return {
    manifestVersion: KNOWLEDGE_MANIFEST_VERSION,
    projectId: projectId as KnowledgeProjectId,
    generatedAt,
    format: 'ariadne-knowledge',
  };
}

export function writeKnowledgeManifest(root: string, manifest: KnowledgeManifest): void {
  const validated = validateManifest(manifest);
  mkdirSync(root, { recursive: true });
  const target = path.join(root, 'manifest.json');
  const temporary = path.join(root, `.manifest.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    const descriptor = openSync(temporary, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function readKnowledgeManifest(root: string, expectedProjectId?: string): KnowledgeManifest {
  const manifest = validateManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as unknown);
  if (expectedProjectId !== undefined && manifest.projectId !== expectedProjectId) {
    throw new Error(`Knowledge manifest project ID mismatch: expected ${expectedProjectId}`);
  }
  return manifest;
}
