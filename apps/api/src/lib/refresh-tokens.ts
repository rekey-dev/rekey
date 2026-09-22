/**
 * Refresh token issuance, verification, rotation, revocation.
 *
 * Lifecycle:
 *   1. Sign-up / sign-in mints a refresh token alongside the access token.
 *   2. When the access token expires, the caller exchanges the refresh
 *      token via POST /api/v1/auth/refresh. The presented refresh is
 *      revoked (revokedAt set) and a new {access, refresh} pair is issued.
 *   3. `replacedById` chains the rotation history. A presented-but-revoked
 *      refresh is *replay*, we reject the call.
 *
 * Storage: SHA-256 hash of the raw token, hash-only DB (same model as
 * ApiKey). Refresh tokens are 32 bytes of CSPRNG entropy, fast hash is
 * correct, Argon2 is for user-chosen passwords (see lib/passwords.ts).
 *
 * Lifetime: END_USER_REFRESH_TOKEN_TTL_DAYS (default 30), sliding: each
 * rotation issues a fresh full window.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { RefreshToken } from '@prisma/client';
import { prisma } from './prisma.js';
import { env } from '../config/env.js';

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_LIFETIME_MS = env.END_USER_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

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
  /** For `kind: 'mcp'`, the OAuth client_id the token is bound to. */
  clientId?: string | null;
  /**
   * For `kind: 'mcp'`, the scopes granted at consent (space-separated,
   * RFC 6749). The refresh grant re-issues this exact string, so a chain can
   * never widen (or drop) what the end-user approved. Sessions have no scope
   * and leave it null.
   */
  scope?: string | null;
  /** Active organization for this session, re-emitted as the `oid` claim on refresh. */
  activeOrganizationId?: string | null;
  /**
   * For `kind: 'mcp'`, the organization the grant was bound to at consent.
   * Unlike `activeOrganizationId` this is not a hint: the MCP refresh grant
   * refuses a chain whose end-user no longer belongs to it.
   */
  grantOrganizationId?: string | null;
  /**
   * Device the session was minted on (`devices.id`), when the client sent a
   * fingerprint. Carried across rotations; the refresh grant refuses a
   * different fingerprint for a bound chain (see auth.service `refresh`).
   */
  deviceId?: string | null;
}

/**
 * Mint a new refresh token for an end-user. Stores only the hash; the raw
 * value is the *only* time the caller can read it.
 *
 * The optional UA/IP are captured so `/me/sessions` can render a device
 * list. They're hints, not security primitives, cookie cloning across
 * devices won't change the stored values, so don't use them for binding.
 */
export async function issueRefreshToken(
  applicationId: string,
  endUserId: string,
  options: IssueRefreshTokenOptions = {},
): Promise<IssuedRefreshToken> {
  const raw = generateRawToken();
  // Truncate UA at 512 chars, some clients send egregious strings (especially
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
      scope: options.scope ?? null,
      activeOrganizationId: options.activeOrganizationId ?? null,
      grantOrganizationId: options.grantOrganizationId ?? null,
      deviceId: options.deviceId ?? null,
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
 * Look up a presented refresh token by hash. Does **not** mutate state,
 * the caller (rotateRefreshToken) wraps this in a transaction with the
 * revoke + issue.
 */
export async function lookupRefreshToken(raw: string): Promise<RefreshOutcome> {
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(raw) },
  });
  if (!token) return { kind: 'unknown' };
  if (token.revokedAt !== null) return { kind: 'revoked', token };
  if (token.expiresAt <= new Date()) return { kind: 'expired', token };
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
        // /refresh with a stolen token wouldn't update this anyway,
        // the rotation transaction is keyed off `presented.id`.
        userAgent: presented.userAgent,
        ip: presented.ip,
        // Carry the surface + client binding forward across rotations, and the
        // granted scope with them, a rotation is a re-issue of the SAME grant,
        // so it must not be an opportunity to change what it covers.
        kind: presented.kind,
        clientId: presented.clientId,
        scope: presented.scope,
        // Carry the active org forward so it survives refresh (the refresh
        // handler re-confirms membership and clears it if the user left).
        activeOrganizationId: presented.activeOrganizationId,
        // The MCP organization binding is part of the grant, like `scope`:
        // a rotation re-issues the same grant and cannot drop or change it.
        grantOrganizationId: presented.grantOrganizationId,
        // And the device: a rotation is the same session on the same machine.
        // The refresh handler is what refuses a rotation presented from a
        // different fingerprint; here the binding is simply preserved.
        deviceId: presented.deviceId,
        // Same session: the access token minted from this row carries the
        // same `sid`, so a later single-session revoke reaches it.
        sessionId: presented.sessionId,
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
 * Revoke a single refresh token. Idempotent, re-revoking is fine. Used
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
  // Refresh tokens are revoked row by row; the access tokens they paired with
  // are refused from this instant by the session middleware (see
  // EndUser.sessionsInvalidBefore), so the caller's remaining access token
  // does not ride out its lifetime.
  await prisma.endUser.updateMany({ where: { id: endUserId }, data: { sessionsInvalidBefore: new Date() } });
  const result = await prisma.refreshToken.updateMany({
    where: { endUserId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Revoke every active refresh token for an Application. Returns the count revoked.
 *
 * UNUSED, do not reach for this as the session kill-switch. That is
 * `applicationsService.rotateSessions` (route `POST /tenant/applications/:id/
 * rotate-sessions`), which bumps `Application.tokenGeneration` AND revokes the
 * refresh tokens in ONE transaction. Doing the two halves separately is the
 * failure mode worth avoiding: revoke without the bump and outstanding access
 * tokens keep working until their expiry; bump without the revoke and clients
 * refresh straight back in.
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
  /** Bound device, or null for sessions minted without a fingerprint. */
  deviceId: string | null;
}

export async function listActiveSessions(
  endUserId: string,
  opts: { take?: number; skip?: number } = {},
): Promise<{ items: SessionSummary[]; total: number }> {
  // One `now` for both queries. Two `new Date()` calls straddle the boundary
  // for any session expiring in the microseconds between them, and a `total`
  // computed against a different instant than the rows is exactly the kind of
  // off-by-one that makes a pager render a page that is not there.
  const now = new Date();
  const where = { endUserId, revokedAt: null, expiresAt: { gt: now } };
  const [items, total] = await Promise.all([
    prisma.refreshToken.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        userAgent: true,
        ip: true,
        deviceId: true,
      },
      ...(opts.take !== undefined && { take: opts.take }),
      ...(opts.skip !== undefined && { skip: opts.skip }),
    }),
    prisma.refreshToken.count({ where }),
  ]);
  return { items, total };
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
  // No `sessionsInvalidBefore` stamp here. The stamp is per user, so it would
  // end the access token of every OTHER session too, and our own clients do
  // not survive that (the panel and portal refresh during an RSC render where
  // the rotated cookie is lost, and a second tab's replay then trips reuse
  // detection). The revoked session's access token is refused by its `sid`
  // instead: this row is the newest of its family, now revoked.
  return result.count === 1;
}
