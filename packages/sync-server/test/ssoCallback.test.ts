import type { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';

import { createTestEncryptionKeyring } from './testKeyring.js';

describe('GET /sso/callback', () => {
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
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
  });

  function buildApp() {
    return createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      adminPublicOrigin: null,
      ssoSharedSecret,
      adminCookieSecure: false,
    });
  }

  async function insertTestCode(options: {
    username: string;
    role: 'admin' | 'member';
    expiresInSeconds?: number;
    consumed?: boolean;
  }) {
    const code = randomBytes(32).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const expiresInSeconds = options.expiresInSeconds ?? 60;
    const consumed = options.consumed ?? false;

    await pool.query(
      `INSERT INTO sso_exchange_codes (code_hash, username, role, expires_at, consumed_at)
       VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'), $5)`,
      [codeHash, options.username, options.role, expiresInSeconds, consumed ? new Date() : null],
    );
    return code;
  }

  it('sets a session cookie and redirects to /admin for a valid unconsumed code', async () => {
    const code = await insertTestCode({ username: 'triage-admin', role: 'admin' });
    const app = buildApp();

    const response = await request(app).get(`/sso/callback?code=${code}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin');
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('redirects with an error for an unknown code', async () => {
    const app = buildApp();
    const response = await request(app).get('/sso/callback?code=not-a-real-code');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin?sso_error=1');
  });

  it('redirects with an error and does not create a session for an already-consumed code', async () => {
    const code = await insertTestCode({
      username: 'triage-admin',
      role: 'admin',
      consumed: true,
    });
    const app = buildApp();
    const response = await request(app).get(`/sso/callback?code=${code}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin?sso_error=1');
  });

  it('redirects with an error for an expired code', async () => {
    const code = await insertTestCode({
      username: 'triage-admin',
      role: 'admin',
      expiresInSeconds: -10,
    });
    const app = buildApp();
    const response = await request(app).get(`/sso/callback?code=${code}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/admin?sso_error=1');
  });

  it('a code cannot be exchanged twice', async () => {
    const code = await insertTestCode({ username: 'triage-admin', role: 'admin' });
    const app = buildApp();

    const first = await request(app).get(`/sso/callback?code=${code}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/admin');

    const second = await request(app).get(`/sso/callback?code=${code}`);
    expect(second.status).toBe(302);
    expect(second.headers.location).toBe('/admin?sso_error=1');
  });
});
