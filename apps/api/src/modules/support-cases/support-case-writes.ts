/**
 * The writes to a support case that happen inside someone else's transaction:
 * a ban, an erasure or a delete closing it, a device release or block
 * shrinking it. The case
 * service uses the same functions, so every close and every change writes the
 * same webhook and the same security event whoever caused it.
 *
 * Each caller reads the open case through `lockOpenCase`, which takes the row
 * lock. A ban holds the end-user lock and a device release holds the device
 * lock, so without the row lock the two could both act on one open case.
 *
 * The operator's reason is never read here: it stays on the row.
 */

import type { Prisma, SupportCase } from '@prisma/client';
import type { SupportCaseClosedCause, SupportWebhookState } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { recordSecurityEventIn, type SecurityActorType } from '../../lib/security-events.js';
import type { BanActor } from '../end-user-bans/end-user-bans.service.js';
import { enqueueEvent } from '../webhooks/webhook.service.js';

export interface SupportActor {
  actorType: SecurityActorType;
  /** A TenantUser id for an operator, the end-user id or API key id otherwise. */
  actorId: string | null;
  tenantId: string | null;
  /** How the operator was authenticated. Absent when the actor is not an operator request. */
  via?: 'session' | 'token' | 'operator_mcp';
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * @example
 *   const actor = operatorSupportActor(operatorActorOf(req));
 */
export function operatorSupportActor(operator: BanActor): SupportActor {
  return {
    actorType: 'operator',
    actorId: operator.operatorUserId,
    tenantId: operator.tenantId,
    via: operator.via,
    ip: operator.ip,
    userAgent: operator.userAgent,
  };
}

export interface CaseChange {
  capabilities: string[];
  scope: SupportCase['scope'];
  deviceIds: string[];
}

export function supportWebhookState(row: SupportCase): SupportWebhookState {
  const open = row.status === 'OPEN';
  return {
    caseId: row.id,
    active: open,
    capabilities: open ? row.capabilities : [],
    scope: row.scope,
    deviceIds: row.deviceIds,
    since: row.openedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.closedCause !== null && { closedCause: row.closedCause as SupportCaseClosedCause }),
  };
}

function enqueueSupportEvent(
  tx: Prisma.TransactionClient,
  type: 'support.opened' | 'support.updated' | 'support.closed',
  row: SupportCase,
): Promise<string[]> {
  return enqueueEvent(tx, {
    applicationId: row.applicationId,
    type,
    data: { user: { id: row.endUserId }, support: { ...supportWebhookState(row) } },
  });
}

function recordSupportEvent(
  tx: Prisma.TransactionClient,
  type: 'end_user.support_opened' | 'end_user.support_updated' | 'end_user.support_closed',
  row: SupportCase,
  actor: SupportActor,
  metadata: Record<string, unknown>,
): Promise<void> {
  return recordSecurityEventIn(tx, {
    type,
    actorType: actor.actorType,
    actorId: actor.actorId,
    tenantId: actor.tenantId ?? row.tenantId,
    applicationId: row.applicationId,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
    metadata: {
      endUserId: row.endUserId,
      caseId: row.id,
      ...(actor.via !== undefined && { via: actor.via }),
      ...metadata,
    },
  });
}

export function notOpen(action: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'SUPPORT_CASE_NOT_OPEN',
    message: `This end-user has no open support case to ${action}.`,
    fix: 'Open one with POST .../end-users/:euid/support (capabilities and reason).',
  });
}

/** The end-user's open case with its row locked, or null. */
export async function lockOpenCase(
  tx: Prisma.TransactionClient,
  applicationId: string,
  endUserId: string,
): Promise<SupportCase | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM support_cases
    WHERE application_id = ${applicationId} AND end_user_id = ${endUserId} AND status = 'OPEN'
    FOR UPDATE`;
  const id = rows[0]?.id;
  return id === undefined ? null : tx.supportCase.findUnique({ where: { id } });
}

/** Announce a case that was just inserted in `tx`. Returns webhook delivery ids. */
export async function announceOpenedIn(
  tx: Prisma.TransactionClient,
  row: SupportCase,
  actor: SupportActor,
): Promise<string[]> {
  await recordSupportEvent(tx, 'end_user.support_opened', row, actor, {
    capabilities: row.capabilities,
    scope: row.scope,
    deviceIds: row.deviceIds,
  });
  return enqueueSupportEvent(tx, 'support.opened', row);
}

/** Apply a change to a locked open case and announce it. */
export async function changeCaseIn(
  tx: Prisma.TransactionClient,
  before: SupportCase,
  next: CaseChange,
  actor: SupportActor,
): Promise<{ row: SupportCase; deliveryIds: string[] }> {
  const row = await tx.supportCase.update({
    where: { id: before.id },
    data: { ...next, updatedAt: new Date() },
  });
  await recordSupportEvent(tx, 'end_user.support_updated', row, actor, {
    capabilitiesBefore: before.capabilities,
    capabilitiesAfter: row.capabilities,
    scopeBefore: before.scope,
    scopeAfter: row.scope,
    deviceIdsBefore: before.deviceIds,
    deviceIdsAfter: row.deviceIds,
  });
  return { row, deliveryIds: await enqueueSupportEvent(tx, 'support.updated', row) };
}

/**
 * Close a locked open case and announce it. `updatedAt` moves to the close
 * time, so `support.closed` is newer than every event before it.
 */
export async function closeCaseIn(
  tx: Prisma.TransactionClient,
  before: SupportCase,
  cause: SupportCaseClosedCause,
  actor: SupportActor,
): Promise<{ row: SupportCase; deliveryIds: string[] }> {
  const closedAt = new Date();
  const row = await tx.supportCase.update({
    where: { id: before.id },
    data: {
      status: 'CLOSED',
      closedAt,
      updatedAt: closedAt,
      closedBy: actor.actorType === 'operator' ? actor.actorId : null,
      closedCause: cause,
    },
  });
  await recordSupportEvent(tx, 'end_user.support_closed', row, actor, {
    capabilities: before.capabilities,
    scope: before.scope,
    deviceIds: before.deviceIds,
    cause,
  });
  return { row, deliveryIds: await enqueueSupportEvent(tx, 'support.closed', row) };
}

/**
 * Close the end-user's open case, if there is one. For a ban, an erasure and
 * a delete, which already hold the end-user lock.
 *
 * @example
 *   const deliveryIds = await closeOpenCaseIn(tx, { applicationId, endUserId, cause: 'banned', actor });
 */
export async function closeOpenCaseIn(
  tx: Prisma.TransactionClient,
  args: { applicationId: string; endUserId: string; cause: SupportCaseClosedCause; actor: SupportActor },
): Promise<string[]> {
  const open = await lockOpenCase(tx, args.applicationId, args.endUserId);
  if (!open) return [];
  return (await closeCaseIn(tx, open, args.cause, args.actor)).deliveryIds;
}

/**
 * Take a device that just stopped being ACTIVE (released or blocked) out of
 * the end-user's open case. Nothing puts it back: not an unblock, not a later
 * sign-in. A case left with no device closes, because widening it to every
 * device is not what the operator chose. The caller holds the device lock.
 *
 * @example
 *   const deliveryIds = await removeInactiveDeviceIn(tx, { applicationId, endUserId, deviceId, actor });
 */
export async function removeInactiveDeviceIn(
  tx: Prisma.TransactionClient,
  args: { applicationId: string; endUserId: string; deviceId: string; actor: SupportActor },
): Promise<string[]> {
  const open = await lockOpenCase(tx, args.applicationId, args.endUserId);
  if (!open || open.scope !== 'DEVICES' || !open.deviceIds.includes(args.deviceId)) return [];
  const remaining = open.deviceIds.filter((id) => id !== args.deviceId);
  if (remaining.length === 0) return (await closeCaseIn(tx, open, 'device_released', args.actor)).deliveryIds;
  const next = { capabilities: open.capabilities, scope: open.scope, deviceIds: remaining };
  return (await changeCaseIn(tx, open, next, args.actor)).deliveryIds;
}
