/**
 * Server-to-server SSO code minting endpoint.
 *
 * This endpoint is authenticated only by the shared secret, never by session
 * cookies. In production it must ALSO be network-restricted to loopback or
 * the jcnr-triage host via nginx (a later rollout task) — the shared secret
 * is defense-in-depth, not a substitute for network restriction.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Router } from 'express';
import express from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ApiError, errorBody } from '../errors.js';
import { asyncHandler } from '../middleware.js';

const ssoCodeRequestSchema = z
  .object({
    username: z.string().min(1).max(64),
    role: z.enum(['admin', 'member']),
  })
  .strict();

type SsoCodeRequest = z.infer<typeof ssoCodeRequestSchema>;

/**
 * Generates a random 32-byte opaque code encoded as base64url.
 */
function generateCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hashes a code with SHA-256, returning the hex digest.
 */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Constant-time secret comparison: compare buffer lengths first, then use
 * timingSafeEqual to prevent timing-based attacks.
 */
function compareSecrets(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Inserts an SSO exchange code into the database.
 */
async function insertSsoCode(
  pool: Pool,
  codeHash: string,
  username: string,
  role: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO sso_exchange_codes (code_hash, username, role, expires_at)
     VALUES ($1, $2, $3, now() + interval '60 seconds')`,
    [codeHash, username, role],
  );
}

export function createInternalSsoRouter(pool: Pool, ssoSharedSecret: string): Router {
  const router = express.Router();

  router.post(
    '/codes',
    asyncHandler(async (req, res) => {
      // Authenticate with the shared secret header
      const providedSecret = req.header('X-Ariadne-SSO-Secret');
      if (!providedSecret || !compareSecrets(providedSecret, ssoSharedSecret)) {
        throw new ApiError(401, 'invalid_secret', 'Invalid or missing shared secret');
      }

      // Validate the request body
      const parseResult = ssoCodeRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        throw new ApiError(400, 'invalid_request', 'Invalid request body');
      }

      const { username, role }: SsoCodeRequest = parseResult.data;

      // Generate the code and hash it
      const code = generateCode();
      const codeHash = hashCode(code);

      // Store the hash (never the raw code) in the database
      await insertSsoCode(pool, codeHash, username, role);

      // Return the raw code to the caller, with no-store cache headers
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ code });
    }),
  );

  return router;
}
