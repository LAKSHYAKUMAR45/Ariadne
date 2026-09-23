import type { AdminApiClient, Guard } from './types';

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

interface ErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
  };
  code?: unknown;
  message?: unknown;
}

interface CreateAdminApiClientOptions {
  getCsrfToken: () => string | null;
  onUnauthorized?: () => void;
}

const INVALID_RESPONSE_MESSAGE = 'The server returned an invalid response.';

function errorDetails(value: unknown): { code: string; message: string } {
  if (!value || typeof value !== 'object') {
    return { code: 'request_failed', message: 'The request could not be completed.' };
  }

  const payload = value as ErrorPayload;
  const code =
    typeof payload.error?.code === 'string'
      ? payload.error.code
      : typeof payload.code === 'string'
        ? payload.code
        : 'request_failed';
  const message =
    typeof payload.error?.message === 'string'
      ? payload.error.message
      : typeof payload.message === 'string'
        ? payload.message
        : 'The request could not be completed.';

  return { code, message };
}

async function readJson(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (text.length === 0) {
    return null;
  }

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new AdminApiError(response.status, 'invalid_response', INVALID_RESPONSE_MESSAGE);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdminApiError(response.status, 'invalid_response', INVALID_RESPONSE_MESSAGE);
  }
}

function invalidResponseError(status: number): AdminApiError {
  return new AdminApiError(status, 'invalid_response', INVALID_RESPONSE_MESSAGE);
}

async function expectJson<T>(
  response: Response,
  guard: Guard<T>,
  onUnauthorized?: () => void,
): Promise<T> {
  const payload = await readJson(response);

  if (!response.ok) {
    const details = errorDetails(payload);
    if (response.status === 401) {
      onUnauthorized?.();
    }
    throw new AdminApiError(response.status, details.code, details.message);
  }

  if (!guard(payload)) {
    throw invalidResponseError(response.status);
  }

  return payload;
}

export function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createAdminApiClient(options: CreateAdminApiClientOptions): AdminApiClient {
  return {
    async get<T>(path: string, guard: Guard<T>, signal?: AbortSignal): Promise<T> {
      const response = await fetch(path, {
        credentials: 'same-origin',
        signal,
      });

      return expectJson(response, guard, options.onUnauthorized);
    },

    async mutate<T>(
      method: 'POST' | 'PATCH' | 'DELETE',
      path: string,
      body: Record<string, unknown>,
      guard: Guard<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const csrfToken = options.getCsrfToken();
      if (!csrfToken) {
        throw new AdminApiError(401, 'missing_session', 'Session expired. Sign in again.');
      }

      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(body),
      });

      return expectJson(response, guard, options.onUnauthorized);
    },

    async download(path: string, signal?: AbortSignal): Promise<Blob> {
      const response = await fetch(path, {
        credentials: 'same-origin',
        signal,
      });

      if (!response.ok) {
        const payload = await readJson(response).catch(() => null);
        const details = errorDetails(payload);
        if (response.status === 401) {
          options.onUnauthorized?.();
        }
        throw new AdminApiError(response.status, details.code, details.message);
      }

      return response.blob();
    },
  };
}
