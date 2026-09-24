import { redact } from '../Redactor.js';

export const KNOWLEDGE_PROVIDER_CAPABILITIES = [
  'chat',
  'analysis',
  'generation',
  'embeddings',
  'vision',
  'transcription',
  'research',
] as const;

export type KnowledgeProviderCapability = (typeof KNOWLEDGE_PROVIDER_CAPABILITIES)[number];

export interface KnowledgeProvider {
  id: string;
  capabilities: readonly KnowledgeProviderCapability[];
}

export type KnowledgeRedactionHook = (value: string) => string;

export interface KnowledgeProviderExecutionOptions {
  timeoutMs?: number;
  redact?: KnowledgeRedactionHook;
}

export interface KnowledgeProviderExecutionContext {
  provider: KnowledgeProvider;
  signal: AbortSignal;
  redact: (value: string) => string;
}

const providerCapabilities = new Set<string>(KNOWLEDGE_PROVIDER_CAPABILITIES);

export class KnowledgeProviderRequiredError extends Error {
  constructor(readonly capability: KnowledgeProviderCapability) {
    super(`A provider with the ${capability} capability is required.`);
    this.name = 'KnowledgeProviderRequiredError';
  }
}

export class KnowledgeProviderTimeoutError extends Error {
  constructor(
    readonly providerId: string,
    readonly capability: KnowledgeProviderCapability,
    readonly timeoutMs: number,
  ) {
    super(`Provider "${providerId}" timed out while handling ${capability} after ${timeoutMs}ms.`);
    this.name = 'KnowledgeProviderTimeoutError';
  }
}

function requireProviderId(id: string): void {
  if (id.trim().length === 0) {
    throw new Error('Knowledge provider ID must not be empty');
  }
}

function validateCapabilities(capabilities: readonly KnowledgeProviderCapability[]): void {
  if (capabilities.length === 0) {
    throw new Error('Knowledge provider must declare at least one capability');
  }

  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (!providerCapabilities.has(capability)) {
      throw new Error(`Unsupported knowledge provider capability: ${capability}`);
    }
    if (seen.has(capability)) {
      throw new Error(`Knowledge provider capability is duplicated: ${capability}`);
    }
    seen.add(capability);
  }
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new Error('Knowledge provider timeout must be a positive integer');
  }
}

/**
 * Redacts provider prompts, responses, and log payloads before they cross a
 * persistence or diagnostic boundary. A provider-specific hook may remove
 * additional provider-specific sensitive data after shared secret redaction.
 */
export function redactKnowledgeProviderPayload(value: string, hook?: KnowledgeRedactionHook): string {
  const redacted = redact(value);
  return hook === undefined ? redacted : hook(redacted);
}

/**
 * Resolves registered provider capabilities without binding core to a vendor
 * SDK. Callers own provider invocation and receive explicit failures for
 * missing providers and elapsed deadlines.
 */
export class KnowledgeProviderRegistry {
  private readonly providers = new Map<string, KnowledgeProvider>();

  register(provider: KnowledgeProvider): void {
    requireProviderId(provider.id);
    validateCapabilities(provider.capabilities);
    if (this.providers.has(provider.id)) {
      throw new Error(`Knowledge provider "${provider.id}" is already registered`);
    }

    this.providers.set(provider.id, {
      id: provider.id,
      capabilities: [...provider.capabilities],
    });
  }

  get(capability: KnowledgeProviderCapability): KnowledgeProvider | undefined {
    return [...this.providers.values()].find((provider) => provider.capabilities.includes(capability));
  }

  supports(capability: KnowledgeProviderCapability): boolean {
    return this.get(capability) !== undefined;
  }

  require(capability: KnowledgeProviderCapability): KnowledgeProvider {
    const provider = this.get(capability);
    if (provider === undefined) {
      throw new KnowledgeProviderRequiredError(capability);
    }
    return provider;
  }

  async execute<Result>(
    capability: KnowledgeProviderCapability,
    operation: (context: KnowledgeProviderExecutionContext) => Promise<Result> | Result,
    options: KnowledgeProviderExecutionOptions = {},
  ): Promise<Result> {
    validateTimeout(options.timeoutMs);
    const provider = this.require(capability);
    const controller = new AbortController();
    const context: KnowledgeProviderExecutionContext = {
      provider,
      signal: controller.signal,
      redact: (value) => redactKnowledgeProviderPayload(value, options.redact),
    };
    const result = Promise.resolve().then(() => operation(context));

    if (options.timeoutMs === undefined) {
      return result;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new KnowledgeProviderTimeoutError(provider.id, capability, options.timeoutMs!));
      }, options.timeoutMs);
    });

    try {
      return await Promise.race([result, timeoutResult]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
