import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from './config';

export interface AccessPayload {
  sub: string; // userId
  tid: string; // tenantId
  role: Role;
}

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.ACCESS_TOKEN_MINUTES * 60,
  });
}

export function verifyAccessToken(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  if (typeof decoded === 'string') throw new Error('invalid token');
  return decoded as unknown as AccessPayload;
}

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

/** الـ Refresh Token بيتحفظ في الداتابيز مشفر (hash) مش كنص */
export function newRefreshToken() {
  const token = crypto.randomBytes(48).toString('base64url');
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000),
  };
}
