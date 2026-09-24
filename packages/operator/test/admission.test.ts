import { describe, expect, it } from 'vitest';
import {
  OperationAdmissionRegistry,
  createSerialQueue,
} from '../src/admission.js';

describe('OperationAdmissionRegistry', () => {
  it('reserves exactly one distinct operation at a time', () => {
    const registry = new OperationAdmissionRegistry({ ttlMs: 1000, maxEntries: 10 });

    const first = registry.reserve('op-a');
    expect(first).toEqual({
      kind: 'reserved',
      accepted: { operationId: 'op-a', accepted: true },
    });
    expect(registry.activeOperationId).toBe('op-a');

    expect(registry.reserve('op-b')).toEqual({ kind: 'busy' });
    expect(registry.activeOperationId).toBe('op-a');
  });

  it('returns the prior acceptance for duplicates while active and after settling', () => {
    const registry = new OperationAdmissionRegistry({ ttlMs: 1000, maxEntries: 10 });

    registry.reserve('op-a');
    expect(registry.reserve('op-a')).toEqual({
      kind: 'duplicate',
      accepted: { operationId: 'op-a', accepted: true },
    });

    registry.settle('op-a');
    expect(registry.activeOperationId).toBeNull();
    expect(registry.reserve('op-a')).toEqual({
      kind: 'duplicate',
      accepted: { operationId: 'op-a', accepted: true },
    });
  });

  it('never leaves a rejected operation id reserved or cached as terminal', () => {
    const registry = new OperationAdmissionRegistry({ ttlMs: 1000, maxEntries: 10 });

    registry.reserve('op-a');
    expect(registry.reserve('op-b')).toEqual({ kind: 'busy' });

    registry.settle('op-a');
    expect(registry.reserve('op-b')).toEqual({
      kind: 'reserved',
      accepted: { operationId: 'op-b', accepted: true },
    });
  });

  it('bounds the terminal cache by ttl and entry count', () => {
    let currentTime = 0;
    const registry = new OperationAdmissionRegistry({
      ttlMs: 100,
      maxEntries: 1,
      now: () => currentTime,
    });

    registry.reserve('op-a');
    registry.settle('op-a');
    registry.reserve('op-b');
    registry.settle('op-b');

    // `op-a` was evicted by the single-entry bound, so it is admissible again.
    expect(registry.reserve('op-a')).toMatchObject({ kind: 'reserved' });
    registry.settle('op-a');

    currentTime += 101;
    expect(registry.reserve('op-a')).toMatchObject({ kind: 'reserved' });
  });
});

describe('createSerialQueue', () => {
  it('runs admission sections one at a time even when they await', async () => {
    const runExclusively = createSerialQueue();
    const events: string[] = [];

    const first = runExclusively(async () => {
      events.push('first:enter');
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push('first:exit');
      return 1;
    });
    const second = runExclusively(async () => {
      events.push('second:enter');
      events.push('second:exit');
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
  });

  it('keeps the queue usable after a section throws', async () => {
    const runExclusively = createSerialQueue();

    await expect(
      runExclusively(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrowError('boom');

    await expect(runExclusively(async () => 'ok')).resolves.toBe('ok');
  });
});
