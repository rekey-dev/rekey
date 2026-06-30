/**
 * Magic-link sign-in tokens.
 *
 * Same lifecycle shape as `lib/email-verification.ts` but:
 *   - 15-minute lifetime (shorter — this IS the credential, not a confirmation).
 *   - `endUserId` may be null at issue time when the email doesn't yet have an
 *     account; the consume path is responsible for creating the EndUser
 *     atomically with the token consumption, subject to `authConfig.signupEnabled`.
 *   - Captures the email at issue time so a later email-change refuses the
 *     stale token (same guard as email verification).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { MagicLinkToken } from '@prisma/client';
import { prisma } from './prisma.js';

const TOKEN_BYTES = 32;
const LIFETIME_MS = 15 * 60 * 1000;

export function hashMagicLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface IssuedMagicLinkToken {
  raw: string;
  record: MagicLinkToken;
}

export async function issueMagicLinkToken(args: {
  applicationId: string;
  /** Pass null when the email doesn't have an account yet. */
  endUserId: string | null;
  email: string;
}): Promise<IssuedMagicLinkToken> {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const record = await prisma.magicLinkToken.create({
    data: {
      applicationId: args.applicationId,
      endUserId: args.endUserId,
      email: args.email.toLowerCase(),
      tokenHash: hashMagicLinkToken(raw),
      expiresAt: new Date(Date.now() + LIFETIME_MS),
    },
  });
  return { raw, record };
}

export type MagicLinkLookup =
  | { kind: 'ok'; token: MagicLinkToken }
  | { kind: 'unknown' }
  | { kind: 'consumed'; token: MagicLinkToken }
  | { kind: 'expired'; token: MagicLinkToken };

export async function lookupMagicLinkToken(raw: string): Promise<MagicLinkLookup> {
  const token = await prisma.magicLinkToken.findUnique({
    where: { tokenHash: hashMagicLinkToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.consumedAt !== null) return { kind: 'consumed', token };
  if (token.expiresAt < new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/**
 * Atomically mark consumed. Race-safe — concurrent requests can't both
 * succeed (the second sees `consumedAt !== null` and bails).
 */
export async function consumeMagicLinkToken(token: MagicLinkToken): Promise<boolean> {
  const result = await prisma.magicLinkToken.updateMany({
    where: { id: token.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count === 1;
}
