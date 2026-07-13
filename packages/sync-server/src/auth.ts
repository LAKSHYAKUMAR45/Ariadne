import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const BCRYPT_COST_FACTOR = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export interface AuthTokenPayload {
  sub: string; // user id
  username: string;
}

/** 30-day expiry: acceptable for an internal, trusted-user deployment (see docs/06-CLOUD-SYNC-DESIGN.md §6). */
const TOKEN_EXPIRY = '30d';

export function signToken(payload: AuthTokenPayload, jwtSecret: string): string {
  return jwt.sign(payload, jwtSecret, { expiresIn: TOKEN_EXPIRY });
}

export function verifyToken(token: string, jwtSecret: string): AuthTokenPayload {
  return jwt.verify(token, jwtSecret) as AuthTokenPayload;
}
