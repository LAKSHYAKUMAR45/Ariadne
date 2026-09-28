import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import http from 'node:http';
import { openDatabase } from '../../src/db.js';
import { createKnowledgeId } from '../../src/knowledge/KnowledgeIds.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeProjectStore } from '../../src/knowledge/KnowledgeProjectStore.js';
import {
  KnowledgeProviderProfileStore,
  type KnowledgeProviderProfile,
} from '../../src/knowledge/KnowledgeProviderProfiles.js';
import {
  OpenAICompatibleEnrichmentService,
  OpenAICompatibleProvider,
  type OpenAICompatibleHostPolicy,
  type OpenAICompatibleResolvedAddress,
  type OpenAICompatibleTransport,
} from '../../src/knowledge/providers/OpenAICompatibleProvider.js';
import type { DeterministicExtraction, ExtractedSection, ExtractedSymbol } from '../../src/knowledge/KnowledgeExtraction.js';

const CREATED_AT = '2026-09-28T00:00:00.000Z';
const DEFAULT_API_KEY_ENV = 'ARIADNE_KNOWLEDGE_PROVIDER_DEFAULT_KEY';

function groundedSpan(sourceId = 'source-1') {
  return {
    sourceId,
    sourceVersionId: 'source-version-1',
    startOffset: 0,
    endOffset: 12,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 13,
    label: 'section',
  };
}

function createProfile(endpoint: string, overrides: Partial<KnowledgeProviderProfile> = {}): KnowledgeProviderProfile {
  return {
    id: overrides.id ?? 'provider-profile-1',
    projectId: overrides.projectId ?? 'project-openai',
    providerKind: 'openai-compatible',
    profileName: overrides.profileName ?? 'default',
    endpoint,
    model: overrides.model ?? 'gpt-4.1-mini',
    capabilities: overrides.capabilities ?? ['analysis'],
    timeoutMs: overrides.timeoutMs ?? 2_000,
    apiKeyEnv: overrides.apiKeyEnv === undefined ? DEFAULT_API_KEY_ENV : overrides.apiKeyEnv,
    enabled: overrides.enabled ?? true,
  };
}

function analysisPayload(sourceId: string) {
  return {
    summary: 'Grounded summary',
    entities: [
      {
        id: 'entity-1',
        name: 'Greeter',
        type: 'module',
        sourceIds: [sourceId],
        sourceSpans: [groundedSpan(sourceId)],
        confidence: 0.9,
      },
    ],
    claims: [
      {
        id: 'claim-1',
        statement: 'The module defines Greeter.',
        sourceIds: [sourceId],
        sourceSpans: [groundedSpan(sourceId)],
        confidence: 0.9,
      },
    ],
    relationships: [
      {
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-1',
        type: 'references',
        sourceIds: [sourceId],
        sourceSpans: [groundedSpan(sourceId)],
        confidence: 0.8,
      },
    ],
    contradictions: [
      {
        summary: 'The summary may overstate the current implementation.',
        claimIds: ['claim-1'],
        sourceIds: [sourceId],
        sourceSpans: [groundedSpan(sourceId)],
        confidence: 0.4,
      },
    ],
    researchGaps: [
      {
        question: 'Should this module expose additional examples?',
        sourceIds: [sourceId],
        sourceSpans: [groundedSpan(sourceId)],
        confidence: 0.3,
      },
    ],
  };
}

function generationPayload(sourceId: string) {
  return {
    status: 'generated',
    title: 'Generated source page',
    content: '# Generated source page\n\nGrounded content only.\n',
    analysis: analysisPayload(sourceId),
  };
}

function createExtraction(options: { sectionCount?: number; sectionLength?: number } = {}): DeterministicExtraction {
  const sectionCount = options.sectionCount ?? 1;
  const sectionLength = options.sectionLength ?? 24;
  const sections: ExtractedSection[] = [];
  const symbols: ExtractedSymbol[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const startOffset = index * (sectionLength + 1);
    sections.push({
      id: `section-${index + 1}`,
      kind: 'body',
      title: `Body ${index + 1}`,
      text: `${'x'.repeat(sectionLength)} ${index + 1}`,
      confidence: 1,
      span: {
        startOffset,
        endOffset: startOffset + sectionLength,
        startLine: index + 1,
        startColumn: 1,
        endLine: index + 1,
        endColumn: sectionLength + 1,
        label: 'section',
      },
    });
    symbols.push({
      id: `symbol-${index + 1}`,
      kind: 'class',
      name: `Greeter${index + 1}`,
      qualifiedName: `Greeter${index + 1}`,
      confidence: 1,
      span: {
        startOffset,
        endOffset: startOffset + sectionLength,
        startLine: index + 1,
        startColumn: 1,
        endLine: index + 1,
        endColumn: sectionLength + 1,
        label: 'symbol',
      },
    });
  }
  return {
    analyzerId: 'stub-analyzer',
    analyzerVersion: '1.0.0',
    sourceVersionId: 'source-version-1',
    title: 'src/example.py',
    summary: 'Deterministic summary',
    sections,
    symbols,
    relationships: [],
    links: [],
    diagnostics: [],
  };
}

describe('OpenAICompatibleProvider', () => {
  const servers = new Set<http.Server>();
  const databases: Database.Database[] = [];

  afterEach(async () => {
    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    servers.clear();
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  async function startServer(
    handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>,
  ): Promise<{ endpoint: string; requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> }> {
    const requests: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      requests.push({
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      await handler(request, response);
    });
    servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected loopback server address');
    }
    return {
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      requests,
    };
  }

  function database(): Database.Database {
    const db = openDatabase(':memory:');
    databases.push(db);
    return db;
  }

  function loopbackProvider(endpoint: string, options: { allowCredentials?: boolean; fetchImplementation?: typeof fetch } = {}) {
    const hostPolicy: OpenAICompatibleHostPolicy = {
      allowedOrigins: new Set([new URL(endpoint).origin]),
    };
    return new OpenAICompatibleProvider({
      fetchImplementation: options.fetchImplementation,
      hostPolicy,
      credentialPolicy: options.allowCredentials === false
        ? {}
        : { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
    });
  }

  function staticTransport(
    fetchImplementation: typeof fetch,
    addresses: readonly OpenAICompatibleResolvedAddress[],
  ): OpenAICompatibleTransport {
    return {
      fetch: fetchImplementation,
      pinsResolvedHostnames: true,
      async resolveHostname() {
        return addresses;
      },
    };
  }

  it('sends OpenAI-compatible chat completion requests and adds Authorization only when the environment provides a value', async () => {
    const { endpoint, requests } = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(analysisPayload('source-1')),
              },
            },
          ],
        }),
      );
    });
    const provider = loopbackProvider(endpoint);
    const profile = createProfile(endpoint);

    await provider.analyze({
      profile,
      environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
      prompt: 'Return grounded analysis JSON.',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [groundedSpan()],
    });
    await provider.analyze({
      profile,
      environment: {},
      prompt: 'Return grounded analysis JSON.',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [groundedSpan()],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.path).toBe('/v1/chat/completions');
    expect(requests[0]?.headers.authorization).toBeDefined();
    expect(requests[1]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(requests[0]?.body ?? '{}')).toMatchObject({
      model: 'gpt-4.1-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ],
    });
  });

  it('rejects timeouts with redacted bounded diagnostics', async () => {
    const { endpoint } = await startServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [] }));
    });
    const provider = loopbackProvider(endpoint);
    const profile = createProfile(endpoint, { timeoutMs: 50 });

    await expect(() =>
      provider.analyze({
        profile,
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: `Prompt ${'x'.repeat(2_000)}`,
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/timed out/i);
    await expect(() =>
      provider.analyze({
        profile,
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: `Prompt ${'x'.repeat(2_000)}`,
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.not.toThrow(/sk-live-provider-key/);
  });

  it('applies timeout and abort handling to destination validation before fetch', async () => {
    let fetchCalls = 0;
    const provider = new OpenAICompatibleProvider({
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      hostPolicy: { allowedOrigins: new Set(['https://api.example.com']) },
      transport: {
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('fetch should not run');
        },
        pinsResolvedHostnames: true,
        async resolveHostname() {
          await new Promise(() => {});
          return [];
        },
      },
    });

    await expect(() =>
      provider.analyze({
        profile: createProfile('https://api.example.com/v1', { timeoutMs: 50 }),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/timed out/i);
    expect(fetchCalls).toBe(0);
  });

  it('rejects oversized direct prompts before sending a request', async () => {
    let fetchCalls = 0;
    const provider = new OpenAICompatibleProvider({
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      hostPolicy: { allowedOrigins: new Set(['https://api.example.com']) },
      transport: staticTransport(async () => {
        fetchCalls += 1;
        throw new Error('fetch should not run');
      }, [{ address: '93.184.216.34', family: 4 }]),
    });

    await expect(() =>
      provider.analyze({
        profile: createProfile('https://api.example.com/v1'),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'x'.repeat(12_001),
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/12000-byte limit/i);
    expect(fetchCalls).toBe(0);
  });

  it('rejects redirects, invalid JSON payloads, and malformed structured responses with redacted excerpts', async () => {
    const redirect = await startServer((_request, response) => {
      response.writeHead(302, { location: 'http://example.com/elsewhere' });
      response.end();
    });
    const invalidJson = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{not-json');
    });
    const invalidStructure = await startServer((_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `bad sk-live-provider-key ${'y'.repeat(1_000)}` }));
    });
    const redirectProvider = loopbackProvider(redirect.endpoint);
    const invalidJsonProvider = loopbackProvider(invalidJson.endpoint);
    const invalidStructureProvider = loopbackProvider(invalidStructure.endpoint);

    await expect(() =>
      redirectProvider.analyze({
        profile: createProfile(redirect.endpoint),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [],
      }),
    ).rejects.toThrow(/redirect/i);

    await expect(() =>
      invalidJsonProvider.analyze({
        profile: createProfile(invalidJson.endpoint),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [],
      }),
    ).rejects.toThrow(/json/i);

    await expect(() =>
      invalidStructureProvider.analyze({
        profile: createProfile(invalidStructure.endpoint),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [],
      }),
    ).rejects.toThrow(/\*\*\*/i);
  });

  it('rejects ungrounded source identifiers and exact-span mismatches', async () => {
    const { endpoint } = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(analysisPayload('source-2')),
              },
            },
          ],
        }),
      );
    });
    const provider = loopbackProvider(endpoint);

    await expect(() =>
      provider.analyze({
        profile: createProfile(endpoint),
        environment: {},
        prompt: 'Return grounded analysis JSON.',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/grounded|source/i);
  });

  it('aborts synchronously before any fetch or server request when the parent signal is already aborted', async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error('stop-now'));
    const provider = new OpenAICompatibleProvider({
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      hostPolicy: { allowedOrigins: new Set(['https://api.example.com']) },
      transport: staticTransport(
        async () => {
          fetchCalls += 1;
          throw new Error('fetch should not run');
        },
        [{ address: '93.184.216.34', family: 4 }],
      ),
    });

    await expect(() =>
      provider.analyze({
        profile: createProfile('https://api.example.com/v1'),
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
        signal: controller.signal,
      }),
    ).rejects.toThrow('stop-now');
    expect(fetchCalls).toBe(0);
  });

  it('requires host approval for credential-bearing public origins and rejects resolved private or mapped-loopback addresses', async () => {
    let fetchCalls = 0;
    const publicResponse = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(analysisPayload('source-1')),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const profile = createProfile('https://api.example.com/v1');

    const deniedProvider = new OpenAICompatibleProvider({
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      transport: staticTransport(async (...args) => {
        fetchCalls += 1;
        return publicResponse(...args);
      }, [{ address: '93.184.216.34', family: 4 }]),
    });
    await expect(() =>
      deniedProvider.analyze({
        profile,
        environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/host policy/i);
    expect(fetchCalls).toBe(0);

    await expect(() =>
      new OpenAICompatibleProvider({
        transport: staticTransport(async () => publicResponse(), [{ address: '93.184.216.34', family: 4 }]),
      }).analyze({
        profile: createProfile('https://anonymous.example/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/host policy/i);

    const approvedProvider = new OpenAICompatibleProvider({
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      hostPolicy: { allowedOrigins: new Set(['https://api.example.com']) },
      transport: staticTransport(async (...args) => {
        fetchCalls += 1;
        return publicResponse(...args);
      }, [{ address: '93.184.216.34', family: 4 }]),
    });
    const approved = await approvedProvider.analyze({
      profile,
      environment: { [DEFAULT_API_KEY_ENV]: 'sk-live-provider-key' },
      prompt: 'prompt',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [groundedSpan()],
    });
    expect(approved.value.summary).toBe('Grounded summary');

    const mappedLoopbackProvider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['https://public.example']) },
      transport: staticTransport(async () => publicResponse(), [{ address: '::ffff:127.0.0.1', family: 6 }]),
    });
    await expect(() =>
      mappedLoopbackProvider.analyze({
        profile: createProfile('https://public.example/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/private|reserved/i);

    const embeddedLoopbackProvider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['https://metadata.example']) },
      transport: staticTransport(async () => publicResponse(), [{ address: '::a9fe:a9fe', family: 6 }]),
    });
    await expect(() =>
      embeddedLoopbackProvider.analyze({
        profile: createProfile('https://metadata.example/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/private|reserved/i);

    const nat64MetadataProvider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['https://nat64.example']) },
      transport: staticTransport(async () => publicResponse(), [{ address: '64:ff9b::a9fe:a9fe', family: 6 }]),
    });
    await expect(() =>
      nat64MetadataProvider.analyze({
        profile: createProfile('https://nat64.example/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/private|reserved/i);

    const nat64LocalPrefixProvider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['https://nat64-local.example']) },
      transport: staticTransport(async () => publicResponse(), [{ address: '64:ff9b:1::a9fe:a9fe', family: 6 }]),
    });
    await expect(() =>
      nat64LocalPrefixProvider.analyze({
        profile: createProfile('https://nat64-local.example/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/private|reserved/i);
  });

  it('supports explicit allowlisted IPv6 loopback literals', async () => {
    const provider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['http://[::1]:11434']) },
      transport: staticTransport(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify(analysisPayload('source-1')),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        [{ address: '::1', family: 6 }],
      ),
    });

    const result = await provider.analyze({
      profile: createProfile('http://[::1]:11434/v1', { apiKeyEnv: null }),
      environment: {},
      prompt: 'prompt',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [groundedSpan()],
    });

    expect(result.value.summary).toBe('Grounded summary');
  });

  it('enforces response byte limits while streaming and cancels oversized bodies even when Content-Length lies', async () => {
    let cancelled = false;
    const oversizedMessage = JSON.stringify({
      choices: [
        {
          message: {
            content: '🙂'.repeat(40_000),
          },
        },
      ],
    });
    const provider = new OpenAICompatibleProvider({
      hostPolicy: { allowedOrigins: new Set(['https://api.example.com']) },
      transport: staticTransport(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encoder = new TextEncoder();
                const encoded = encoder.encode(oversizedMessage);
                for (let offset = 0; offset < encoded.length; offset += 4_096) {
                  controller.enqueue(encoded.slice(offset, offset + 4_096));
                }
                controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'content-length': '10',
              },
            },
          ),
        [{ address: '93.184.216.34', family: 4 }],
      ),
    });

    await expect(() =>
      provider.analyze({
        profile: createProfile('https://api.example.com/v1', { apiKeyEnv: null }),
        environment: {},
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [groundedSpan()],
      }),
    ).rejects.toThrow(/80_000-byte limit|80,000-byte limit|80/);
    expect(cancelled).toBe(true);
  });

  it('builds bounded structured prompts with truncation metadata, validates generation contracts, and returns warning-only missing-api-key diagnostics', async () => {
    const db = database();
    const project = new KnowledgeProjectStore(db).create({
      id: 'project-openai' as never,
      workspaceRoot: '/workspace/openai',
      name: 'OpenAI',
      roots: ['docs'],
      createdAt: CREATED_AT,
    });
    const pageVersion = new KnowledgePageStore(db).createPageVersion({
      projectId: project.id,
      pageId: createKnowledgeId('page', 'source-page') as never,
      type: 'source',
      title: 'src/example.py',
      slug: 'source-src-example-py',
      content: `# Deterministic page\n\n${'content '.repeat(2_000)}`,
      createdAt: CREATED_AT,
    });

    const { endpoint, requests } = await startServer((_request, response) => {
      const requestIndex = requests.length;
      const latestRequest = requests[requestIndex - 1];
      const userPrompt = JSON.parse(
        JSON.parse(latestRequest?.body ?? '{}').messages.find((message: { role: string }) => message.role === 'user')?.content ?? '{}',
      );
      const firstAllowedSpan = userPrompt.allowedSourceSpans?.[0] ?? groundedSpan('source-1');
      const groundedSourceId = firstAllowedSpan.sourceId ?? 'source-1';
      const groundedAnalysis = analysisPayload(groundedSourceId);
      for (const collection of [
        groundedAnalysis.entities,
        groundedAnalysis.claims,
        groundedAnalysis.relationships,
        groundedAnalysis.contradictions,
        groundedAnalysis.researchGaps,
      ]) {
        collection.forEach((entry: { sourceSpans?: unknown[] }) => {
          if (entry.sourceSpans) {
            entry.sourceSpans = [firstAllowedSpan];
          }
        });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  requestIndex === 2
                    ? {
                        ...generationPayload(groundedSourceId),
                        analysis: groundedAnalysis,
                      }
                    : groundedAnalysis,
                ),
              },
            },
          ],
        }),
      );
    });
    const profileStore = new KnowledgeProviderProfileStore(db, { now: () => CREATED_AT });
    profileStore.setEnabled(
      project.id,
      profileStore.create({
        projectId: project.id,
        profileName: 'analysis',
        endpoint,
        model: 'gpt-4.1-mini',
        capabilities: ['analysis', 'generation'],
        timeoutMs: 10_000,
        apiKeyEnv: DEFAULT_API_KEY_ENV,
        enabled: false,
      }).profileName,
      true,
    );
    const service = new OpenAICompatibleEnrichmentService(db, {
      profileStore,
      environment: {},
      credentialPolicy: { allowedEnvironmentVariables: new Set([DEFAULT_API_KEY_ENV]) },
      hostPolicy: { allowedOrigins: new Set([new URL(endpoint).origin]) },
    });

    const result = await service.enrich({
      projectId: project.id,
      jobId: 'job-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourcePath: 'src/example.py',
      extraction: createExtraction({ sectionCount: 6, sectionLength: 260 }),
      pageVersionIds: [pageVersion.id],
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provider_missing_api_key' }),
      ]),
    );
    expect(result.reviews).toEqual([
      expect.objectContaining({
        pageVersionId: pageVersion.id,
        summary: expect.stringContaining('The summary may overstate'),
      }),
    ]);
    expect(result.insights).toEqual([
      expect.objectContaining({
        type: 'research_gap',
        contentPath: 'src/example.py',
      }),
    ]);
    expect(requests).toHaveLength(2);
    const userMessages = requests
      .map((request) => JSON.parse(request.body).messages.find((message: { role: string }) => message.role === 'user'))
      .filter(Boolean) as Array<{ content: string }>;
    const analysisPrompt = JSON.parse(userMessages[0]?.content ?? '{}');
    const generationPrompt = JSON.parse(userMessages[1]?.content ?? '{}');
    expect(analysisPrompt.truncation).toMatchObject({
      sectionsOmitted: 0,
      sectionTextsTruncated: 6,
      symbolsOmitted: 0,
    });
    expect(generationPrompt.truncation).toMatchObject({ pagesOmitted: 0 });
    expect((userMessages[0]?.content.length ?? 0) > 0).toBe(true);
    expect((userMessages[1]?.content.length ?? 0) > 0).toBe(true);
  });

  it('skips enrichment with a warning instead of silently dropping grounding when the exact-span prompt is too large', async () => {
    const db = database();
    const project = new KnowledgeProjectStore(db).create({
      id: 'project-openai' as never,
      workspaceRoot: '/workspace/openai',
      name: 'OpenAI',
      roots: ['docs'],
      createdAt: CREATED_AT,
    });
    const { endpoint, requests } = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [] }));
    });
    const profileStore = new KnowledgeProviderProfileStore(db, { now: () => CREATED_AT });
    profileStore.setEnabled(
      project.id,
      profileStore.create({
        projectId: project.id,
        profileName: 'analysis',
        endpoint,
        model: 'gpt-4.1-mini',
        capabilities: ['analysis'],
        timeoutMs: 10_000,
        apiKeyEnv: null,
        enabled: false,
      }).profileName,
      true,
    );
    const service = new OpenAICompatibleEnrichmentService(db, {
      profileStore,
      environment: {},
      hostPolicy: { allowedOrigins: new Set([new URL(endpoint).origin]) },
    });

    const result = await service.enrich({
      projectId: project.id,
      jobId: 'job-2',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourcePath: 'src/example.py',
      extraction: createExtraction({ sectionCount: 260, sectionLength: 24 }),
      pageVersionIds: [],
    });

    expect(result.reviews).toEqual([]);
    expect(result.insights).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'provider_invalid_response',
          message: expect.stringMatching(/source span count|byte limit/i),
        }),
      ]),
    );
    expect(requests).toHaveLength(0);
  });
});
