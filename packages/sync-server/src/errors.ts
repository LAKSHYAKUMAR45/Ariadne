/** Stable machine-readable error shape, per docs/07-CLOUD-SYNC-API-CONTRACT.md §5. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export function errorBody(err: ApiError) {
  return { error: { code: err.code, message: err.message } };
}

const INTERNAL_ERROR = new ApiError(500, 'internal_error', 'An unexpected error occurred');

export function internalErrorBody() {
  return errorBody(INTERNAL_ERROR);
}

/**
 * body-parser's over-limit signal, raised by any `express.json({ limit })`.
 * Routes with their own larger, route-scoped limits translate it into their own
 * code; `handleUnexpectedError` gives everything else a stable 413.
 */
export function isPayloadTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  );
}
