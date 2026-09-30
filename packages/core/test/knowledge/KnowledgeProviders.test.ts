import { describe, expect, it } from 'vitest';
import {
  KnowledgeProviderRegistry,
  KnowledgeProviderRequiredError,
  KnowledgeProviderTimeoutError,
  redactKnowledgeProviderPayload,
} from '../../src/knowledge/KnowledgeProviders.js';

describe('KnowledgeProviderRegistry', () => {
  it('registers providers and resolves only providers with the requested capability', () => {
    const registry = new KnowledgeProviderRegistry();
    const provider = { id: 'local-analysis', capabilities: ['analysis', 'generation'] as const };

    registry.register(provider);

    expect(registry.get('analysis')).toStrictEqual(provider);
    expect(registry.supports('generation')).toBe(true);
    expect(registry.supports('research')).toBe(false);
  });

  it('throws a typed error when no provider supports a required capability', () => {
    const registry = new KnowledgeProviderRegistry();

    expect(() => registry.require('embeddings')).toThrow(KnowledgeProviderRequiredError);
    expect(() => registry.require('embeddings')).toThrow('embeddings');
  });

  it('rejects duplicate provider IDs and invalid capability declarations', () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register({ id: 'provider-1', capabilities: ['chat'] });

    expect(() => registry.register({ id: 'provider-1', capabilities: ['analysis'] })).toThrow(/already registered/i);
    expect(() => registry.register({ id: 'provider-2', capabilities: [] })).toThrow(/capability/i);
    expect(() => registry.register({ id: 'provider-3', capabilities: ['unknown' as 'chat'] })).toThrow(
      /unsupported/i,
    );
  });

  it('propagates provider errors and raises a typed timeout error when a call exceeds its deadline', async () => {
    const registry = new KnowledgeProviderRegistry();
    registry.register({ id: 'provider-1', capabilities: ['generation'] });
    const providerFailure = new Error('provider unavailable');

    await expect(
      registry.execute('generation', async () => {
        throw providerFailure;
      }),
    ).rejects.toBe(providerFailure);

    let signal: AbortSignal | undefined;
    await expect(
      registry.execute(
        'generation',
        (context) => {
          signal = context.signal;
          return new Promise<void>(() => undefined);
        },
        { timeoutMs: 1 },
      ),
    ).rejects.toBeInstanceOf(KnowledgeProviderTimeoutError);
    expect(signal?.aborted).toBe(true);
  });
});

describe('redactKnowledgeProviderPayload', () => {
  it('applies the default redactor and an optional provider-specific hook', () => {
    const value = redactKnowledgeProviderPayload('token=do-not-persist', (input) => `[safe] ${input}`);

    expect(value).toBe('[safe] token=***');
  });
});
