import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, open, rm } from 'node:fs/promises';
import { parseOperatorRequest, type OperatorAccepted, type OperatorRequest } from './protocol.js';
import {
  OperationAdmissionRegistry,
  createSerialQueue,
  DEFAULT_TERMINAL_CACHE_MAX_ENTRIES,
  DEFAULT_TERMINAL_CACHE_TTL_MS,
} from './admission.js';
import {
  createOperatorExecutor,
  type OperatorEventSink,
  type OperatorExecutor,
  type OperatorProgressEvent,
  type OperatorResultEvent,
} from './executor.js';

export const MAX_OPERATOR_REQUEST_BODY_BYTES = 8 * 1024;
export { DEFAULT_TERMINAL_CACHE_TTL_MS, DEFAULT_TERMINAL_CACHE_MAX_ENTRIES };
export const DEFAULT_HEADERS_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 1000;
export const SOCKET_CREATION_UMASK = 0o177;

/**
 * Result reporting channel.
 *
 * Linux peer credentials (`SO_PEERCRED`) are not exposed by Node's net module,
 * so the operator authenticates itself to the web tier with a root-created
 * 32-byte token that only root and the `ariadne-web` group can read. The token
 * lives on the `/run` tmpfs, is never written anywhere else, and is never
 * logged or included in a callback body.
 */
export const DEFAULT_CALLBACK_TOKEN_PATH = '/run/ariadne/operator-callback-token';
export const CALLBACK_TOKEN_HEADER = 'x-ariadne-operator-token';
export const CALLBACK_TOKEN_BYTES = 32;
export const CALLBACK_TOKEN_MODE = 0o640;
export const DEFAULT_CALLBACK_TIMEOUT_MS = 10 * 1000;

const CALLBACK_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const OPERATOR_ROUTE_PATH = '/v1/operations';

interface JsonErrorResponse {
  error: string;
}

export type OperatorExecuteFn = (
  request: OperatorRequest,
  reporter: OperatorEventSink,
) => Promise<void>;

export interface CreateOperatorServerOptions {
  socketPath: string;
  executeOperation?: OperatorExecuteFn;
  reporter?: OperatorEventSink;
  requestBodyLimitBytes?: number;
  terminalCacheTtlMs?: number;
  terminalCacheMaxEntries?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface OperatorServer {
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

class OperatorServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorServerConfigError';
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: OperatorAccepted | JsonErrorResponse,
): void {
  if (response.writableEnded || response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

/**
 * Terminates the inbound request immediately instead of draining an oversized
 * or slow body, while still flushing the JSON error response.
 */
function rejectRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: JsonErrorResponse,
): void {
  request.pause();
  request.removeAllListeners('data');

  if (response.writableEnded || response.headersSent) {
    request.destroy();
    return;
  }

  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('connection', 'close');
  response.end(JSON.stringify(payload), () => {
    request.destroy();
  });
}

async function safeRemoveOwnedSocket(socketPath: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (typeof currentUid !== 'number') {
    throw new OperatorServerConfigError('Current process UID is unavailable');
  }

  try {
    const existingPath = await lstat(socketPath);
    if (!existingPath.isSocket()) {
      throw new OperatorServerConfigError(
        `Refusing to replace existing non-socket path: ${socketPath}`,
      );
    }
    if (existingPath.uid !== currentUid) {
      throw new OperatorServerConfigError(
        `Refusing to replace socket not owned by current uid: ${socketPath}`,
      );
    }

    await rm(socketPath, { force: true });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Runs `operation` with a restrictive umask so files/sockets are never created
 * with a permissive mode, restoring the previous umask in all outcomes.
 */
export async function withRestrictiveUmask<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof process.umask !== 'function') {
    return await operation();
  }

  const previousUmask = process.umask(SOCKET_CREATION_UMASK);
  try {
    return await operation();
  } finally {
    process.umask(previousUmask);
  }
}

type BodyOutcome = { kind: 'body'; value: string } | { kind: 'rejected' };

function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<BodyOutcome> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      rejectRequestBody(request, response, 413, { error: 'request_too_large' });
      resolve({ kind: 'rejected' });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settle = (outcome: BodyOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejectRequestBody(request, response, 413, { error: 'request_too_large' });
        settle({ kind: 'rejected' });
        return;
      }
      chunks.push(buffer);
    });
    request.on('aborted', () => {
      settle({ kind: 'rejected' });
    });
    request.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    request.on('end', () => {
      settle({ kind: 'body', value: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

export interface CallbackConfig {
  callbackUrl: string;
  tokenPath: string;
}

/**
 * Reads the callback destination from the environment. Returns `null` when no
 * destination is configured (the operator then runs without result reporting
 * rather than failing to start), and refuses any non-loopback destination: the
 * service unit denies non-local egress, and a remote callback would put the
 * shared credential on the wire.
 */
export function getCallbackConfig(env: NodeJS.ProcessEnv = process.env): CallbackConfig | null {
  const callbackUrl = env.OPERATOR_CALLBACK_URL;
  if (!callbackUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new OperatorServerConfigError('OPERATOR_CALLBACK_URL must be an absolute http URL');
  }

  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    throw new OperatorServerConfigError(
      'OPERATOR_CALLBACK_URL must address the loopback interface over http',
    );
  }

  const tokenPath = env.OPERATOR_CALLBACK_TOKEN_PATH ?? DEFAULT_CALLBACK_TOKEN_PATH;
  if (!path.isAbsolute(tokenPath)) {
    throw new OperatorServerConfigError('OPERATOR_CALLBACK_TOKEN_PATH must be an absolute path');
  }

  return { callbackUrl: callbackUrl.replace(/\/+$/, ''), tokenPath };
}

function assertCallbackTokenMode(mode: number, tokenPath: string): void {
  // Owner read/write plus at most group read; anything broader would let a
  // second account impersonate the operator.
  const permissions = mode & 0o7777;
  if ((permissions & ~0o640) !== 0 || (permissions & 0o600) !== 0o600) {
    throw new OperatorServerConfigError(
      `Operator callback token has an unsafe mode (expected 0640): ${tokenPath}`,
    );
  }
}

/**
 * Returns the shared callback token, creating it with a restrictive mode when
 * it does not exist yet (the `/run` tmpfs is cleared on reboot). Token bytes
 * never appear in a thrown message.
 */
export async function ensureCallbackToken(tokenPath: string): Promise<string> {
  const existing = await readCallbackToken(tokenPath);
  if (existing !== null) {
    return existing;
  }

  const token = randomBytes(CALLBACK_TOKEN_BYTES).toString('hex');
  const handle = await withRestrictiveUmask(async () =>
    open(tokenPath, 'wx', CALLBACK_TOKEN_MODE),
  ).catch(async (error: unknown) => {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return null;
    }
    throw error;
  });

  if (handle === null) {
    // Another start raced us to the same tmpfs path; its token is authoritative.
    const raced = await readCallbackToken(tokenPath);
    if (raced === null) {
      throw new OperatorServerConfigError(
        `Operator callback token could not be created: ${tokenPath}`,
      );
    }
    return raced;
  }

  try {
    await handle.writeFile(token, 'utf8');
    await handle.chmod(CALLBACK_TOKEN_MODE);
  } finally {
    await handle.close();
  }

  return token;
}

async function readCallbackToken(tokenPath: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(tokenPath, 'r');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new OperatorServerConfigError(
        `Operator callback token is not a regular file: ${tokenPath}`,
      );
    }
    assertCallbackTokenMode(stats.mode, tokenPath);

    const raw = (await handle.readFile('utf8')).trim();
    if (!CALLBACK_TOKEN_PATTERN.test(raw)) {
      throw new OperatorServerConfigError(
        `Operator callback token must be 32 bytes of lowercase hex: ${tokenPath}`,
      );
    }
    return raw;
  } finally {
    await handle.close();
  }
}

export interface CreateCallbackReporterOptions {
  callbackUrl: string;
  token: string;
  requestTimeoutMs?: number;
  onError?(error: Error): void;
}

type CallbackState = 'running' | 'succeeded' | 'failed';

interface CallbackPayload {
  operationId: string;
  state: CallbackState;
  message: string;
  output?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Event sink that reports operation progress and results to the web tier.
 *
 * Only state changes the operations store accepts are sent: one `running`
 * report per operation, then exactly one terminal report. Delivery failures are
 * surfaced through `onError` (never thrown into the executor) so a callback
 * outage can never turn a completed privileged action into an unhandled
 * rejection.
 */
export function createCallbackReporter(
  options: CreateCallbackReporterOptions,
): OperatorEventSink {
  const callbackUrl = options.callbackUrl.replace(/\/+$/, '');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  const started = new Set<string>();

  async function post(payload: CallbackPayload): Promise<void> {
    const target = new URL(`${callbackUrl}/${encodeURIComponent(payload.operationId)}/callback`);
    const body = JSON.stringify(payload);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const request = http.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body, 'utf8'),
            [CALLBACK_TOKEN_HEADER]: options.token,
            connection: 'close',
          },
        },
        (response) => {
          response.resume();
          const statusCode = response.statusCode ?? 0;
          response.on('end', () => {
            if (statusCode >= 200 && statusCode < 300) {
              settle();
              return;
            }
            settle(new Error(`Operator callback was rejected with status ${statusCode}`));
          });
        },
      );

      const timer = setTimeout(() => {
        request.destroy();
        settle(new Error('Operator callback timed out'));
      }, requestTimeoutMs);

      request.on('error', (error: NodeJS.ErrnoException) => {
        settle(new Error(`Operator callback could not be delivered (${error.code ?? 'unknown'})`));
      });

      request.end(body);
    });
  }

  async function deliver(payload: CallbackPayload): Promise<void> {
    try {
      await post(payload);
    } catch (error: unknown) {
      const reported =
        error instanceof Error ? error : new Error('Operator callback failed unexpectedly');
      options.onError?.(reported);
      throw reported;
    }
  }

  async function markStarted(operationId: string): Promise<void> {
    if (started.has(operationId)) {
      return;
    }
    started.add(operationId);
    try {
      await deliver({ operationId, state: 'running', message: 'Operation started' });
    } catch (error: unknown) {
      // A failed start report must not suppress the terminal report.
      started.delete(operationId);
      throw error;
    }
  }

  return {
    async onProgress(event: OperatorProgressEvent): Promise<void> {
      try {
        await markStarted(event.operationId);
      } catch {
        // Already surfaced through onError.
      }
    },
    async onResult(event: OperatorResultEvent): Promise<void> {
      try {
        await markStarted(event.operationId);
      } catch {
        // Already surfaced through onError; the terminal report still follows.
      }

      started.delete(event.operationId);
      try {
        await deliver({
          operationId: event.operationId,
          state: event.success ? 'succeeded' : 'failed',
          message: event.success ? 'Operation succeeded' : 'Operation failed',
          output: event.output,
          metadata: {
            exitCode: event.exitCode,
            signal: event.signal,
            truncated: event.truncated,
          },
        });
      } catch {
        // Already surfaced through onError.
      }
    },
  };
}

export function getOperatorSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const socketPath = env.OPERATOR_SOCKET_PATH;
  if (!socketPath) {
    throw new OperatorServerConfigError('OPERATOR_SOCKET_PATH environment variable is required');
  }
  if (!path.isAbsolute(socketPath)) {
    throw new OperatorServerConfigError('OPERATOR_SOCKET_PATH must be an absolute path');
  }
  return socketPath;
}

export function createOperatorServer(options: CreateOperatorServerOptions): OperatorServer {
  const requestBodyLimitBytes = options.requestBodyLimitBytes ?? MAX_OPERATOR_REQUEST_BODY_BYTES;
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reporter: OperatorEventSink = options.reporter ?? {};
  const defaultExecutor: OperatorExecutor = createOperatorExecutor({ reporter: options.reporter });
  const executeOperation: OperatorExecuteFn =
    options.executeOperation ??
    ((request, eventSink) => defaultExecutor.execute(request, eventSink));

  const admissions = new OperationAdmissionRegistry({
    ttlMs: options.terminalCacheTtlMs,
    maxEntries: options.terminalCacheMaxEntries,
  });
  const admitExclusively = createSerialQueue();

  const connectionsCheckingIntervalMs = Math.max(
    250,
    Math.floor(Math.min(headersTimeoutMs, requestTimeoutMs) / 2),
  );

  const server = http.createServer(
    { connectionsCheckingInterval: connectionsCheckingIntervalMs },
    async (request, response) => {
    if ((request.url ?? '') !== OPERATOR_ROUTE_PATH) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    try {
      const bodyOutcome = await readJsonBody(request, response, requestBodyLimitBytes);
      if (bodyOutcome.kind === 'rejected') {
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyOutcome.value);
      } catch {
        writeJson(response, 400, { error: 'invalid_json' });
        return;
      }

      // Validation happens before any reservation so a rejected request never
      // claims (or burns) its operation id.
      const operatorRequest = parseOperatorRequest(parsedBody);

      // Reservation and dispatch run inside one serialized section, so two
      // requests that both finished body parsing cannot both see an idle
      // operator and execute.
      await admitExclusively(() => {
        const decision = admissions.reserve(operatorRequest.operationId);

        if (decision.kind === 'duplicate') {
          writeJson(response, 202, decision.accepted);
          return;
        }

        if (decision.kind === 'busy') {
          writeJson(response, 409, { error: 'operator_busy' });
          return;
        }

        writeJson(response, 202, decision.accepted);

        void runAcceptedOperation(operatorRequest, executeOperation, reporter, () => {
          admissions.settle(operatorRequest.operationId);
        });
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ZodError') {
        writeJson(response, 400, { error: 'invalid_request' });
        return;
      }
      writeJson(response, 500, { error: 'internal_error' });
    }
  },
  );

  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    const statusLine =
      error.code === 'HPE_HEADERS_TIMEOUT' || error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? 'HTTP/1.1 408 Request Timeout'
        : 'HTTP/1.1 400 Bad Request';

    if (!socket.writable) {
      socket.destroy();
      return;
    }

    socket.end(`${statusLine}\r\nConnection: close\r\n\r\n`, () => {
      socket.destroy();
    });
  });

  return {
    headersTimeoutMs,
    requestTimeoutMs,
    async start(): Promise<void> {
      await safeRemoveOwnedSocket(options.socketPath);

      await withRestrictiveUmask(async () => {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.socketPath, () => {
            server.off('error', reject);
            resolve();
          });
        });
      });

      await chmod(options.socketPath, 0o660);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await safeRemoveOwnedSocket(options.socketPath);
    },
  };
}

async function runAcceptedOperation(
  request: OperatorRequest,
  executeOperation: OperatorExecuteFn,
  reporter: OperatorEventSink,
  markTerminal: () => void,
): Promise<void> {
  try {
    await executeOperation(request, reporter);
  } catch {
    // Terminal failures are reported through the event sink; the operation id
    // still becomes terminal so retries with the same id are never re-executed.
  } finally {
    markTerminal();
  }
}
