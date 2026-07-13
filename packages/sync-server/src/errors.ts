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
