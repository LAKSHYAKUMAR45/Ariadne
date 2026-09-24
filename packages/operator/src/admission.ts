import type { OperatorAccepted } from './protocol.js';

export const DEFAULT_TERMINAL_CACHE_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_TERMINAL_CACHE_MAX_ENTRIES = 512;

export type AdmissionDecision =
  | { kind: 'reserved'; accepted: OperatorAccepted }
  | { kind: 'duplicate'; accepted: OperatorAccepted }
  | { kind: 'busy' };

export interface OperationAdmissionRegistryOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface TerminalCacheEntry {
  accepted: OperatorAccepted;
  expiresAt: number;
}

/** Bounded TTL + LRU cache of terminal acceptances, keyed by operation id. */
class TerminalAcceptanceCache {
  private readonly entries = new Map<string, TerminalCacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(operationId: string): OperatorAccepted | undefined {
    const entry = this.entries.get(operationId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(operationId);
      return undefined;
    }

    this.entries.delete(operationId);
    this.entries.set(operationId, entry);
    return entry.accepted;
  }

  set(operationId: string, accepted: OperatorAccepted): void {
    this.entries.delete(operationId);
    this.entries.set(operationId, { accepted, expiresAt: this.now() + this.ttlMs });
    this.prune();
  }

  private prune(): void {
    const currentTime = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= currentTime) {
        this.entries.delete(key);
      }
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.entries.delete(oldestKey);
    }
  }
}

/**
 * Single-slot admission bookkeeping for the operator.
 *
 * `reserve` is the only place an operation id becomes active, and it both
 * checks and claims the slot in one synchronous step so an awaited caller can
 * never observe an idle operator that another caller has already claimed. Ids
 * that are refused (`busy`) are never recorded, so they stay admissible once
 * the operator goes idle again.
 */
export class OperationAdmissionRegistry {
  private readonly activeById = new Map<string, OperatorAccepted>();
  private readonly terminalCache: TerminalAcceptanceCache;
  private reservedOperationId: string | null = null;

  constructor(options: OperationAdmissionRegistryOptions = {}) {
    this.terminalCache = new TerminalAcceptanceCache(
      options.ttlMs ?? DEFAULT_TERMINAL_CACHE_TTL_MS,
      options.maxEntries ?? DEFAULT_TERMINAL_CACHE_MAX_ENTRIES,
      options.now ?? Date.now,
    );
  }

  get activeOperationId(): string | null {
    return this.reservedOperationId;
  }

  reserve(operationId: string): AdmissionDecision {
    const previousAcceptance =
      this.activeById.get(operationId) ?? this.terminalCache.get(operationId);
    if (previousAcceptance) {
      return { kind: 'duplicate', accepted: previousAcceptance };
    }

    if (this.reservedOperationId !== null) {
      return { kind: 'busy' };
    }

    const accepted: OperatorAccepted = { operationId, accepted: true };
    this.reservedOperationId = operationId;
    this.activeById.set(operationId, accepted);
    return { kind: 'reserved', accepted };
  }

  /** Marks a reserved operation terminal and frees the single active slot. */
  settle(operationId: string): void {
    const accepted = this.activeById.get(operationId) ?? {
      operationId,
      accepted: true as const,
    };
    this.activeById.delete(operationId);
    this.terminalCache.set(operationId, accepted);
    if (this.reservedOperationId === operationId) {
      this.reservedOperationId = null;
    }
  }
}

export type SerialQueue = <T>(task: () => Promise<T> | T) => Promise<T>;

/**
 * Serializes admission sections so that, even if the critical section ever
 * awaits, no two requests can interleave between checking and claiming the
 * operator's single active slot.
 */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T> | T): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
