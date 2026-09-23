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

function errorDetails(value: unknown): { code: string; message: string } {
  if (!value || typeof value !== 'object') {
    return { code: 'request_failed', message: 'The server returned an unexpected response.' };
  }
  const payload = value as ErrorPayload;
  const nested = payload.error;
  const code =
    typeof nested?.code === 'string'
      ? nested.code
      : typeof payload.code === 'string'
        ? payload.code
        : 'request_failed';
  const message =
    typeof nested?.message === 'string'
      ? nested.message
      : typeof payload.message === 'string'
        ? payload.message
        : 'The request could not be completed.';
  return { code, message };
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = errorDetails(body);
    throw new AdminApiError(response.status, details.code, details.message);
  }
  return body as T;
}

export async function postJson<T>(
  path: string,
  csrfToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify(body ?? {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = errorDetails(payload);
    throw new AdminApiError(response.status, details.code, details.message);
  }
  return payload as T;
}
