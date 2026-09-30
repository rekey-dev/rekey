/**
 * Operator ban of a whole end-user account.
 *
 * The ban is three columns on `EndUser`, read by every auth chokepoint that
 * already loads the row (`assertEndUserNotBanned` in modules/auth/auth.service.ts
 * and `liveGrantSubject` in modules/mcp/oauth.service.ts). Enforcement reads
 * only those columns. The `end_user.banned` / `end_user.unbanned` security
 * events are the history, written in the same transaction so a ban can never
 * exist without its record of who placed it.
 *
 * Revoking sessions here is cover, not the guarantee: a sign-in that passed
 * its checks just before the ban committed can still write a refresh row
 * afterwards. What stops that session is the ban check on its next use.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordSecurityEventIn, withActorEmails } from '../../lib/security-events.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';

export const BAN_REASON_MAX = 500;

export type OperatorVia = 'session' | 'token';

export interface BanActor {
  operatorUserId: string;
  tenantId: string | null;
  via: OperatorVia;
  ip: string | null;
  userAgent: string | null;
}

export interface BanState {
  banned: boolean;
  bannedAt: string | null;
  bannedBy: string | null;
  bannedByEmail: string | null;
  banReason: string | null;
}

export interface BanHistoryEntry {
  id: string;
  type: 'end_user.banned' | 'end_user.unbanned';
  actorId: string | null;
  actorEmail: string | null;
  reason: string | null;
  createdAt: string;
}

interface LockedRow {
  application_id: string;
  erased_at: Date | null;
  banned_at: Date | null;
  banned_by: string | null;
  ban_reason: string | null;
}

const HISTORY_TYPES = ['end_user.banned', 'end_user.unbanned'] as const;
const HISTORY_LIMIT = 50;

/**
 * Trimmed, control characters removed, 1..500. The reason is rendered in the
 * panel as plain text; stripping control characters keeps it one readable
 * block there and in CSV exports.
 */
export function normaliseBanReason(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length === 0 || cleaned.length > BAN_REASON_MAX) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BAN_REASON_INVALID',
      message: `A ban needs a reason of 1 to ${BAN_REASON_MAX} characters.`,
      fix: 'Send `reason` with a short note your team will understand later, for example the ticket it came from.',
    });
  }
  return cleaned;
}

/**
 * A security event's metadata as the banned person may see it: the operator's
 * ban reason is for the team only, so it is dropped from their DSAR export.
 *
 * @example
 *   withoutBanReason('end_user.banned', { endUserId, reason: 'fraud' }); // { endUserId }
 */
export function withoutBanReason(type: string, metadata: Prisma.JsonValue): Prisma.JsonValue {
  if (type !== 'end_user.banned' || metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }
  const rest = { ...metadata };
  delete rest.reason;
  return rest;
}

function notFound(endUserId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'END_USER_NOT_FOUND',
    message: `End-user "${endUserId}" not found in this Application.`,
    fix: 'List end-users to confirm the id.',
  });
}

function erased(): RekeyError {
  return new RekeyError({
    statusCode: 410,
    code: 'END_USER_ERASED',
    message: 'That end-user was erased; a ban no longer applies to the tombstone.',
    fix: 'An erased account can never sign in again, so there is nothing to ban or unban.',
  });
}

/**
 * Row lock on the end-user, so ban, unban and erasure are ordered against each
 * other and a repeated ban reads the state the previous one committed.
 */
async function lockEndUser(
  tx: Prisma.TransactionClient,
  applicationId: string,
  endUserId: string,
): Promise<LockedRow> {
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT application_id, erased_at, banned_at, banned_by, ban_reason
    FROM end_users WHERE id = ${endUserId} FOR UPDATE`;
  const row = rows[0];
  if (!row || row.application_id !== applicationId) throw notFound(endUserId);
  if (row.erased_at !== null) throw erased();
  return row;
}

async function withBannerEmail(row: {
  bannedAt: Date | null;
  bannedBy: string | null;
  banReason: string | null;
}): Promise<BanState> {
  const operator = row.bannedBy
    ? await prisma.tenantUser.findUnique({ where: { id: row.bannedBy }, select: { email: true } })
    : null;
  return {
    banned: row.bannedAt !== null,
    bannedAt: row.bannedAt?.toISOString() ?? null,
    bannedBy: row.bannedBy,
    bannedByEmail: operator?.email ?? null,
    banReason: row.banReason,
  };
}

export const endUserBansService = {
  /**
   * Ban the end-user. Ends every session, OAuth/MCP grant, impersonation and
   * outstanding sign-in link, then refuses every sign-in until `unban`.
   * Banning a banned user is a no-op that keeps the original record; to change
   * the reason, lift the ban and ban again so both steps are audited.
   *
   * @example
   *   const r = await endUserBansService.ban({
   *     applicationId, endUserId, reason: 'Chargeback fraud, ticket 4412',
   *     actor: { operatorUserId, tenantId, via: 'session', ip, userAgent },
   *   });
   *   r.alreadyBanned; // false on the first ban
   */
  async ban(args: {
    applicationId: string;
    endUserId: string;
    reason: string;
    actor: BanActor;
  }): Promise<{ state: BanState; alreadyBanned: boolean; sessionsRevoked: number }> {
    const reason = normaliseBanReason(args.reason);
    const { applicationId, endUserId, actor } = args;
    const result = await prisma.$transaction(async (tx) => {
      const current = await lockEndUser(tx, applicationId, endUserId);
      if (current.banned_at !== null) {
        return {
          row: { bannedAt: current.banned_at, bannedBy: current.banned_by, banReason: current.ban_reason },
          alreadyBanned: true,
          sessionsRevoked: 0,
          deliveryIds: [] as string[],
        };
      }
      const now = new Date();
      const updated = await tx.endUser.update({
        where: { id: endUserId },
        data: {
          bannedAt: now,
          bannedBy: actor.operatorUserId,
          banReason: reason,
          sessionsInvalidBefore: now,
        },
        select: { bannedAt: true, bannedBy: true, banReason: true },
      });
      const [revoked] = await Promise.all([
        // Every kind, `mcp` included: OAuth/OIDC refresh chains are sessions too.
        tx.refreshToken.updateMany({ where: { endUserId, revokedAt: null }, data: { revokedAt: now } }),
        // Expired, not deleted: erasure and the DSAR export find a pending
        // email-change address through these rows.
        tx.magicLinkToken.updateMany({ where: { endUserId, consumedAt: null }, data: { expiresAt: now } }),
        tx.passwordResetToken.deleteMany({ where: { endUserId } }),
        tx.emailVerificationToken.updateMany({ where: { endUserId, consumedAt: null }, data: { expiresAt: now } }),
        tx.oAuthAuthCode.deleteMany({ where: { endUserId, consumedAt: null } }),
        tx.impersonationAudit.updateMany({ where: { endUserId, endedAt: null }, data: { endedAt: now } }),
      ]);
      const deliveryIds = await enqueueEvent(tx, {
        applicationId,
        type: 'user.banned',
        data: { user: { id: endUserId, bannedAt: now.toISOString() }, sessionsRevoked: revoked.count },
      });
      await recordSecurityEventIn(tx, {
        type: 'end_user.banned',
        actorType: 'operator',
        actorId: actor.operatorUserId,
        tenantId: actor.tenantId,
        applicationId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: { endUserId, reason, sessionsRevoked: revoked.count, via: actor.via },
      });
      return { row: updated, alreadyBanned: false, sessionsRevoked: revoked.count, deliveryIds };
    });
    kickDeliveries(result.deliveryIds);
    return {
      state: await withBannerEmail(result.row),
      alreadyBanned: result.alreadyBanned,
      sessionsRevoked: result.sessionsRevoked,
    };
  },

  /**
   * Lift the ban. Restores nothing: sessions the ban ended stay ended, and the
   * person signs in again with whatever method they had. Idempotent.
   *
   * @example
   *   const r = await endUserBansService.unban({ applicationId, endUserId, actor });
   *   r.wasBanned; // false when there was no ban to lift
   */
  async unban(args: {
    applicationId: string;
    endUserId: string;
    actor: BanActor;
  }): Promise<{ state: BanState; wasBanned: boolean }> {
    const { applicationId, endUserId, actor } = args;
    const result = await prisma.$transaction(async (tx) => {
      const current = await lockEndUser(tx, applicationId, endUserId);
      if (current.banned_at === null) return { wasBanned: false, deliveryIds: [] as string[] };
      await tx.endUser.update({
        where: { id: endUserId },
        data: { bannedAt: null, bannedBy: null, banReason: null },
      });
      const deliveryIds = await enqueueEvent(tx, {
        applicationId,
        type: 'user.unbanned',
        data: { user: { id: endUserId, bannedAt: null } },
      });
      await recordSecurityEventIn(tx, {
        type: 'end_user.unbanned',
        actorType: 'operator',
        actorId: actor.operatorUserId,
        tenantId: actor.tenantId,
        applicationId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        metadata: {
          endUserId,
          via: actor.via,
          bannedAt: current.banned_at.toISOString(),
          bannedBy: current.banned_by,
        },
      });
      return { wasBanned: true, deliveryIds };
    });
    kickDeliveries(result.deliveryIds);
    return {
      state: { banned: false, bannedAt: null, bannedBy: null, bannedByEmail: null, banReason: null },
      wasBanned: result.wasBanned,
    };
  },

  /**
   * Current ban state plus the ban and unban history, newest first. Erased
   * users are readable here: the history outlives the account.
   *
   * @example
   *   const { state, history } = await endUserBansService.get(applicationId, endUserId);
   */
  async get(
    applicationId: string,
    endUserId: string,
  ): Promise<{ state: BanState; history: BanHistoryEntry[] }> {
    const row = await prisma.endUser.findUnique({
      where: { id: endUserId },
      select: { applicationId: true, bannedAt: true, bannedBy: true, banReason: true },
    });
    if (!row || row.applicationId !== applicationId) throw notFound(endUserId);
    const events = await prisma.securityEvent.findMany({
      where: { applicationId, subjectEndUserId: endUserId, type: { in: [...HISTORY_TYPES] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_LIMIT,
    });
    const named = await withActorEmails(events);
    return {
      state: await withBannerEmail(row),
      history: named.map((e) => {
        const metadata = (e.metadata ?? {}) as { reason?: unknown };
        return {
          id: e.id,
          type: e.type as BanHistoryEntry['type'],
          actorId: e.actorId,
          actorEmail: e.actorEmail,
          reason: typeof metadata.reason === 'string' ? metadata.reason : null,
          createdAt: e.createdAt.toISOString(),
        };
      }),
    };
  },
};
