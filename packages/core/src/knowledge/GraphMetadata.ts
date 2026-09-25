import { redactLines } from '../Redactor.js';

export type GraphJsonLike = null | boolean | number | string | GraphJsonLike[] | { [key: string]: GraphJsonLike };

export const GRAPH_METADATA_LIMITS = {
  maxDepth: 4,
  maxEntries: 64,
  maxStringLength: 512,
  maxSerializedBytes: 4096,
} as const;

const TRUNCATION_SUFFIX = ' …[truncated]';
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEFAULT_PROVENANCE_METADATA_KEYS = new Set([
  'callee',
  'confidence',
  'context',
  'diagnostic',
  'detail',
  'edgeType',
  'exportKind',
  'exportedName',
  'explicit',
  'importKind',
  'importedName',
  'inferred',
  'kind',
  'label',
  'localName',
  'moduleSpecifier',
  'occurrence',
  'origin',
  'originalEdgeType',
  'original_rank',
  'provider',
  'reason',
  'referenceKind',
  'relation',
  'relationshipSource',
  'source_file',
  'source_location',
  'sourceLocation',
  'specifier',
  'type',
  'unparsedSourceLocation',
]);

const DEFAULT_GRAPHIFY_METADATA_KEYS = new Set([
  'confidence',
  'context',
  'edgeType',
  'explicit',
  'id',
  'inferred',
  'kind',
  'label',
  'original_rank',
  'relation',
  'source',
  'sourceFile',
  'sourceLocation',
  'source_file',
  'source_location',
  'target',
  'type',
  'unparsedSourceLocation',
]);

interface SanitizeState {
  entries: number;
  seen: WeakSet<object>;
}

interface SanitizeOptions {
  context: string;
  allowKeys?: ReadonlySet<string>;
  allowNestedObjects: boolean;
  state?: SanitizeState;
}

function createSafeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function truncateString(value: string): string {
  if (value.length <= GRAPH_METADATA_LIMITS.maxStringLength) {
    return value;
  }
  const budget = GRAPH_METADATA_LIMITS.maxStringLength - TRUNCATION_SUFFIX.length;
  return `${value.slice(0, Math.max(0, budget))}${TRUNCATION_SUFFIX}`;
}

function stableJsonStringifyInternal(value: GraphJsonLike): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringifyInternal(entry)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringifyInternal(entry)}`).join(',')}}`;
}

function assertSerializedSize(value: GraphJsonLike, context: string): void {
  const serialized = stableJsonStringifyInternal(value);
  if (Buffer.byteLength(serialized, 'utf8') > GRAPH_METADATA_LIMITS.maxSerializedBytes) {
    throw new Error(
      `${context} exceeds maximum serialized size of ${GRAPH_METADATA_LIMITS.maxSerializedBytes} bytes`,
    );
  }
}

function sanitizeValue(
  value: unknown,
  depth: number,
  options: SanitizeOptions,
): GraphJsonLike {
  const state = options.state ?? { entries: 0, seen: new WeakSet<object>() };
  if (depth > GRAPH_METADATA_LIMITS.maxDepth) {
    throw new Error(`${options.context} exceeds maximum depth of ${GRAPH_METADATA_LIMITS.maxDepth}`);
  }
  if (value === null) return null;
  if (typeof value === 'string') {
    return truncateString(redactLines(value));
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${options.context} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const items: GraphJsonLike[] = [];
    for (const item of value) {
      state.entries += 1;
      if (state.entries > GRAPH_METADATA_LIMITS.maxEntries) {
        throw new Error(`${options.context} exceeds maximum entry count of ${GRAPH_METADATA_LIMITS.maxEntries}`);
      }
      items.push(sanitizeValue(item, depth + 1, { ...options, state }));
    }
    return items;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${options.context} contains an unsupported value type`);
  }
  if (!options.allowNestedObjects && depth > 0) {
    throw new Error(`${options.context} must not contain nested objects`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${options.context} must use plain objects`);
  }
  if (state.seen.has(value)) {
    throw new Error(`${options.context} contains a circular reference`);
  }
  state.seen.add(value);
  const output = createSafeRecord<GraphJsonLike>();
  try {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      state.entries += 1;
      if (state.entries > GRAPH_METADATA_LIMITS.maxEntries) {
        throw new Error(`${options.context} exceeds maximum entry count of ${GRAPH_METADATA_LIMITS.maxEntries}`);
      }
      if (UNSAFE_OBJECT_KEYS.has(key)) {
        continue;
      }
      if (options.allowKeys && !options.allowKeys.has(key)) {
        continue;
      }
      output[key] = sanitizeValue(entry, depth + 1, { ...options, state });
    }
  } finally {
    state.seen.delete(value);
  }
  return output;
}

function sanitizeObjectMetadata(
  value: unknown,
  options: Omit<SanitizeOptions, 'state'>,
): Record<string, GraphJsonLike> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${options.context} must be an object`);
  }
  const sanitized = sanitizeValue(value, 0, options);
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== 'object') {
    throw new Error(`${options.context} must be an object`);
  }
  assertSerializedSize(sanitized, options.context);
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function sanitizeProvenanceMetadata(
  value: unknown,
  context: string,
  allowKeys: ReadonlySet<string> = DEFAULT_PROVENANCE_METADATA_KEYS,
): Record<string, GraphJsonLike> | undefined {
  return sanitizeObjectMetadata(value, {
    context,
    allowKeys,
    allowNestedObjects: false,
  });
}

export function sanitizeGraphifyMetadata(
  value: unknown,
  context: string,
  allowKeys: ReadonlySet<string> = DEFAULT_GRAPHIFY_METADATA_KEYS,
): Record<string, GraphJsonLike> | undefined {
  return sanitizeObjectMetadata(value, {
    context,
    allowKeys,
    allowNestedObjects: true,
  });
}

export function sanitizeLegacyProvenanceMetadata(
  value: unknown,
  context: string,
): Record<string, GraphJsonLike> | undefined {
  return sanitizeObjectMetadata(value, {
    context,
    allowNestedObjects: true,
  });
}

export function sanitizeGraphJsonValue(value: unknown, context: string): GraphJsonLike {
  const sanitized = sanitizeValue(value, 0, {
    context,
    allowNestedObjects: true,
  });
  assertSerializedSize(sanitized, context);
  return sanitized;
}

export function stableGraphJsonStringify(value: unknown, context: string): string {
  return stableJsonStringifyInternal(sanitizeGraphJsonValue(value, context));
}
