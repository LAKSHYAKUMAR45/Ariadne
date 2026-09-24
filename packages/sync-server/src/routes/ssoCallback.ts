import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAdminSession, serializeAdminSessionCookie } from '../adminSessions.js';
import { provisionSsoUser } from '../ssoProvisioning.js';
import { asyncHandler } from '../middleware.js';

const querySchema = z.object({ code: z.string().min(1).max(128) });

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface ConsumedCodeRow {
  username: string;
  role: 'admin' | 'member';
}

/**
 * Atomically consumes a code: the UPDATE's WHERE clause (unconsumed, not
 * expired) and RETURNING together mean two concurrent requests for the same
 * code can never both succeed — the second one always sees zero rows
 * updated, exactly like the first would have if it had already run.
 */
async function consumeCode(pool: Pool, code: string): Promise<ConsumedCodeRow | null> {
  const { rows } = await pool.query<ConsumedCodeRow>(
    `UPDATE sso_exchange_codes
        SET consumed_at = now()
      WHERE code_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING username, role`,
    [hashCode(code)],
  );
  return rows[0] ?? null;
}

export interface SsoCallbackRouterOptions {
  cookieSecure: boolean;
}

/** Mounted at `/sso/callback`. Public: no session or CSRF required to reach it. */
export function createSsoCallbackRouter(pool: Pool, options: SsoCallbackRouterOptions): Router {
  const router = Router();
  const cookieOptions = { secure: options.cookieSecure };

  router.get(
    '/',
    asyncHandler(async (req: Request, res: Response) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        res.redirect('/admin?sso_error=1');
        return;
      }

      const consumed = await consumeCode(pool, parsed.data.code);
      if (!consumed) {
        res.redirect('/admin?sso_error=1');
        return;
      }

      const { userId } = await provisionSsoUser(pool, consumed.username, consumed.role);
      const created = await createAdminSession(pool, userId);

      res.setHeader('Set-Cookie', serializeAdminSessionCookie(created.sessionToken, cookieOptions));
      res.setHeader('Cache-Control', 'no-store');
      res.redirect('/admin');
    }),
  );

  return router;
}
