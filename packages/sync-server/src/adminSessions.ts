/**
 * Database-backed sessions for the browser-facing admin dashboard.
 *
 * The dashboard is a different trust domain from the sync CLI: it runs inside
 * a browser, where an attacker-controlled page can make cross-site requests
 * and where any credential readable by JavaScript is one XSS away from being
 * exfiltrated. So the dashboard does not use the sync bearer JWT at all. It
 * uses an opaque random session token delivered in an HttpOnly, SameSite
 * cookie, paired with a separate CSRF token that only the dashboard's own code
 * can read, and both are stored as SHA-256 hashes so the database never holds
 * a usable credential.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { serialize as serializeCookie } from 'cookie';
import type { Pool } from 'pg';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminSession?: {
        id: string;
        userId: string;
        csrfHash: string;
        reauthenticatedUntil: string | null;
      };
    }
  }
}

export const ADMIN_SESSION_COOKIE_NAME = 'ariadne_admin_session';
/**
 * Exact path scoping: the cookie is only ever attached to the admin API, so
 * no other route (and no other cookie-reading surface on the same origin) can
 * see it. Left deliberately without a trailing slash so it matches
 * `/api/v1/admin` and its subpaths and nothing else.
 */
export const ADMIN_SESSION_COOKIE_PATH = '/api/v1/admin';
/** Twelve hours: one working session, re-login required the next day. */
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
export const ADMIN_REAUTHENTICATION_WINDOW_MS = 5 * 60 * 1000;

export const ADMIN_LOGIN_RATE_LIMIT = {
  limit: 5,
  windowMs: 15 * 60 * 1000,
  maxEntries: 1024,
} as const;

export const ADMIN_AUDIT_SOURCE = 'admin_dashboard';
export const ADMIN_LOGIN_ACTION = 'admin_session_login';
export const ADMIN_LOGOUT_ACTION = 'admin_session_logout';
export const ADMIN_REAUTHENTICATION_ACTION = 'admin_session_reauthenticate';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface AdminSessionRecord {
  id: string;
  userId: string;
  csrfHash: string;
  expiresAt: string;
  reauthenticatedUntil: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface AdminSessionRow {
  id: string;
  user_id: string;
  csrf_hash: string;
  expires_at: Date;
  reauthenticated_until: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  last_seen_at: Date;
}

function mapSession(row: AdminSessionRow): AdminSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at.toISOString(),
    reauthenticatedUntil: row.reauthenticated_until
      ? row.reauthenticated_until.toISOString()
      : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

/** 32 bytes of CSPRNG output, hex encoded. */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/**
 * Constant-time comparison of two hex digests. Both inputs are fixed-width
 * SHA-256 output in every caller, so a length mismatch only ever means a
 * malformed value and is rejected without leaking a timing signal about the
 * stored digest.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface CreatedAdminSession {
  session: AdminSessionRecord;
  /** Returned once, to the browser's cookie jar. Never stored, never logged. */
  sessionToken: string;
  /** Returned once, in the response body, for the dashboard to echo back. */
  csrfToken: string;
}

export async function createAdminSession(
  pool: Pool,
  userId: string,
  options: { ttlSeconds?: number } = {},
): Promise<CreatedAdminSession> {
  const sessionToken = generateSessionToken();
  const csrfToken = generateSessionToken();
  const ttlSeconds = options.ttlSeconds ?? ADMIN_SESSION_TTL_SECONDS;

  const { rows } = await pool.query<AdminSessionRow>(
    `INSERT INTO admin_sessions (user_id, token_hash, csrf_hash, expires_at)
     VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
     RETURNING id, user_id, csrf_hash, expires_at, reauthenticated_until,
               revoked_at, created_at, last_seen_at`,
    [userId, hashSessionToken(sessionToken), hashSessionToken(csrfToken), ttlSeconds],
  );

  return { session: mapSession(rows[0]), sessionToken, csrfToken };
}

/**
 * Looks up a live session by raw token and refreshes `last_seen_at` in the
 * same statement. Expired and revoked rows are filtered in SQL so a stale row
 * can never be resurrected by application-side clock skew.
 */
export async function findActiveAdminSession(
  pool: Pool,
  token: string,
): Promise<AdminSessionRecord | null> {
  if (!isWellFormedToken(token)) {
    return null;
  }

  const { rows } = await pool.query<AdminSessionRow>(
    `UPDATE admin_sessions
        SET last_seen_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id, csrf_hash, expires_at, reauthenticated_until,
                revoked_at, created_at, last_seen_at`,
    [hashSessionToken(token)],
  );

  return rows[0] ? mapSession(rows[0]) : null;
}

export async function revokeAdminSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query(
    'UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

export async function markAdminSessionReauthenticated(
  pool: Pool,
  sessionId: string,
  windowMs: number = ADMIN_REAUTHENTICATION_WINDOW_MS,
): Promise<string> {
  const { rows } = await pool.query<{ reauthenticated_until: Date }>(
    `UPDATE admin_sessions
        SET reauthenticated_until = now() + ($2::int * interval '1 millisecond')
      WHERE id = $1
      RETURNING reauthenticated_until`,
    [sessionId, windowMs],
  );
  return rows[0].reauthenticated_until.toISOString();
}

/** True while the session's password reauthentication window is still open. */
export function isReauthenticated(
  session: Pick<AdminSessionRecord, 'reauthenticatedUntil'>,
  now: number = Date.now(),
): boolean {
  if (!session.reauthenticatedUntil) {
    return false;
  }
  return Date.parse(session.reauthenticatedUntil) > now;
}

export interface AdminSessionCookieOptions {
  secure: boolean;
}

export function serializeAdminSessionCookie(
  token: string,
  options: AdminSessionCookieOptions,
): string {
  return serializeCookie(ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: options.secure,
    path: ADMIN_SESSION_COOKIE_PATH,
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
}

export function serializeClearedAdminSessionCookie(
  options: AdminSessionCookieOptions,
): string {
  return serializeCookie(ADMIN_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: options.secure,
    path: ADMIN_SESSION_COOKIE_PATH,
    maxAge: 0,
  });
}

export interface AdminAuthRateLimiterOptions {
  limit?: number;
  windowMs?: number;
  maxEntries?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AdminAuthRateLimiter {
  check(key: string): RateLimitDecision;
  recordFailure(key: string): void;
  reset(key?: string): void;
  size(): number;
}

interface AttemptWindow {
  failures: number;
  expiresAt: number;
}

/**
 * Fixed-window limiter for password attempts, keyed by normalized username
 * plus remote address.
 *
 * SSH (or the reverse proxy in front of it) is the real network boundary for
 * this deployment: the sync server binds loopback, so every remote address
 * seen here is a tunnel endpoint. The limiter therefore exists to slow down
 * password guessing by someone who already reached the tunnel, not to serve as
 * a public-internet DoS control.
 *
 * The table is hard-bounded: expired windows are swept periodically (at most
 * once per window, driven by write activity rather than a timer, so nothing
 * keeps the process alive), and if the table is still full the oldest entry is
 * evicted. Bounding matters more than perfect accounting — an unbounded map
 * keyed by attacker-supplied usernames is itself a memory-exhaustion vector.
 */
export function createAdminAuthRateLimiter(
  options: AdminAuthRateLimiterOptions = {},
): AdminAuthRateLimiter {
  const limit = options.limit ?? ADMIN_LOGIN_RATE_LIMIT.limit;
  const windowMs = options.windowMs ?? ADMIN_LOGIN_RATE_LIMIT.windowMs;
  const maxEntries = options.maxEntries ?? ADMIN_LOGIN_RATE_LIMIT.maxEntries;

  const windows = new Map<string, AttemptWindow>();
  let nextSweepAt = Date.now() + windowMs;

  function sweep(now: number): void {
    for (const [key, window] of windows) {
      if (window.expiresAt <= now) {
        windows.delete(key);
      }
    }
    nextSweepAt = now + windowMs;
  }

  function maybeSweep(now: number): void {
    if (now >= nextSweepAt || windows.size >= maxEntries) {
      sweep(now);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const now = Date.now();
      const window = windows.get(key);
      if (!window || window.expiresAt <= now) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (window.failures < limit) {
        return { allowed: true, retryAfterSeconds: 0 };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.expiresAt - now) / 1000)),
      };
    },

    recordFailure(key: string): void {
      const now = Date.now();
      maybeSweep(now);

      const existing = windows.get(key);
      if (existing && existing.expiresAt > now) {
        existing.failures += 1;
        return;
      }

      if (windows.size >= maxEntries) {
        const oldest = windows.keys().next();
        if (!oldest.done) {
          windows.delete(oldest.value);
        }
      }
      windows.set(key, { failures: 1, expiresAt: now + windowMs });
    },

    reset(key?: string): void {
      if (key === undefined) {
        windows.clear();
        nextSweepAt = Date.now() + windowMs;
        return;
      }
      windows.delete(key);
    },

    size(): number {
      return windows.size;
    },
  };
}

/**
 * Builds the limiter key. The username is normalized so casing tricks cannot
 * buy extra attempts; the remote address is included so one stuck client
 * cannot lock the admin out from every other endpoint of the tunnel.
 */
export function rateLimiterKey(username: string, remoteAddress: string | undefined): string {
  return `${username.trim().toLowerCase()}|${remoteAddress ?? 'unknown'}`;
}

export type AdminAuthOutcome = 'succeeded' | 'failed';

export interface AdminAuthAuditInput {
  actorUserId: string | null;
  action: string;
  outcome: AdminAuthOutcome;
  /** Fixed, enumerated reason codes only — never credentials or request bodies. */
  reason?: string;
}

/**
 * Appends one sanitized row to the append-only admin audit log.
 *
 * Only an enumerated reason code is recorded. The attempted username is
 * deliberately omitted: on a failed login it is attacker-supplied text, and on
 * a successful one the actor's user id already identifies who acted.
 */
export async function recordAdminAuthAuditEvent(
  pool: Pool,
  input: AdminAuthAuditInput,
): Promise<void> {
  const metadata = input.reason ? { reason: input.reason } : {};
  await pool.query(
    `INSERT INTO admin_audit_events (actor_user_id, action, source, outcome, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.actorUserId,
      input.action,
      ADMIN_AUDIT_SOURCE,
      input.outcome,
      JSON.stringify(metadata),
    ],
  );
}
