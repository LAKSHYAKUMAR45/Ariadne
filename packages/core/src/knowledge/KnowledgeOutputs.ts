import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { redactLines } from '../Redactor.js';
import { createKnowledgeId, normalizeKnowledgePath } from './KnowledgeIds.js';
import type { KnowledgeProvenanceRef } from './KnowledgeTypes.js';

const METADATA_FILE = '.ariadne-output-metadata.json';
const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export type KnowledgeOutputOverwritePolicy = 'forbid' | 'replace';

export interface KnowledgeOutput {
  id: string;
  projectId: string;
  kind: string;
  path: string;
  contentHash: string;
  mimeType: string;
  size: number;
  provenance: KnowledgeProvenanceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeOutputInput {
  projectId: string;
  kind: string;
  path: string;
  content: string | Uint8Array;
  mimeType?: string;
  provenance?: KnowledgeProvenanceRef[];
  overwrite?: KnowledgeOutputOverwritePolicy;
}

export interface KnowledgeOutputPreview {
  output: KnowledgeOutput;
  content: string | Uint8Array;
}

export interface KnowledgeOutputStoreOptions {
  now?: () => string;
}

interface StoredOutputs {
  outputs: KnowledgeOutput[];
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge output ${label} must not be empty`);
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.endsWith('+json') || mimeType === 'application/yaml';
}

function inferMimeType(relativePath: string): string {
  return MIME_TYPES[path.posix.extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
}

function validateProvenance(provenance: readonly KnowledgeProvenanceRef[]): KnowledgeProvenanceRef[] {
  return provenance.map((reference) => {
    requireNonEmpty(reference.kind, 'provenance kind');
    requireNonEmpty(reference.id, 'provenance ID');
    if (
      reference.confidence !== undefined &&
      (!Number.isFinite(reference.confidence) || reference.confidence < 0 || reference.confidence > 1)
    ) {
      throw new Error('Knowledge output provenance confidence must be between 0 and 1');
    }
    return { ...reference };
  });
}

function resolveOutputPath(root: string, candidate: string): { relativePath: string; absolutePath: string } {
  if (candidate.replace(/\\/g, '/').split('/').includes('..')) {
    throw new Error('Knowledge output path must stay within the output root');
  }
  const relativePath = normalizeKnowledgePath(candidate);
  if (relativePath === METADATA_FILE) throw new Error('Knowledge output path is reserved');
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Knowledge output path must stay within the output root');
  }
  return { relativePath, absolutePath };
}

function assertNoSymlinkInPath(root: string, target: string): void {
  let current = root;
  const segments = path.relative(root, target).split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('Knowledge output path must not traverse symbolic links');
    }
  }
}

function outputContent(content: string | Uint8Array, mimeType: string): Uint8Array {
  if (typeof content === 'string') {
    return Buffer.from(isTextMimeType(mimeType) ? redactLines(content) : content, 'utf8');
  }
  return Buffer.from(content);
}

/**
 * Stores generated workspace artifacts under one root. It only performs
 * confined file operations and carries no executable action interface.
 */
export class KnowledgeOutputStore {
  private readonly root: string;
  private readonly now: () => string;

  public constructor(root: string, options: KnowledgeOutputStoreOptions = {}) {
    requireNonEmpty(root, 'root');
    this.root = path.resolve(root);
    this.now = options.now ?? (() => new Date().toISOString());
    mkdirSync(this.root, { recursive: true });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Knowledge output root must not be a symbolic link');
  }

  public create(input: CreateKnowledgeOutputInput): KnowledgeOutput {
    requireNonEmpty(input.projectId, 'project ID');
    requireNonEmpty(input.kind, 'kind');
    const { relativePath, absolutePath } = resolveOutputPath(this.root, input.path);
    assertNoSymlinkInPath(this.root, absolutePath);
    const mimeType = input.mimeType ?? inferMimeType(relativePath);
    requireNonEmpty(mimeType, 'MIME type');
    const overwrite = input.overwrite ?? 'forbid';
    if (overwrite !== 'forbid' && overwrite !== 'replace') throw new Error(`Unsupported knowledge output overwrite policy: ${overwrite}`);
    if (existsSync(absolutePath) && overwrite === 'forbid') {
      throw new Error(`Knowledge output already exists: ${relativePath}`);
    }

    const bytes = outputContent(input.content, mimeType);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const timestamp = this.now();
    const existing = this.load().outputs.find(
      (output) => output.projectId === input.projectId && output.path === relativePath,
    );
    const output: KnowledgeOutput = {
      id: existing?.id ?? createKnowledgeId('output'),
      projectId: input.projectId,
      kind: input.kind,
      path: relativePath,
      contentHash: hash,
      mimeType,
      size: bytes.byteLength,
      provenance: validateProvenance(input.provenance ?? []),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    const previousContent = existsSync(absolutePath) ? readFileSync(absolutePath) : undefined;
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    try {
      this.writeAtomically(absolutePath, bytes, overwrite === 'replace');
      const stored = this.load();
      const outputs = stored.outputs.filter((item) => item.id !== output.id);
      outputs.push(output);
      this.save({ outputs });
    } catch (error) {
      if (previousContent === undefined) {
        rmSync(absolutePath, { force: true });
      } else {
        this.writeAtomically(absolutePath, previousContent, true);
      }
      throw error;
    }
    return output;
  }

  public list(projectId: string): KnowledgeOutput[] {
    requireNonEmpty(projectId, 'project ID');
    return this.load().outputs
      .filter((output) => output.projectId === projectId)
      .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
      .map((output) => ({ ...output, provenance: output.provenance.map((reference) => ({ ...reference })) }));
  }

  public preview(projectId: string, id: string): KnowledgeOutputPreview | undefined {
    const output = this.find(projectId, id);
    if (!output) return undefined;
    const { absolutePath } = resolveOutputPath(this.root, output.path);
    assertNoSymlinkInPath(this.root, absolutePath);
    if (!existsSync(absolutePath)) throw new Error(`Knowledge output content is missing: ${output.path}`);
    const bytes = readFileSync(absolutePath);
    return {
      output,
      content: isTextMimeType(output.mimeType) ? bytes.toString('utf8') : bytes,
    };
  }

  public delete(projectId: string, id: string): boolean {
    const output = this.find(projectId, id);
    if (!output) return false;
    const { absolutePath } = resolveOutputPath(this.root, output.path);
    assertNoSymlinkInPath(this.root, absolutePath);
    const previousContent = existsSync(absolutePath) ? readFileSync(absolutePath) : undefined;
    try {
      if (existsSync(absolutePath)) rmSync(absolutePath, { force: true });
      const stored = this.load();
      this.save({ outputs: stored.outputs.filter((item) => item.id !== id) });
    } catch (error) {
      if (previousContent !== undefined) this.writeAtomically(absolutePath, previousContent, true);
      throw error;
    }
    return true;
  }

  private find(projectId: string, id: string): KnowledgeOutput | undefined {
    requireNonEmpty(projectId, 'project ID');
    requireNonEmpty(id, 'ID');
    return this.load().outputs.find((output) => output.projectId === projectId && output.id === id);
  }

  private load(): StoredOutputs {
    const metadataPath = path.join(this.root, METADATA_FILE);
    if (!existsSync(metadataPath)) return { outputs: [] };
    assertNoSymlinkInPath(this.root, metadataPath);
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as Partial<StoredOutputs>).outputs)
    ) {
      throw new Error('Knowledge output metadata is invalid');
    }
    return parsed as StoredOutputs;
  }

  private save(stored: StoredOutputs): void {
    const metadataPath = path.join(this.root, METADATA_FILE);
    assertNoSymlinkInPath(this.root, metadataPath);
    this.writeAtomically(metadataPath, Buffer.from(`${JSON.stringify(stored, null, 2)}\n`, 'utf8'), true);
  }

  private writeAtomically(target: string, content: Uint8Array, replace: boolean): void {
    assertNoSymlinkInPath(this.root, target);
    this.assertCanonicalParent(target);
    if (existsSync(target) && !replace) throw new Error(`Knowledge output already exists: ${path.relative(this.root, target)}`);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: 'wx' });
      assertNoSymlinkInPath(this.root, target);
      this.assertCanonicalParent(target);
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
  }

  private assertCanonicalParent(target: string): void {
    const canonicalRoot = realpathSync(this.root);
    const canonicalParent = realpathSync(path.dirname(target));
    if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error('Knowledge output path must stay within the output root');
    }
  }
}
