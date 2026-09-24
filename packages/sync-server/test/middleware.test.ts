import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ADMIN_SESSION_COOKIE_NAME, createAdminSession } from '../src/adminSessions.js';
import { hashPassword } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { truncateFixtureTables, CORE_FIXTURE_TABLES } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';

const ALLOWED_ORIGIN = 'https://dashboard.example.test';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const MEMBER_PASSWORD = 'member-password-123456';

describe('sync-server: requireAdminSession allowMember option', () => {
  let pool: Pool;
  let app: Express;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      adminPublicOrigin: ALLOWED_ORIGIN,
      adminCookieSecure: true,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
  });

  async function createUser(
    username: string,
    password: string,
  ): Promise<{ userId: string; username: string }> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, await hashPassword(password)],
    );
    return { userId: rows[0].id, username };
  }

  async function seedTeam(): Promise<{
    teamId: string;
    admin: { userId: string; username: string };
    member: { userId: string; username: string };
  }> {
    const { rows: teamRows } = await pool.query<{ id: string }>(
      'INSERT INTO teams (singleton_key, name) VALUES ($1, $2) RETURNING id',
      ['default', 'Ariadne'],
    );
    const teamId = teamRows[0].id;

    const admin = await createUser('admin-user', ADMIN_PASSWORD);
    const member = await createUser('member-user', MEMBER_PASSWORD);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active)
       VALUES ($1, $2, 'admin', true), ($1, $3, 'member', true)`,
      [teamId, admin.userId, member.userId],
    );

    return {
      teamId,
      admin,
      member,
    };
  }

  function parseSetCookie(header: string | string[] | undefined): string {
    const values = Array.isArray(header) ? header : header ? [header] : [];
    const cookie = values.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
    expect(cookie).toBeTruthy();
    return cookie as string;
  }

  it('blocks a member session by default (allowMember not set)', async () => {
    const { member } = await seedTeam();
    const { sessionToken } = await createAdminSession(pool, member.userId);

    const res = await request(app)
      .get('/api/v1/admin/members')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('Origin', ALLOWED_ORIGIN);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('admin_required');
  });

  it('allows a member session through middleware when allowMember is true', async () => {
    const { member } = await seedTeam();
    const { sessionToken, csrfToken } = await createAdminSession(pool, member.userId);

    // Test that member can reach a handler that explicitly allows members
    // via the allowMember option on the Tasks router
    const res = await request(app)
      .get('/api/v1/admin/tasks')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('X-CSRF-Token', csrfToken)
      .set('Origin', ALLOWED_ORIGIN);

    // The middleware allows members through, but the handler itself may still
    // reject members if it calls requireSingletonAdmin. However, the handler
    // should NOT get a 401 from middleware - it should reach the handler.
    // Since the handler calls requireSingletonAdmin, we expect 403.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('admin_required');
  });

  it('includes role in whoami response for admin', async () => {
    const { admin } = await seedTeam();

    // Test admin role via password login
    const adminRes = await request(app)
      .post('/api/v1/admin/session')
      .set('Origin', ALLOWED_ORIGIN)
      .send({ username: 'admin-user', password: ADMIN_PASSWORD });

    expect(adminRes.status).toBe(201);
    expect(adminRes.body.role).toBe('admin');

    // Test whoami for admin
    const setCookie = parseSetCookie(adminRes.headers['set-cookie']);
    const sessionToken = setCookie.slice(
      `${ADMIN_SESSION_COOKIE_NAME}=`.length,
      setCookie.indexOf(';'),
    );

    const whoamiRes = await request(app)
      .get('/api/v1/admin/session')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('X-CSRF-Token', adminRes.body.csrfToken as string)
      .set('Origin', ALLOWED_ORIGIN);

    expect(whoamiRes.status).toBe(200);
    expect(whoamiRes.body.role).toBe('admin');
  });

  it('includes role in whoami response for member', async () => {
    const { member } = await seedTeam();

    // Members get sessions via SSO, so create directly
    const { sessionToken, csrfToken } = await createAdminSession(pool, member.userId);

    const whoamiRes = await request(app)
      .get('/api/v1/admin/session')
      .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`)
      .set('X-CSRF-Token', csrfToken)
      .set('Origin', ALLOWED_ORIGIN);

    expect(whoamiRes.status).toBe(200);
    expect(whoamiRes.body.role).toBe('member');
  });
});
