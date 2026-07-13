/**
 * Test-only Postgres connection helpers. Tests require a real Postgres
 * instance reachable via TEST_DATABASE_URL (defaults to the docker-based
 * instance documented in packages/sync-server/README.md), since this
 * package's whole job is talking to Postgres — an in-memory fake would
 * defeat the point of testing it.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:ariadne@localhost:55432/ariadne_sync_test';

export const TEST_JWT_SECRET = 'test-secret-do-not-use-in-production';
