/**
 * Refresh token issuance, verification, rotation, revocation.
 *
 * Lifecycle:
 *   1. Sign-up / sign-in mints a refresh token alongside the access token.
 *   2. When the access token expires, the caller exchanges the refresh
 *      token via POST /api/v1/auth/refresh. The presented refresh is
 *      revoked (revokedAt set) and a new {access, refresh} pair is issued.
 *   3. `replacedById` chains the rotation history. A presented-but-revoked
 *      refresh is *replay* — we reject the call.
 *
 * Storage: SHA-256 hash of the raw token, hash-only DB (same model as
 * ApiKey). Refresh tokens are 32 bytes of CSPRNG entropy — fast hash is
 * correct, Argon2 is for user-chosen passwords (see lib/passwords.ts).
 *
 * Lifetime: 30 days, sliding (each rotation issues a fresh 30-day window).
 */

import { createHash, randomBytes } from 'node:crypto';
import type { RefreshToken } from '@prisma/client';
import { prisma } from './prisma.js';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function generateRawToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export interface IssuedRefreshToken {
  raw: string;
  record: RefreshToken;
}

export interface IssueRefreshTokenOptions {
  /** Truncated User-Agent header at issue time. Surfaced by /me/sessions. */
  userAgent?: string | null;
  /** Inbound IP at issue time. Surfaced by /me/sessions. */
  ip?: string | null;
  /** Surface: "session" (default, SDK) or "mcp" (per-app OAuth token endpoint). */
  kind?: 'session' | 'mcp';
  /** For `kind: 'mcp'` — the OAuth client_id the token is bound to. */
  clientId?: string | null;
  /** Active organization for this session — re-emitted as the `oid` claim on refresh. */
  activeOrganizationId?: string | null;
}

/**
 * Mint a new refresh token for an end-user. Stores only the hash; the raw
 * value is the *only* time the caller can read it.
 *
 * The optional UA/IP are captured so `/me/sessions` can render a device
 * list. They're hints, not security primitives — cookie cloning across
 * devices won't change the stored values, so don't use them for binding.
 */
export async function issueRefreshToken(
  applicationId: string,
  endUserId: string,
  options: IssueRefreshTokenOptions = {},
): Promise<IssuedRefreshToken> {
  const raw = generateRawToken();
  // Truncate UA at 512 chars — some clients send egregious strings (especially
  // mobile WebViews). 512 is generous for any real-world UA.
  const ua = options.userAgent ? options.userAgent.slice(0, 512) : null;
  const ip = options.ip ? options.ip.slice(0, 64) : null;
  const record = await prisma.refreshToken.create({
    data: {
      applicationId,
      endUserId,
      tokenHash: hashRefreshToken(raw),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS),
      userAgent: ua,
      ip,
      kind: options.kind ?? 'session',
      clientId: options.clientId ?? null,
      activeOrganizationId: options.activeOrganizationId ?? null,
    },
  });
  return { raw, record };
}

export type RefreshOutcome =
  | { kind: 'ok'; token: RefreshToken }
  | { kind: 'unknown' } // Token not found in DB.
  | { kind: 'revoked'; token: RefreshToken } // Replay attempt.
  | { kind: 'expired'; token: RefreshToken };

/**
 * Look up a presented refresh token by hash. Does **not** mutate state —
 * the caller (rotateRefreshToken) wraps this in a transaction with the
 * revoke + issue.
 */
export async function lookupRefreshToken(raw: string): Promise<RefreshOutcome> {
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.revokedAt !== null) return { kind: 'revoked', token };
  if (token.expiresAt < new Date()) return { kind: 'expired', token };
  return { kind: 'ok', token };
}

/**
 * Atomically revoke the presented token and issue a replacement under the
 * same end-user. The new token is linked back via `replacedById`.
 *
 * Caller is responsible for having checked `lookupRefreshToken` returned
 * `{ kind: 'ok' }`. We re-check the revoke condition inside the transaction
 * so concurrent rotation attempts don't both succeed (the second one finds
 * `revokedAt !== null` and bails).
 */
export async function rotateRefreshToken(
  presented: RefreshToken,
): Promise<IssuedRefreshToken> {
  const raw = generateRawToken();
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS);

  return prisma.$transaction(async (tx) => {
    // Race-safe revoke. If someone else already rotated this token in a
    // concurrent request, our update count will be 0 and we bail.
    const revoked = await tx.refreshToken.updateMany({
      where: { id: presented.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) {
      throw new Error('REFRESH_TOKEN_RACE');
    }

    const replacement = await tx.refreshToken.create({
      data: {
        applicationId: presented.applicationId,
        endUserId: presented.endUserId,
        tokenHash,
        expiresAt,
        // Carry forward the originating device fingerprint so the
        // session list stays stable across rotations. A new device hitting
        // /refresh with a stolen token wouldn't update this anyway —
        // the rotation transaction is keyed off `presented.id`.
        userAgent: presented.userAgent,
        ip: presented.ip,
        // Carry the surface + client binding forward across rotations.
        kind: presented.kind,
        clientId: presented.clientId,
        // Carry the active org forward so it survives refresh (the refresh
        // handler re-confirms membership and clears it if the user left).
        activeOrganizationId: presented.activeOrganizationId,
      },
    });

    await tx.refreshToken.update({
      where: { id: presented.id },
      data: { replacedById: replacement.id },
    });

    return { raw, record: replacement };
  });
}

/**
 * Revoke a single refresh token. Idempotent — re-revoking is fine. Used
 * by sign-out.
 */
export async function revokeRefreshToken(raw: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashRefreshToken(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revoke every active refresh token for an end-user. Use case: password
 * change, account compromise, "sign out everywhere".
 */
export async function revokeAllForEndUser(endUserId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { endUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Revoke every active refresh token for an Application — the per-app session
 * kill-switch. Pair with an `Application.tokenGeneration` bump so live access
 * tokens (signed with the old derived key) also die immediately, not just the
 * refresh tokens. Returns the count revoked.
 */
export async function revokeAllForApplication(applicationId: string): Promise<number> {
  const result = await prisma.refreshToken.updateMany({
    where: { applicationId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Sessions list for /me/sessions. Returns only *active* (unrevoked,
 * unexpired) tokens, ordered newest-first. Token hashes are never
 * exposed; the `id` is the row id used by /me/sessions/:id DELETE.
 */
export interface SessionSummary {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export async function listActiveSessions(endUserId: string): Promise<SessionSummary[]> {
  const rows = await prisma.refreshToken.findMany({
    where: {
      endUserId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      userAgent: true,
      ip: true,
    },
  });
  return rows;
}

/**
 * Revoke a single session by row id, scoped to a user. Returns true iff a
 * row was actually flipped (idempotent across re-tries).
 */
export async function revokeSessionForEndUser(
  endUserId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await prisma.refreshToken.updateMany({
    where: { id: sessionId, endUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count === 1;
}
