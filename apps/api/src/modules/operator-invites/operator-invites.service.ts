/**
 * Super-admin management of operator-invite keys (OPERATOR_SIGNUP_MODE='invite').
 *
 * Mint / list / revoke. The consume-at-signup half lives in
 * `tenant-auth/operator-signup-policy.ts` — this module never issues sessions
 * or creates operators; it only manages the keys.
 */

import type { OperatorInvite } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { generateOperatorInviteToken } from '../../lib/operator-invite.js';

/** A key's lifecycle state, derived from its timestamps. */
export type OperatorInviteStatus = 'active' | 'used' | 'revoked' | 'expired';

export interface PublicOperatorInvite {
  id: string;
  tokenPrefix: string;
  note: string | null;
  status: OperatorInviteStatus;
  expiresAt: string | null;
  usedAt: string | null;
  usedByTenantUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function deriveStatus(row: OperatorInvite, now: number): OperatorInviteStatus {
  if (row.revokedAt) return 'revoked';
  if (row.usedAt) return 'used';
  if (row.expiresAt && row.expiresAt.getTime() <= now) return 'expired';
  return 'active';
}

/** Redact a row to its public shape — never exposes `tokenHash`. */
export function toPublicOperatorInvite(row: OperatorInvite): PublicOperatorInvite {
  return {
    id: row.id,
    tokenPrefix: row.tokenPrefix,
    note: row.note,
    status: deriveStatus(row, Date.now()),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    usedByTenantUserId: row.usedByTenantUserId,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const operatorInvitesService = {
  /**
   * Mint a single-use invite key. Returns the public row + the raw key, which
   * is shown to the super-admin EXACTLY ONCE (only its hash is stored).
   */
  async mint(input: {
    note?: string | undefined;
    expiresAt?: Date | undefined;
  }): Promise<{ invite: PublicOperatorInvite; rawToken: string }> {
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= Date.now()) {
      throw new RekeyError({
        statusCode: 400,
        code: 'OPERATOR_INVITE_EXPIRY_IN_PAST',
        message: `expiresAt (${input.expiresAt.toISOString()}) is not in the future — the key would be dead on arrival.`,
        fix: 'Pass a future expiresAt, or omit it for a non-expiring key.',
      });
    }
    const { raw, hash, prefix } = generateOperatorInviteToken();
    const row = await prisma.operatorInvite.create({
      data: {
        tokenPrefix: prefix,
        tokenHash: hash,
        createdByAdmin: true,
        ...(input.note !== undefined && { note: input.note }),
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      },
    });
    return { invite: toPublicOperatorInvite(row), rawToken: raw };
  },

  /** List keys newest-first (paginated). Never returns `tokenHash`. */
  async list(args: { take: number; skip: number }): Promise<{ items: PublicOperatorInvite[]; total: number }> {
    const [rows, total] = await Promise.all([
      prisma.operatorInvite.findMany({
        orderBy: { createdAt: 'desc' },
        take: args.take,
        skip: args.skip,
      }),
      prisma.operatorInvite.count(),
    ]);
    return { items: rows.map(toPublicOperatorInvite), total };
  },

  /**
   * Revoke an unused key. Idempotent on an already-revoked key. Refuses to
   * revoke a key that was already consumed (it already minted its operator —
   * revoking would be misleading).
   */
  async revoke(id: string): Promise<PublicOperatorInvite> {
    const row = await prisma.operatorInvite.findUnique({ where: { id } });
    if (!row) {
      throw new RekeyError({
        statusCode: 404,
        code: 'OPERATOR_INVITE_NOT_FOUND',
        message: 'No operator invite with that id.',
        fix: 'Check the id against GET /api/v1/admin/operator-invites.',
      });
    }
    if (row.usedAt) {
      throw new RekeyError({
        statusCode: 409,
        code: 'OPERATOR_INVITE_ALREADY_USED',
        message: 'That invite key was already used to create an operator and cannot be revoked.',
        fix: 'Manage the resulting operator account directly if access needs to be removed.',
      });
    }
    if (row.revokedAt) return toPublicOperatorInvite(row);
    const updated = await prisma.operatorInvite.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return toPublicOperatorInvite(updated);
  },
};
