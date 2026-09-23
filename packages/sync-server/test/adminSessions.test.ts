import { createHash, randomBytes } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import {
  ADMIN_LOGIN_RATE_LIMIT,
  ADMIN_REAUTHENTICATION_WINDOW_MS,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_PATH,
  ADMIN_SESSION_TTL_SECONDS,
  createAdminAuthRateLimiter,
  hashSessionToken,
  type AdminAuthRateLimiter,
} from '../src/adminSessions.js';
import { hashPassword, signToken } from '../src/auth.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { truncateFixtureTables } from './dbCleanup.js';
import { createTestEncryptionKeyring } from './testKeyring.js';
import { TEST_DATABASE_URL, TEST_JWT_SECRET } from './testConfig.js';

const ALLOWED_ORIGIN = 'https://dashboard.example.test';
const ADMIN_PASSWORD = 'correct-horse-battery-staple';
const MEMBER_PASSWORD = 'member-password-123456';

interface SessionHandle {
  userId: string;
  username: string;
  sessionToken: string;
  csrfToken: string;
  cookieHeader: string;
  headers: Record<string, string>;
}

describe('sync-server: admin dashboard sessions', () => {
  let pool: Pool;
  let app: Express;
  let loopbackApp: Express;
  let rateLimiter: AdminAuthRateLimiter;
  let loopbackRateLimiter: AdminAuthRateLimiter;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    rateLimiter = createAdminAuthRateLimiter();
    loopbackRateLimiter = createAdminAuthRateLimiter();
    app = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      adminPublicOrigin: ALLOWED_ORIGIN,
      adminCookieSecure: true,
      adminAuthRateLimiter: rateLimiter,
    });
    // The approved tunnelled deployment terminates TLS in the SSH tunnel and
    // serves plain loopback HTTP, so `Secure` must follow the transport.
    loopbackApp = createApp(pool, TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      adminPublicOrigin: 'http://127.0.0.1:4300',
      adminCookieSecure: false,
      adminAuthRateLimiter: loopbackRateLimiter,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool);
    rateLimiter.reset();
    loopbackRateLimiter.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  /**
   * The schema allows exactly one admin membership per team
   * (idx_team_memberships_single_admin), which is the database half of "only
   * one admin may ever log in".
   */
  async function seedTeam(): Promise<{
    teamId: string;
    admin: { userId: string; username: string };
    member: { userId: string; username: string };
  }> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO teams (singleton_key, name) VALUES ($1, $2) RETURNING id',
      ['default', 'Ariadne'],
    );
    const teamId = rows[0].id;

    const admin = await createUser('dash-admin', ADMIN_PASSWORD);
    const member = await createUser('dash-member', MEMBER_PASSWORD);

    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active)
       VALUES ($1, $2, 'admin', true), ($1, $3, 'member', true)`,
      [teamId, admin.userId, member.userId],
    );

    return { teamId, admin, member };
  }

  function parseSetCookie(header: string | string[] | undefined): string {
    const values = Array.isArray(header) ? header : header ? [header] : [];
    const cookie = values.find((value) => value.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
    expect(cookie).toBeTruthy();
    return cookie as string;
  }

  function cookieAttributes(setCookie: string): Map<string, string> {
    const attributes = new Map<string, string>();
    for (const segment of setCookie.split(';').slice(1)) {
      const [name, value] = segment.trim().split('=');
      attributes.set(name.toLowerCase(), value ?? '');
    }
    return attributes;
  }

  async function login(
    target: Express = app,
    username = 'dash-admin',
    password = ADMIN_PASSWORD,
  ): Promise<SessionHandle> {
    const res = await request(target)
      .post('/api/v1/admin/session')
      .set('Origin', target === app ? ALLOWED_ORIGIN : 'http://127.0.0.1:4300')
      .send({ username, password })
      .expect(201);

    const setCookie = parseSetCookie(res.headers['set-cookie']);
    const sessionToken = setCookie.slice(
      `${ADMIN_SESSION_COOKIE_NAME}=`.length,
      setCookie.indexOf(';'),
    );
    const csrfToken = res.body.csrfToken as string;
    const cookieHeader = `${ADMIN_SESSION_COOKIE_NAME}=${sessionToken}`;

    return {
      userId: res.body.userId as string,
      username: res.body.username as string,
      sessionToken,
      csrfToken,
      cookieHeader,
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': csrfToken,
        Origin: target === app ? ALLOWED_ORIGIN : 'http://127.0.0.1:4300',
      },
    };
  }

  describe('login', () => {
    it('signs in the active admin with exact cookie flags and a separate CSRF token', async () => {
      await seedTeam();

      const res = await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: ADMIN_PASSWORD });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ username: 'dash-admin', reauthenticatedUntil: null });
      expect(res.body.userId).toEqual(expect.any(String));
      expect(res.body.expiresAt).toEqual(expect.any(String));
      expect(res.body.csrfToken).toMatch(/^[0-9a-f]{64}$/);

      const setCookie = parseSetCookie(res.headers['set-cookie']);
      const sessionToken = setCookie.slice(
        `${ADMIN_SESSION_COOKIE_NAME}=`.length,
        setCookie.indexOf(';'),
      );
      expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
      // The CSRF token must be an independent secret, not a copy of the session
      // token the browser already holds in its cookie jar.
      expect(sessionToken).not.toBe(res.body.csrfToken);
      // The cookie must never be readable by page scripts.
      expect(JSON.stringify(res.body)).not.toContain(sessionToken);

      const attributes = cookieAttributes(setCookie);
      expect(attributes.get('path')).toBe(ADMIN_SESSION_COOKIE_PATH);
      expect(attributes.get('max-age')).toBe(String(ADMIN_SESSION_TTL_SECONDS));
      expect(attributes.has('httponly')).toBe(true);
      expect(attributes.has('secure')).toBe(true);
      expect(attributes.get('samesite')).toBe('Strict');
    });

    it('omits Secure for the approved tunnelled loopback HTTP transport', async () => {
      await seedTeam();

      const res = await request(loopbackApp)
        .post('/api/v1/admin/session')
        .set('Origin', 'http://127.0.0.1:4300')
        .send({ username: 'dash-admin', password: ADMIN_PASSWORD })
        .expect(201);

      const attributes = cookieAttributes(parseSetCookie(res.headers['set-cookie']));
      expect(attributes.has('secure')).toBe(false);
      expect(attributes.has('httponly')).toBe(true);
      expect(attributes.get('samesite')).toBe('Strict');
      expect(attributes.get('path')).toBe(ADMIN_SESSION_COOKIE_PATH);
    });

    it('gives members, deactivated admins, unknown users and bad passwords one generic answer', async () => {
      const { admin, member } = await seedTeam();

      async function attemptLogin(username: string, password: string) {
        const res = await request(app)
          .post('/api/v1/admin/session')
          .set('Origin', ALLOWED_ORIGIN)
          .send({ username, password });

        expect(res.status).toBe(401);
        expect(res.body.error).toEqual({
          code: 'invalid_credentials',
          message: 'Invalid username or password',
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      }

      // A real member with their own correct password.
      await attemptLogin('dash-member', MEMBER_PASSWORD);
      // A username that does not exist at all.
      await attemptLogin('nobody-at-all', ADMIN_PASSWORD);
      // The admin, with the wrong password.
      await attemptLogin('dash-admin', 'wrong-password');

      // The admin, with the right password, after deactivation.
      await pool.query('UPDATE team_memberships SET active = false WHERE user_id = $1', [
        admin.userId,
      ]);
      await attemptLogin('dash-admin', ADMIN_PASSWORD);

      const sessions = await pool.query('SELECT id FROM admin_sessions');
      expect(sessions.rows).toHaveLength(0);

      // No hint about which of the four rejections was "closer" may leak out,
      // including through the audit log.
      const audit = await pool.query<{ actor_user_id: string | null; metadata: unknown }>(
        `SELECT actor_user_id, metadata FROM admin_audit_events
          WHERE action = 'admin_session_login' AND outcome = 'failed'`,
      );
      expect(audit.rows).toHaveLength(4);
      for (const row of audit.rows) {
        expect(row.actor_user_id).toBeNull();
        expect(JSON.stringify(row.metadata)).not.toContain(ADMIN_PASSWORD);
        expect(JSON.stringify(row.metadata)).not.toContain(MEMBER_PASSWORD);
        expect(JSON.stringify(row.metadata)).not.toContain(member.userId);
      }
    });

    it('rejects a login carried from a disallowed origin', async () => {
      await seedTeam();

      const res = await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', 'https://evil.example.test')
        .send({ username: 'dash-admin', password: ADMIN_PASSWORD });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('origin_not_allowed');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await pool.query('SELECT id FROM admin_sessions')).rows).toHaveLength(0);
    });

    it('stores only the SHA-256 hash of the session and CSRF tokens', async () => {
      await seedTeam();
      const session = await login();

      const { rows } = await pool.query<{
        token_hash: string;
        csrf_hash: string;
        revoked_at: Date | null;
        reauthenticated_until: Date | null;
      }>('SELECT token_hash, csrf_hash, revoked_at, reauthenticated_until FROM admin_sessions');

      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toBe(
        createHash('sha256').update(session.sessionToken).digest('hex'),
      );
      expect(rows[0].token_hash).toBe(hashSessionToken(session.sessionToken));
      expect(rows[0].token_hash).not.toBe(session.sessionToken);
      expect(rows[0].csrf_hash).toBe(createHash('sha256').update(session.csrfToken).digest('hex'));
      expect(rows[0].csrf_hash).not.toBe(session.csrfToken);
      expect(rows[0].revoked_at).toBeNull();
      expect(rows[0].reauthenticated_until).toBeNull();

      const everything = await pool.query<{ row: string }>(
        'SELECT row_to_json(admin_sessions)::text AS row FROM admin_sessions',
      );
      expect(everything.rows[0].row).not.toContain(session.sessionToken);
      expect(everything.rows[0].row).not.toContain(session.csrfToken);
    });
  });

  describe('session lifecycle', () => {
    it('reports the current session and requires the cookie', async () => {
      await seedTeam();
      const session = await login();

      const res = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        userId: session.userId,
        username: 'dash-admin',
        reauthenticatedUntil: null,
      });
      expect(JSON.stringify(res.body)).not.toContain(session.sessionToken);

      const anonymous = await request(app).get('/api/v1/admin/session');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.error.code).toBe('missing_session');

      const forged = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', `${ADMIN_SESSION_COOKIE_NAME}=${randomBytes(32).toString('hex')}`);
      expect(forged.status).toBe(401);
      expect(forged.body.error.code).toBe('invalid_session');
    });

    it('rotates the CSRF token on session restore and keeps only its hash', async () => {
      await seedTeam();
      const session = await login();
      const before = await pool.query<{ csrf_hash: string }>(
        'SELECT csrf_hash FROM admin_sessions WHERE token_hash = $1',
        [hashSessionToken(session.sessionToken)],
      );

      const restored = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .expect(200);
      const csrfToken = restored.body.csrfToken as string;

      expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
      expect(csrfToken).not.toBe(session.csrfToken);
      expect(JSON.stringify(restored.body)).not.toContain(session.sessionToken);

      const after = await pool.query<{ csrf_hash: string }>(
        'SELECT csrf_hash FROM admin_sessions WHERE token_hash = $1',
        [hashSessionToken(session.sessionToken)],
      );
      expect(after.rows[0].csrf_hash).toBe(hashSessionToken(csrfToken));
      expect(after.rows[0].csrf_hash).not.toBe(csrfToken);
      expect(after.rows[0].csrf_hash).not.toBe(before.rows[0].csrf_hash);

      const oldToken = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: ADMIN_PASSWORD });
      expect(oldToken.status).toBe(403);
      expect(oldToken.body.error.code).toBe('csrf_failed');

      const newToken = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set('Cookie', session.cookieHeader)
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-CSRF-Token', csrfToken)
        .send({ password: ADMIN_PASSWORD });
      expect(newToken.status).toBe(200);
    });

    it('rejects expired and revoked sessions', async () => {
      await seedTeam();
      const expired = await login();
      await pool.query(
        `UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [hashSessionToken(expired.sessionToken)],
      );

      const afterExpiry = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', expired.cookieHeader);
      expect(afterExpiry.status).toBe(401);
      expect(afterExpiry.body.error.code).toBe('invalid_session');

      const revoked = await login();
      await pool.query('UPDATE admin_sessions SET revoked_at = now() WHERE token_hash = $1', [
        hashSessionToken(revoked.sessionToken),
      ]);

      const afterRevocation = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', revoked.cookieHeader);
      expect(afterRevocation.status).toBe(401);
      expect(afterRevocation.body.error.code).toBe('invalid_session');
    });

    it('revokes the session and clears the cookie on logout', async () => {
      await seedTeam();
      const session = await login();

      const res = await request(app).delete('/api/v1/admin/session').set(session.headers);
      expect(res.status).toBe(204);

      const setCookie = parseSetCookie(res.headers['set-cookie']);
      const attributes = cookieAttributes(setCookie);
      expect(setCookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=;`)).toBe(true);
      expect(attributes.get('max-age')).toBe('0');
      expect(attributes.get('path')).toBe(ADMIN_SESSION_COOKIE_PATH);
      expect(attributes.has('httponly')).toBe(true);

      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM admin_sessions WHERE token_hash = $1',
        [hashSessionToken(session.sessionToken)],
      );
      expect(rows[0].revoked_at).not.toBeNull();

      const reuse = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader);
      expect(reuse.status).toBe(401);

      const audit = await pool.query(
        `SELECT id FROM admin_audit_events WHERE action = 'admin_session_logout' AND outcome = 'succeeded'`,
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('rechecks active admin membership on every request', async () => {
      const { admin } = await seedTeam();
      const session = await login();

      await request(app).get('/api/v1/admin/members').set('Cookie', session.cookieHeader).expect(200);

      await pool.query(`UPDATE team_memberships SET role = 'member' WHERE user_id = $1`, [
        admin.userId,
      ]);
      const demoted = await request(app)
        .get('/api/v1/admin/members')
        .set('Cookie', session.cookieHeader);
      expect(demoted.status).toBe(403);
      expect(demoted.body.error.code).toBe('admin_required');

      await pool.query(`UPDATE team_memberships SET role = 'admin', active = false WHERE user_id = $1`, [
        admin.userId,
      ]);
      const deactivated = await request(app)
        .get('/api/v1/admin/members')
        .set('Cookie', session.cookieHeader);
      expect(deactivated.status).toBe(403);
      expect(deactivated.body.error.code).toBe('admin_required');
    });
  });

  describe('CSRF and origin enforcement', () => {
    it('rejects state changes with a missing, wrong or ill-formed CSRF token', async () => {
      await seedTeam();
      const session = await login();

      const missing = await request(app)
        .delete('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set('Origin', ALLOWED_ORIGIN);
      expect(missing.status).toBe(403);
      expect(missing.body.error.code).toBe('csrf_failed');

      const wrong = await request(app)
        .delete('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-CSRF-Token', randomBytes(32).toString('hex'));
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('csrf_failed');

      const malformed = await request(app)
        .delete('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set('Origin', ALLOWED_ORIGIN)
        .set('X-CSRF-Token', 'not-a-token');
      expect(malformed.status).toBe(403);
      expect(malformed.body.error.code).toBe('csrf_failed');

      // The session must survive every rejected forgery attempt.
      await request(app).get('/api/v1/admin/session').set('Cookie', session.cookieHeader).expect(200);
    });

    it('rejects state changes from a disallowed or missing Origin', async () => {
      await seedTeam();
      const session = await login();

      const foreign = await request(app)
        .delete('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set('X-CSRF-Token', session.csrfToken)
        .set('Origin', 'https://evil.example.test');
      expect(foreign.status).toBe(403);
      expect(foreign.body.error.code).toBe('origin_not_allowed');

      const absent = await request(app)
        .delete('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set('X-CSRF-Token', session.csrfToken);
      expect(absent.status).toBe(403);
      expect(absent.body.error.code).toBe('origin_not_allowed');

      await request(app).get('/api/v1/admin/session').set('Cookie', session.cookieHeader).expect(200);
    });

    it('does not require CSRF for safe reads', async () => {
      await seedTeam();
      const session = await login();

      await request(app).get('/api/v1/admin/members').set('Cookie', session.cookieHeader).expect(200);
      await request(app).get('/api/v1/admin/tasks').set('Cookie', session.cookieHeader).expect(200);
    });
  });

  describe('bearer tokens no longer authorize the dashboard', () => {
    it('refuses a valid sync JWT on every admin endpoint while sync keeps working', async () => {
      const { admin } = await seedTeam();
      const bearer = { Authorization: `Bearer ${signToken({ sub: admin.userId, username: 'dash-admin' }, TEST_JWT_SECRET)}` };

      const adminRequests = [
        request(app).get('/api/v1/admin/members').set(bearer),
        request(app).get('/api/v1/admin/tasks').set(bearer),
        request(app).get('/api/v1/admin/operations').set(bearer),
        request(app)
          .post('/api/v1/admin/operations/service-restart')
          .set(bearer)
          .set('Origin', ALLOWED_ORIGIN)
          .send({ service: 'sync-server' }),
      ];

      for (const pending of adminRequests) {
        const res = await pending;
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('missing_session');
      }

      // The sync CLI surface still authenticates with the same bearer token.
      await request(app).get('/api/v1/sync/tasks').set(bearer).expect(200);
    });

    it('ignores a bearer token that accompanies a valid session cookie', async () => {
      const { admin, member } = await seedTeam();
      const session = await login();

      const res = await request(app)
        .get('/api/v1/admin/session')
        .set('Cookie', session.cookieHeader)
        .set(
          'Authorization',
          `Bearer ${signToken({ sub: member.userId, username: 'dash-member' }, TEST_JWT_SECRET)}`,
        );

      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(admin.userId);
    });
  });

  describe('reauthentication', () => {
    it('grants a five-minute window on a correct password', async () => {
      await seedTeam();
      const session = await login();

      const before = Date.now();
      const res = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: ADMIN_PASSWORD });
      const after = Date.now();

      expect(res.status).toBe(200);
      expect(res.body.reauthenticatedUntil).toEqual(expect.any(String));
      const until = Date.parse(res.body.reauthenticatedUntil as string);
      expect(until).toBeGreaterThanOrEqual(before + ADMIN_REAUTHENTICATION_WINDOW_MS - 2000);
      expect(until).toBeLessThanOrEqual(after + ADMIN_REAUTHENTICATION_WINDOW_MS + 2000);

      const { rows } = await pool.query<{ reauthenticated_until: Date }>(
        'SELECT reauthenticated_until FROM admin_sessions WHERE token_hash = $1',
        [hashSessionToken(session.sessionToken)],
      );
      expect(rows[0].reauthenticated_until).not.toBeNull();

      const audit = await pool.query(
        `SELECT id FROM admin_audit_events
          WHERE action = 'admin_session_reauthenticate' AND outcome = 'succeeded'`,
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('gates privileged operations on a live reauthentication window', async () => {
      await seedTeam();
      const session = await login();

      const beforeReauth = await request(app)
        .post('/api/v1/admin/operations/service-restart')
        .set(session.headers)
        .send({ service: 'sync-server', confirmation: 'RESTART sync-server' });
      expect(beforeReauth.status).toBe(403);
      expect(beforeReauth.body.error.code).toBe('reauthentication_required');

      await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: ADMIN_PASSWORD })
        .expect(200);

      // No operator client is configured for this app, so a reauthenticated
      // request gets as far as operator submission (503) instead of 403.
      const afterReauth = await request(app)
        .post('/api/v1/admin/operations/service-restart')
        .set(session.headers)
        .send({ service: 'sync-server', confirmation: 'RESTART sync-server' });
      expect(afterReauth.status).not.toBe(403);

      await pool.query(
        `UPDATE admin_sessions SET reauthenticated_until = now() - interval '1 second'
          WHERE token_hash = $1`,
        [hashSessionToken(session.sessionToken)],
      );

      const afterWindow = await request(app)
        .post('/api/v1/admin/operations/service-restart')
        .set(session.headers)
        .send({ service: 'sync-server', confirmation: 'RESTART sync-server' });
      expect(afterWindow.status).toBe(403);
      expect(afterWindow.body.error.code).toBe('reauthentication_required');
    });

    it('refuses a wrong password without extending the window', async () => {
      await seedTeam();
      const session = await login();

      const res = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: 'not-the-password' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('invalid_credentials');

      const { rows } = await pool.query<{ reauthenticated_until: Date | null }>(
        'SELECT reauthenticated_until FROM admin_sessions WHERE token_hash = $1',
        [hashSessionToken(session.sessionToken)],
      );
      expect(rows[0].reauthenticated_until).toBeNull();

      const audit = await pool.query(
        `SELECT id FROM admin_audit_events
          WHERE action = 'admin_session_reauthenticate' AND outcome = 'failed'`,
      );
      expect(audit.rows).toHaveLength(1);
    });

    it('requires a session and CSRF proof to reauthenticate', async () => {
      await seedTeam();
      const session = await login();

      const anonymous = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ password: ADMIN_PASSWORD });
      expect(anonymous.status).toBe(401);

      const noCsrf = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set('Cookie', session.cookieHeader)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ password: ADMIN_PASSWORD });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body.error.code).toBe('csrf_failed');
    });
  });

  describe('rate limiting', () => {
    it('bounds repeated failed logins for the same username and address', async () => {
      await seedTeam();

      for (let attempt = 0; attempt < ADMIN_LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const res = await request(app)
          .post('/api/v1/admin/session')
          .set('Origin', ALLOWED_ORIGIN)
          .send({ username: 'dash-admin', password: 'wrong-password' });
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: 'wrong-password' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('too_many_attempts');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

      // Even the correct password is refused while the window is closed.
      const correct = await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: ADMIN_PASSWORD });
      expect(correct.status).toBe(429);

      // A different username is unaffected by the blocked key.
      const other = await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-member', password: MEMBER_PASSWORD });
      expect(other.status).toBe(401);
    });

    it('bounds repeated failed reauthentications', async () => {
      await seedTeam();
      const session = await login();

      for (let attempt = 0; attempt < ADMIN_LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const res = await request(app)
          .post('/api/v1/admin/session/reauthenticate')
          .set(session.headers)
          .send({ password: 'wrong-password' });
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: 'wrong-password' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('too_many_attempts');
    });

    it('clears the counter after a successful login', async () => {
      await seedTeam();

      await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: 'wrong-password' })
        .expect(401);

      await login();

      for (let attempt = 0; attempt < ADMIN_LOGIN_RATE_LIMIT.limit; attempt += 1) {
        const res = await request(app)
          .post('/api/v1/admin/session')
          .set('Origin', ALLOWED_ORIGIN)
          .send({ username: 'dash-admin', password: 'wrong-password' });
        expect(res.status).toBe(401);
      }
    });

    it('writes one rate-limited audit row per blocked login window', async () => {
      await seedTeam();
      const limitedRateLimiter = createAdminAuthRateLimiter({ limit: 2, windowMs: 5_000 });
      const limitedApp = createApp(pool, TEST_JWT_SECRET, {
        encryptionKeyring: createTestEncryptionKeyring(),
        adminPublicOrigin: ALLOWED_ORIGIN,
        adminCookieSecure: true,
        adminAuthRateLimiter: limitedRateLimiter,
      });

      async function exhaustThenBlock(): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await request(limitedApp)
            .post('/api/v1/admin/session')
            .set('Origin', ALLOWED_ORIGIN)
            .send({ username: 'dash-admin', password: 'wrong-password' })
            .expect(401);
        }
      }

      await exhaustThenBlock();

      await request(limitedApp)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: 'wrong-password' })
        .expect(429);
      await request(limitedApp)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: ADMIN_PASSWORD })
        .expect(429);

      let audit = await pool.query<{ outcome: string; metadata: { reason?: string } | null }>(
        `SELECT outcome, metadata
           FROM admin_audit_events
          WHERE action = 'admin_session_login'
          ORDER BY created_at ASC`,
      );
      expect(
        audit.rows.filter((row) => row.outcome === 'failed' && row.metadata?.reason === 'invalid_credentials'),
      ).toHaveLength(2);
      expect(
        audit.rows.filter((row) => row.outcome === 'failed' && row.metadata?.reason === 'rate_limited'),
      ).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 5_100));

      await exhaustThenBlock();
      await request(limitedApp)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: 'wrong-password' })
        .expect(429);

      audit = await pool.query<{ outcome: string; metadata: { reason?: string } | null }>(
        `SELECT outcome, metadata
           FROM admin_audit_events
          WHERE action = 'admin_session_login'
          ORDER BY created_at ASC`,
      );
      expect(
        audit.rows.filter((row) => row.outcome === 'failed' && row.metadata?.reason === 'rate_limited'),
      ).toHaveLength(2);
    });

    it('keeps the attempt table bounded and prunes expired windows', () => {
      const limiter = createAdminAuthRateLimiter({ limit: 2, windowMs: 50, maxEntries: 8 });

      for (let index = 0; index < 100; index += 1) {
        limiter.recordFailure(`user-${index}|127.0.0.1`);
      }
      expect(limiter.size()).toBeLessThanOrEqual(8);

      limiter.recordFailure('bounded|127.0.0.1');
      limiter.recordFailure('bounded|127.0.0.1');
      expect(limiter.check('bounded|127.0.0.1').allowed).toBe(false);
    });
  });

  describe('logging hygiene', () => {
    it('never writes passwords, cookies, CSRF tokens or bearer JWTs to the logs', async () => {
      const { admin } = await seedTeam();
      const bearer = signToken({ sub: admin.userId, username: 'dash-admin' }, TEST_JWT_SECRET);
      const logged: string[] = [];
      for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(' '));
        });
      }

      const session = await login();
      await request(app)
        .post('/api/v1/admin/session')
        .set('Origin', ALLOWED_ORIGIN)
        .send({ username: 'dash-admin', password: 'wrong-password' })
        .expect(401);
      await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set(session.headers)
        .send({ password: ADMIN_PASSWORD })
        .expect(200);
      await request(app)
        .post('/api/v1/admin/session/reauthenticate')
        .set({ ...session.headers, 'Content-Type': 'application/json' })
        .send('{"password": "correct-horse-battery-staple"')
        .expect(400);
      await request(app).get('/api/v1/admin/members').set('Authorization', `Bearer ${bearer}`).expect(401);

      const transcript = logged.join('\n');
      expect(transcript).not.toContain(ADMIN_PASSWORD);
      expect(transcript).not.toContain('wrong-password');
      expect(transcript).not.toContain(session.sessionToken);
      expect(transcript).not.toContain(session.csrfToken);
      expect(transcript).not.toContain(bearer);
    });
  });
});
