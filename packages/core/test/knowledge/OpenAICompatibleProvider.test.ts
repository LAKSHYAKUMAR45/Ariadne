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
} from '../../src/knowledge/providers/OpenAICompatibleProvider.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';

const CREATED_AT = '2026-09-28T00:00:00.000Z';

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
    apiKeyEnv: overrides.apiKeyEnv ?? 'ARIADNE_PROVIDER_API_KEY',
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
        sourceSpans: [
          {
            sourceId,
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
        confidence: 0.9,
      },
    ],
    claims: [
      {
        id: 'claim-1',
        statement: 'The module defines Greeter.',
        sourceIds: [sourceId],
        sourceSpans: [
          {
            sourceId,
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
        confidence: 0.9,
      },
    ],
    relationships: [
      {
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-1',
        type: 'references',
        sourceIds: [sourceId],
        sourceSpans: [
          {
            sourceId,
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
        confidence: 0.8,
      },
    ],
    contradictions: [
      {
        summary: 'The summary may overstate the current implementation.',
        claimIds: ['claim-1'],
        sourceIds: [sourceId],
        sourceSpans: [
          {
            sourceId,
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
        confidence: 0.4,
      },
    ],
    researchGaps: [
      {
        question: 'Should this module expose additional examples?',
        sourceIds: [sourceId],
        sourceSpans: [
          {
            sourceId,
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
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

function createExtraction(): DeterministicExtraction {
  return {
    analyzerId: 'stub-analyzer',
    analyzerVersion: '1.0.0',
    sourceVersionId: 'source-version-1',
    title: 'src/example.py',
    summary: 'Deterministic summary',
    sections: [
      {
        id: 'section-1',
        kind: 'body',
        title: 'Body',
        text: 'class Greeter:\n    pass\n',
        confidence: 1,
        span: {
          startOffset: 0,
          endOffset: 12,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 13,
          label: 'section',
        },
      },
    ],
    symbols: [
      {
        id: 'symbol-1',
        kind: 'class',
        name: 'Greeter',
        qualifiedName: 'Greeter',
        confidence: 1,
        span: {
          startOffset: 0,
          endOffset: 12,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 13,
          label: 'symbol',
        },
      },
    ],
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
    const provider = new OpenAICompatibleProvider();
    const profile = createProfile(endpoint);

    await provider.analyze({
      profile,
      environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
      prompt: 'Return grounded analysis JSON.',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [
        {
          sourceId: 'source-1',
          sourceVersionId: 'source-version-1',
          startOffset: 0,
          endOffset: 12,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 13,
          label: 'section',
        },
      ],
    });
    await provider.analyze({
      profile,
      environment: {},
      prompt: 'Return grounded analysis JSON.',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourceSpans: [
        {
          sourceId: 'source-1',
          sourceVersionId: 'source-version-1',
          startOffset: 0,
          endOffset: 12,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 13,
          label: 'section',
        },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.path).toBe('/v1/chat/completions');
    expect(requests[0]?.headers.authorization).toBe('Bearer sk-live-provider-key');
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
    const provider = new OpenAICompatibleProvider();
    const profile = createProfile(endpoint, { timeoutMs: 50 });

    await expect(() =>
      provider.analyze({
        profile,
        environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
        prompt: `Prompt ${'x'.repeat(2_000)}`,
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [
          {
            sourceId: 'source-1',
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
      }),
    ).rejects.toThrow(/timed out/i);
    await expect(() =>
      provider.analyze({
        profile,
        environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
        prompt: `Prompt ${'x'.repeat(2_000)}`,
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [
          {
            sourceId: 'source-1',
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
      }),
    ).rejects.not.toThrow(/sk-live-provider-key/);
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
    const provider = new OpenAICompatibleProvider();

    await expect(() =>
      provider.analyze({
        profile: createProfile(redirect.endpoint),
        environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [],
      }),
    ).rejects.toThrow(/redirect/i);

    await expect(() =>
      provider.analyze({
        profile: createProfile(invalidJson.endpoint),
        environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
        prompt: 'prompt',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [],
      }),
    ).rejects.toThrow(/json/i);

    await expect(() =>
      provider.analyze({
        profile: createProfile(invalidStructure.endpoint),
        environment: { ARIADNE_PROVIDER_API_KEY: 'sk-live-provider-key' },
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
    const provider = new OpenAICompatibleProvider();

    await expect(() =>
      provider.analyze({
        profile: createProfile(endpoint),
        environment: {},
        prompt: 'Return grounded analysis JSON.',
        sourceId: 'source-1',
        sourceVersionId: 'source-version-1',
        sourceSpans: [
          {
            sourceId: 'source-1',
            sourceVersionId: 'source-version-1',
            startOffset: 0,
            endOffset: 12,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 13,
            label: 'section',
          },
        ],
      }),
    ).rejects.toThrow(/grounded|source/i);
  });

  it('builds bounded deterministic prompts, validates generation contracts, and returns warning-only missing-api-key diagnostics', async () => {
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
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  requestIndex === 2
                    ? generationPayload('source-1')
                    : analysisPayload('source-1'),
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
        apiKeyEnv: 'ARIADNE_PROVIDER_API_KEY',
        enabled: false,
      }).profileName,
      true,
    );
    const service = new OpenAICompatibleEnrichmentService(db, {
      profileStore,
      provider: new OpenAICompatibleProvider(),
      environment: {},
    });

    const result = await service.enrich({
      projectId: project.id,
      jobId: 'job-1',
      sourceId: 'source-1',
      sourceVersionId: 'source-version-1',
      sourcePath: 'src/example.py',
      extraction: createExtraction(),
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
    expect(userMessages[0]?.content.length ?? 0).toBeLessThanOrEqual(6_500);
    expect(userMessages[1]?.content.length ?? 0).toBeLessThanOrEqual(6_500);
  });
});
