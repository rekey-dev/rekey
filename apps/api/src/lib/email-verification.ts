/**
 * Email-verification tokens.
 *
 * Same lifecycle as `lib/password-reset.ts`:
 *   - 32-byte CSPRNG raw value, stored only as SHA-256 hash.
 *   - 24-hour lifetime (the user might check email on a phone, on a desk,
 *     a day later — longer than reset because the action is lower-stakes).
 *   - Single-use via `consumedAt`.
 *   - Captures the email being verified at issue time so a later
 *     email-change doesn't accidentally promote a stale verification.
 *
 * Consumed by `/api/v1/auth/verify-email`.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { EmailVerificationToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 24 * 60 * 60 * 1000;

export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedVerificationToken {
  raw: string;
  record: EmailVerificationToken;
}

export async function issueVerificationToken(args: {
  applicationId: string;
  endUserId: string;
  email: string;
}): Promise<IssuedVerificationToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const record = await prisma.emailVerificationToken.create({
    data: {
      applicationId: args.applicationId,
      endUserId: args.endUserId,
      email: args.email.toLowerCase(),
      tokenHash: hashVerificationToken(raw),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    },
  });
  return { raw, record };
}

export type VerificationLookup =
  | { kind: 'ok'; token: EmailVerificationToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: EmailVerificationToken }
  | { kind: 'expired'; token: EmailVerificationToken };

export async function lookupVerificationToken(raw: string): Promise<VerificationLookup> {
  const token = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashVerificationToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/**
 * Atomically mark consumed. Race-safe — concurrent requests can't both
 * succeed (the second sees `consumedAt !== null` and bails).
 */
export async function consumeVerificationToken(
  token: EmailVerificationToken,
): Promise<boolean> {
  const result = await prisma.emailVerificationToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
