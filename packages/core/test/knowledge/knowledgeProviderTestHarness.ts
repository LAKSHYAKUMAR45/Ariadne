import http from 'node:http';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeHostSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeProviderProfileStore } from '../../src/knowledge/KnowledgeProviderProfiles.js';
import { KnowledgeGenerationGateway } from '../../src/knowledge/KnowledgeGenerationGateway.js';
import { OpenAICompatibleProvider } from '../../src/knowledge/providers/OpenAICompatibleProvider.js';

export const HARNESS_API_KEY_ENV = 'ARIADNE_KNOWLEDGE_PROVIDER_HARNESS_KEY';
export const HARNESS_API_KEY = 'sk-harness-secret-value-123456';
export const HARNESS_PROJECT_ID = 'project_1';

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type FixtureHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>;

/** In-process loopback HTTP fixture; nothing here reaches a real provider or the network. */
export class ProviderFixture {
  private readonly servers = new Set<http.Server>();
  public readonly requests: RecordedRequest[] = [];

  public async start(handler: FixtureHandler): Promise<string> {
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.requests.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      await handler(request, response);
    });
    this.servers.add(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected loopback server address');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  public async stop(): Promise<void> {
    await Promise.all(
      [...this.servers].map((server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })),
    );
    this.servers.clear();
  }
}

export function completionResponse(content: unknown): FixtureHandler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }));
  };
}

export interface ProviderHarness {
  db: Database.Database;
  profileStore: KnowledgeProviderProfileStore;
  hostSettings: KnowledgeHostSettingsStore;
  gateway: KnowledgeGenerationGateway;
  environment: NodeJS.ProcessEnv;
  createProfile(input: {
    name: string;
    endpoint: string;
    capabilities?: Array<'generation' | 'analysis'>;
    enabled?: boolean;
    timeoutMs?: number;
    apiKeyEnv?: string | null;
  }): void;
}

export function createProviderHarness(
  db: Database.Database,
  options: { allowedOrigins?: (endpoint: string) => Set<string>; environment?: NodeJS.ProcessEnv } = {},
): ProviderHarness {
  const profileStore = new KnowledgeProviderProfileStore(db);
  const hostSettings = new KnowledgeHostSettingsStore(db);
  const environment = options.environment ?? { [HARNESS_API_KEY_ENV]: HARNESS_API_KEY };
  const credentialPolicy = { allowedEnvironmentVariables: new Set([HARNESS_API_KEY_ENV]) };
  const origins = new Set<string>();
  const provider = new OpenAICompatibleProvider({
    credentialPolicy,
    hostPolicy: { isOriginAllowed: ({ origin }) => origins.has(origin) },
  });
  const gateway = new KnowledgeGenerationGateway({ profileStore, hostSettings, client: provider, environment, credentialPolicy });
  return {
    db,
    profileStore,
    hostSettings,
    gateway,
    environment,
    createProfile(input) {
      if (options.allowedOrigins) for (const origin of options.allowedOrigins(input.endpoint)) origins.add(origin);
      else origins.add(new URL(input.endpoint).origin);
      profileStore.create({
        projectId: HARNESS_PROJECT_ID,
        profileName: input.name,
        endpoint: input.endpoint,
        model: 'harness-model',
        capabilities: input.capabilities ?? ['generation'],
        timeoutMs: input.timeoutMs ?? 2_000,
        apiKeyEnv: input.apiKeyEnv === undefined ? HARNESS_API_KEY_ENV : input.apiKeyEnv,
        enabled: input.enabled ?? true,
      });
    },
  };
}

export function openHarnessDatabase(workspaceRoot: string): Database.Database {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
     VALUES (?, ?, 'Wiki', 'active', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
  ).run(HARNESS_PROJECT_ID, workspaceRoot);
  return db;
}
