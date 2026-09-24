import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

describe('internalSso routes', () => {
  let pool: Pool;
  const ssoSharedSecret = 'test-sso-shared-secret-12345678';

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, [...CORE_FIXTURE_TABLES, 'sso_exchange_codes']);
  });

  function buildApp() {
    return createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      adminPublicOrigin: null,
      ssoSharedSecret,
    });
  }

  it('rejects requests with no X-Ariadne-SSO-Secret header → 401', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .send({ username: 'alice', role: 'admin' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('invalid_secret');
  });

  it('rejects requests with the wrong secret → 401', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', 'wrong-secret')
      .send({ username: 'alice', role: 'admin' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('invalid_secret');
  });

  it('rejects an invalid role value (e.g. superadmin) → 400', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', ssoSharedSecret)
      .send({ username: 'alice', role: 'superadmin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('valid secret + valid body → 200, returns opaque code, hash stored in db', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', ssoSharedSecret)
      .send({ username: 'alice', role: 'admin' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeDefined();
    expect(res.body.code).toBeTypeOf('string');
    expect(res.body.code.length).toBeGreaterThan(20);

    // Verify Cache-Control header
    expect(res.headers['cache-control']).toBe('no-store');

    // Query the database directly to verify hash was stored, not the raw code
    const { rows } = await pool.query<{
      code_hash: string;
      username: string;
      role: string;
    }>(
      `SELECT code_hash, username, role FROM sso_exchange_codes
       WHERE username = $1 AND role = $2`,
      ['alice', 'admin'],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.username).toBe('alice');
    expect(rows[0]!.role).toBe('admin');
    expect(rows[0]!.code_hash).not.toBe(res.body.code);
  });

  it('stores code with 60-second expiry', async () => {
    const beforeRequest = new Date();
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', ssoSharedSecret)
      .send({ username: 'bob', role: 'member' });

    const afterRequest = new Date();

    expect(res.status).toBe(200);

    const { rows } = await pool.query<{
      expires_at: Date;
    }>(
      `SELECT expires_at FROM sso_exchange_codes
       WHERE username = $1`,
      ['bob'],
    );

    expect(rows).toHaveLength(1);
    const expiresAt = rows[0]!.expires_at;

    // Check that expiry is approximately 60 seconds from now
    const timeSinceRequest = expiresAt.getTime() - afterRequest.getTime();
    const timeBeforeRequest = expiresAt.getTime() - beforeRequest.getTime();

    // Should be roughly 60 seconds in the future (59-61 seconds, allowing for clock skew)
    expect(timeSinceRequest).toBeGreaterThan(59 * 1000);
    expect(timeBeforeRequest).toBeLessThan(61 * 1000);
  });

  it('rejects body with unknown fields → 400', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', ssoSharedSecret)
      .send({ username: 'alice', role: 'admin', extra: 'field' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('rejects username out of 1-64 char range → 400', async () => {
    const res = await request(buildApp())
      .post('/internal/sso/codes')
      .set('X-Ariadne-SSO-Secret', ssoSharedSecret)
      .send({ username: '', role: 'admin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('invalid_request');
  });
});
