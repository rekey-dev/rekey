/**
 * Redeeming a workspace-bound operator invite by an operator who already has
 * an account. It answers on the same routes, and with the same codes, as a
 * workspace invitation (`/api/v1/tenant/invitations/preview` and `/accept`),
 * so the panel's accept-invite page serves both link kinds. A new operator
 * redeems the key at sign-up instead (`operator-signup-policy.ts`).
 */

import type { OperatorInvite, TenantMembership, TenantRole } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { OPERATOR_INVITE_PREFIX, hashOperatorInviteToken } from '../../lib/operator-invite.js';
import { issueTenantRefreshToken } from '../../lib/tenant-refresh-tokens.js';
import { issueTenantAccessToken } from '../../lib/tenant-jwt.js';

/** True for a raw token minted as an operator invite rather than a workspace invitation. */
export function isOperatorInviteToken(raw: string): boolean {
  return raw.startsWith(`${OPERATOR_INVITE_PREFIX}_`);
}

type BoundInvite = OperatorInvite & { tenantId: string; email: string; role: TenantRole };

function isBound(row: OperatorInvite): row is BoundInvite {
  return row.tenantId !== null && row.email !== null && row.role !== null;
}

const FRESH_INVITE_FIX = 'Ask the deployment administrator for a fresh invite.';

function notFound(): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'INVITATION_NOT_FOUND',
    message: 'Invitation token is unknown.',
    fix: FRESH_INVITE_FIX,
  });
}

function notUsable(): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'INVITATION_NOT_USABLE',
    message: 'Invitation is missing, revoked, or already accepted.',
    fix: FRESH_INVITE_FIX,
  });
}

function expired(): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'INVITATION_EXPIRED',
    message: 'This invitation has expired.',
    fix: FRESH_INVITE_FIX,
  });
}

function isExpired(row: OperatorInvite): boolean {
  return row.expiresAt !== null && row.expiresAt.getTime() <= Date.now();
}

/**
 * The workspace and role a bound key grants, without consuming it. An unbound
 * key (one that creates a workspace at sign-up) is not an invitation to
 * anything, so it reads as unknown here.
 *
 * @example
 * ```ts
 * const { tenantName, role } = await previewWorkspaceInvite('rp_opinv_…');
 * ```
 */
export async function previewWorkspaceInvite(rawToken: string): Promise<{
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  invitedEmail: string;
  expiresAt: Date;
}> {
  const row = await prisma.operatorInvite.findUnique({
    where: { tokenHash: hashOperatorInviteToken(rawToken) },
    include: { tenant: { select: { name: true } } },
  });
  if (!row || !isBound(row) || row.tenant === null || row.expiresAt === null) throw notFound();
  if (row.revokedAt) {
    throw new RekeyError({
      statusCode: 400,
      code: 'INVITATION_REVOKED',
      message: 'This invitation has been revoked.',
      fix: FRESH_INVITE_FIX,
    });
  }
  if (row.usedAt) {
    throw new RekeyError({
      statusCode: 400,
      code: 'INVITATION_ALREADY_ACCEPTED',
      message: 'This invitation has already been used.',
      fix: 'Sign in normally, you should already have access.',
    });
  }
  if (isExpired(row)) throw expired();
  return {
    tenantId: row.tenantId,
    tenantName: row.tenant.name,
    role: row.role,
    invitedEmail: row.email,
    expiresAt: row.expiresAt,
  };
}

/**
 * Join the signed-in operator to the workspace a bound key names, consume the
 * key, and return a session scoped to that workspace. The operator's email
 * must be the one the key was minted for, and the key is consumed under a
 * `usedAt IS NULL` guard so it joins at most once however many requests race.
 *
 * @example
 * ```ts
 * const { membership, accessToken } = await redeemWorkspaceInvite({ rawToken, tenantUserId });
 * ```
 */
export async function redeemWorkspaceInvite(args: { rawToken: string; tenantUserId: string }): Promise<{
  membership: TenantMembership;
  inviteId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.operatorInvite.findUnique({
      where: { tokenHash: hashOperatorInviteToken(args.rawToken) },
    });
    if (!row || !isBound(row) || row.revokedAt || row.usedAt) throw notUsable();
    if (isExpired(row)) throw expired();

    const operator = await tx.tenantUser.findUniqueOrThrow({ where: { id: args.tenantUserId } });
    if (operator.email.toLowerCase() !== row.email) {
      throw new RekeyError({
        statusCode: 403,
        code: 'INVITATION_EMAIL_MISMATCH',
        message: 'This invitation was issued to a different email address.',
        fix: 'Sign in as the invited email, then accept, or ask the deployment administrator to invite your address.',
      });
    }

    const consumed = await tx.operatorInvite.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date(), usedByTenantUserId: args.tenantUserId },
    });
    if (consumed.count !== 1) throw notUsable();

    const key = { tenantUserId_tenantId: { tenantUserId: args.tenantUserId, tenantId: row.tenantId } };
    const existing = await tx.tenantMembership.findUnique({ where: key });
    const membership =
      existing ??
      (await tx.tenantMembership.create({
        data: { tenantUserId: args.tenantUserId, tenantId: row.tenantId, role: row.role },
      }));

    const refresh = await issueTenantRefreshToken(args.tenantUserId, { activeTenantId: row.tenantId }, tx);
    const access = issueTenantAccessToken(args.tenantUserId, row.tenantId, membership.role, {
      sessionId: refresh.record.sessionId,
    });
    return {
      membership,
      inviteId: row.id,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.raw,
      refreshTokenExpiresAt: refresh.record.expiresAt,
    };
  });
}
