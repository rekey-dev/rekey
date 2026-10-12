/**
 * Support cases: an operator puts an end-user account in support mode with a
 * set of capabilities, and it stays so until someone ends it.
 *
 * Open, change and end take the end-user row lock a ban takes, then the device
 * lock, in that order, so a case is never written against a ban, an erasure, a
 * delete, or a device release or block that is half done. The partial unique index
 * `support_cases_end_user_open_key` is the backstop for one open case per
 * end-user.
 *
 * The reason is operator-only free text. It is stored on the case row and
 * nowhere else: not in a webhook, not in security event metadata.
 */

import type { Prisma, SupportCase } from '@prisma/client';
import type { SupportCaseClosedCause, SupportCaseDto } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { withActorEmails } from '../../lib/security-events.js';
import { lockDevices } from '../devices/devices.service.js';
import {
  endUserNotFound,
  lockEndUser,
  normaliseOperatorText,
  REASON_FIX,
  type LockedEndUser,
} from '../end-user-bans/end-user-bans.service.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { assertCapabilitiesInCatalogue } from './support-capabilities.service.js';
import { noteCountsFor, notesFor } from './support-case-notes.js';
import {
  announceOpenedIn,
  changeCaseIn,
  closeCaseIn,
  lockOpenCase,
  notOpen,
  type CaseChange,
  type SupportActor,
} from './support-case-writes.js';

export const SUPPORT_REASON_MAX = 500;
export const SUPPORT_CAPABILITIES_MAX = 32;
export const SUPPORT_DEVICES_MAX = 20;

const HISTORY_LIMIT = 20;
const EVENTS_LIMIT = 50;
const EVENT_TYPES = ['end_user.support_opened', 'end_user.support_updated', 'end_user.support_closed'] as const;

export interface SupportCaseEvent {
  id: string;
  type: (typeof EVENT_TYPES)[number];
  actorType: string;
  actorId: string | null;
  actorEmail: string | null;
  metadata: Prisma.JsonValue;
  createdAt: string;
}

function normaliseCapabilities(raw: readonly string[]): string[] {
  const names = [...new Set(raw)].sort();
  if (names.length === 0 || names.length > SUPPORT_CAPABILITIES_MAX) {
    throw new RekeyError({
      statusCode: 400,
      code: 'SUPPORT_CAPABILITIES_REQUIRED',
      message: `A support case carries 1 to ${SUPPORT_CAPABILITIES_MAX} capabilities; this request named ${names.length}.`,
      fix: 'Send `capabilities` with at least one name from GET .../support-capabilities. To turn support mode off, end the case (POST .../end-users/:euid/support/end).',
    });
  }
  return names;
}

/** Sorted and de-duplicated. A list that names no device is refused: it would cover none. */
function normaliseDeviceIds(raw: readonly string[]): string[] {
  const ids = [...new Set(raw)].sort();
  if (ids.length > 0) return ids;
  throw new RekeyError({
    statusCode: 400,
    code: 'SUPPORT_CASE_DEVICES_EMPTY',
    message: 'An empty `deviceIds` list would leave the case covering no device.',
    fix:
      'Send at least one device id. To cover every device instead, leave `deviceIds` out when opening a case ' +
      '(POST), or send `"deviceIds": null` when changing one (PATCH).',
  });
}

function alreadyOpen(caseId: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'SUPPORT_CASE_ALREADY_OPEN',
    message: `This end-user already has an open support case ("${caseId}").`,
    fix: 'Change it with PATCH .../end-users/:euid/support, or end it with POST .../end-users/:euid/support/end and open a new one.',
    details: { caseId },
  });
}

function assertMayHaveCase(user: LockedEndUser): void {
  if (user.erased_at !== null) {
    throw new RekeyError({
      statusCode: 410,
      code: 'END_USER_ERASED',
      message: 'That end-user was erased; a support case cannot be opened on the tombstone.',
      fix: 'An erased account can never sign in again, so there is no session for support mode to apply to.',
    });
  }
  if (user.banned_at !== null) {
    throw new RekeyError({
      statusCode: 403,
      code: 'END_USER_BANNED',
      message: 'That end-user is banned; a support case cannot be opened on them.',
      fix: 'Lift the ban first (POST /api/v1/tenant/applications/:id/end-users/:euid/unban), then open the case.',
    });
  }
}

async function assertOwnActiveDevices(
  tx: Prisma.TransactionClient,
  applicationId: string,
  endUserId: string,
  deviceIds: readonly string[],
): Promise<void> {
  const rows = await tx.device.findMany({
    where: { id: { in: [...deviceIds] }, applicationId, endUserId },
    select: { id: true, status: true },
  });
  const status = new Map(rows.map((d) => [d.id, d.status]));
  const missing = deviceIds.find((id) => !status.has(id));
  if (missing !== undefined) {
    throw new RekeyError({
      statusCode: 404,
      code: 'SUPPORT_CASE_DEVICE_NOT_FOUND',
      message: `Device "${missing.slice(0, 64)}" was not found for this end-user.`,
      fix: 'Send ids from GET .../end-users/:euid/devices?status=ACTIVE for this same end-user.',
      details: { deviceId: missing },
    });
  }
  const inactive = deviceIds.find((id) => status.get(id) !== 'ACTIVE');
  if (inactive !== undefined) {
    throw new RekeyError({
      statusCode: 409,
      code: 'SUPPORT_CASE_DEVICE_NOT_ACTIVE',
      message: `Device "${inactive}" is ${status.get(inactive)}; a support case can only name ACTIVE devices.`,
      fix:
        'Leave that device out. A released device is ACTIVE again once the end-user signs in on it; ' +
        'a blocked one must be unblocked first (POST .../devices/:deviceId/unblock), which leaves it released.',
      details: { deviceId: inactive, status: status.get(inactive) },
    });
  }
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v) => b.includes(v));
}

async function toDtos(rows: SupportCase[]): Promise<SupportCaseDto[]> {
  const operatorIds = [...new Set(rows.flatMap((r) => [r.openedBy, r.closedBy]).filter((id): id is string => id !== null))];
  const endUserIds = [...new Set(rows.map((r) => r.endUserId))];
  const [operators, endUsers] = await Promise.all([
    operatorIds.length > 0
      ? prisma.tenantUser.findMany({ where: { id: { in: operatorIds } }, select: { id: true, email: true } })
      : [],
    endUserIds.length > 0
      ? prisma.endUser.findMany({
          where: { id: { in: endUserIds }, erasedAt: null },
          select: { id: true, email: true },
        })
      : [],
  ]);
  const operatorEmail = new Map(operators.map((o) => [o.id, o.email]));
  const endUserEmail = new Map(endUsers.map((u) => [u.id, u.email]));
  return rows.map((r) => ({
    id: r.id,
    applicationId: r.applicationId,
    endUserId: r.endUserId,
    endUserEmail: endUserEmail.get(r.endUserId) ?? null,
    status: r.status,
    capabilities: r.capabilities,
    scope: r.scope,
    deviceIds: r.deviceIds,
    reason: r.reason,
    openedBy: r.openedBy,
    openedByEmail: r.openedBy ? operatorEmail.get(r.openedBy) ?? null : null,
    openedAt: r.openedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    closedBy: r.closedBy,
    closedByEmail: r.closedBy ? operatorEmail.get(r.closedBy) ?? null : null,
    closedAt: r.closedAt?.toISOString() ?? null,
    closedCause: r.closedCause as SupportCaseClosedCause | null,
  }));
}

async function toDto(row: SupportCase): Promise<SupportCaseDto> {
  return (await toDtos([row]))[0]!;
}

export const supportCasesService = {
  /**
   * Open a case. No `deviceIds` covers every device (`USER`); a list limits
   * the case to those devices (`DEVICES`), and an empty list is refused.
   *
   * @example
   *   const opened = await supportCasesService.open({
   *     applicationId, endUserId, capabilities: ['diagnostics.debug'], reason: 'Ticket 4412',
   *     actor: { actorType: 'operator', actorId: operatorUserId, tenantId, via: 'session' },
   *   });
   */
  async open(args: {
    applicationId: string;
    endUserId: string;
    capabilities: readonly string[];
    deviceIds?: readonly string[] | undefined;
    reason: string;
    actor: SupportActor;
  }): Promise<SupportCaseDto> {
    const { applicationId, endUserId, actor } = args;
    const capabilities = normaliseCapabilities(args.capabilities);
    const reason = normaliseOperatorText(args.reason, {
      max: SUPPORT_REASON_MAX,
      code: 'SUPPORT_REASON_INVALID',
      message: `A support case needs a reason of 1 to ${SUPPORT_REASON_MAX} characters.`,
      fix: REASON_FIX,
    });
    const deviceIds = args.deviceIds === undefined ? [] : normaliseDeviceIds(args.deviceIds);
    const result = await prisma.$transaction(async (tx) => {
      assertMayHaveCase(await lockEndUser(tx, applicationId, endUserId));
      await lockDevices(tx, applicationId, endUserId);
      const existing = await lockOpenCase(tx, applicationId, endUserId);
      if (existing) throw alreadyOpen(existing.id);
      await assertCapabilitiesInCatalogue(tx, applicationId, capabilities);
      await assertOwnActiveDevices(tx, applicationId, endUserId, deviceIds);
      const application = await tx.application.findUniqueOrThrow({
        where: { id: applicationId },
        select: { tenantId: true },
      });
      const row = await tx.supportCase.create({
        data: {
          applicationId,
          tenantId: application.tenantId,
          endUserId,
          capabilities,
          scope: deviceIds.length > 0 ? 'DEVICES' : 'USER',
          deviceIds,
          reason,
          openedBy: actor.actorType === 'operator' ? actor.actorId : null,
        },
      });
      return { row, deliveryIds: await announceOpenedIn(tx, row, actor) };
    });
    kickDeliveries(result.deliveryIds);
    return toDto(result.row);
  },

  /**
   * Change the open case. `deviceIds`: omitted leaves the scope alone, `null`
   * widens to every device, a list limits it to those devices. A request that
   * changes nothing writes nothing and announces nothing.
   *
   * @example
   *   const widened = await supportCasesService.update({ applicationId, endUserId, deviceIds: null, actor });
   */
  async update(args: {
    applicationId: string;
    endUserId: string;
    capabilities?: readonly string[] | undefined;
    deviceIds?: readonly string[] | null | undefined;
    actor: SupportActor;
  }): Promise<SupportCaseDto> {
    const { applicationId, endUserId, actor } = args;
    const capabilities = args.capabilities === undefined ? undefined : normaliseCapabilities(args.capabilities);
    const deviceIds = args.deviceIds ? normaliseDeviceIds(args.deviceIds) : args.deviceIds;
    const result = await prisma.$transaction(async (tx) => {
      await lockEndUser(tx, applicationId, endUserId);
      await lockDevices(tx, applicationId, endUserId);
      const open = await lockOpenCase(tx, applicationId, endUserId);
      if (!open) throw notOpen('change');
      const next: CaseChange = {
        capabilities: capabilities ?? open.capabilities,
        scope: deviceIds === undefined ? open.scope : deviceIds === null ? 'USER' : 'DEVICES',
        deviceIds: deviceIds === undefined ? open.deviceIds : deviceIds ?? [],
      };
      const capabilitiesChanged = !sameMembers(next.capabilities, open.capabilities);
      const devicesChanged = next.scope !== open.scope || !sameMembers(next.deviceIds, open.deviceIds);
      if (!capabilitiesChanged && !devicesChanged) return { row: open, deliveryIds: [] as string[] };
      if (capabilitiesChanged) await assertCapabilitiesInCatalogue(tx, applicationId, next.capabilities);
      if (devicesChanged) await assertOwnActiveDevices(tx, applicationId, endUserId, next.deviceIds);
      return changeCaseIn(tx, open, next, actor);
    });
    kickDeliveries(result.deliveryIds);
    return toDto(result.row);
  },

  /**
   * End the open case. Idempotent: `case` is null when none was open.
   *
   * @example
   *   const { case: closed } = await supportCasesService.end({ applicationId, endUserId, actor });
   */
  async end(args: {
    applicationId: string;
    endUserId: string;
    actor: SupportActor;
  }): Promise<{ case: SupportCaseDto | null }> {
    const { applicationId, endUserId, actor } = args;
    const result = await prisma.$transaction(async (tx) => {
      await lockEndUser(tx, applicationId, endUserId);
      await lockDevices(tx, applicationId, endUserId);
      const open = await lockOpenCase(tx, applicationId, endUserId);
      return open ? closeCaseIn(tx, open, 'operator', actor) : null;
    });
    if (!result) return { case: null };
    kickDeliveries(result.deliveryIds);
    return { case: await toDto(result.row) };
  },

  /**
   * The open case, the last 20 closed ones newest first, each with its
   * operator notes, and the support security events with the acting operator's
   * email. Erased end-users are readable: the history outlives the account.
   *
   * @example
   *   const { open, history, events } = await supportCasesService.get(applicationId, endUserId);
   */
  async get(
    applicationId: string,
    endUserId: string,
  ): Promise<{ open: SupportCaseDto | null; history: SupportCaseDto[]; events: SupportCaseEvent[] }> {
    const endUser = await prisma.endUser.findUnique({ where: { id: endUserId }, select: { applicationId: true } });
    if (!endUser || endUser.applicationId !== applicationId) throw endUserNotFound(endUserId);
    const [open, closed, events] = await Promise.all([
      prisma.supportCase.findFirst({ where: { applicationId, endUserId, status: 'OPEN' } }),
      prisma.supportCase.findMany({
        where: { applicationId, endUserId, status: 'CLOSED' },
        // One end-user's cases never overlap, so this is also newest closed first.
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_LIMIT,
      }),
      prisma.securityEvent.findMany({
        where: { applicationId, subjectEndUserId: endUserId, type: { in: [...EVENT_TYPES] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EVENTS_LIMIT,
      }),
    ]);
    const rows = [...(open ? [open] : []), ...closed];
    const caseIds = rows.map((r) => r.id);
    const [dtos, notes, noteCounts, named] = await Promise.all([
      toDtos(rows),
      notesFor(caseIds),
      noteCountsFor(caseIds),
      withActorEmails(events),
    ]);
    const cases = dtos.map((c) => ({ ...c, notes: notes.get(c.id) ?? [], noteCount: noteCounts.get(c.id) ?? 0 }));
    return {
      open: open ? cases[0]! : null,
      history: open ? cases.slice(1) : cases,
      events: named.map((e) => ({
        id: e.id,
        type: e.type as SupportCaseEvent['type'],
        actorType: e.actorType,
        actorId: e.actorId,
        actorEmail: e.actorEmail,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  },

  /**
   * A page of an Application's cases, each with its `noteCount` and no note
   * bodies. Open cases come oldest first, so the ones most likely forgotten
   * lead; closed cases come most recently opened first.
   *
   * @example
   *   const { items, total } = await supportCasesService.list(applicationId, { status: 'OPEN', take: 50, skip: 0 });
   */
  async list(
    applicationId: string,
    opts: { status: SupportCase['status']; endUserId?: string | undefined; take: number; skip: number },
  ): Promise<{ items: SupportCaseDto[]; total: number }> {
    const where: Prisma.SupportCaseWhereInput = {
      applicationId,
      status: opts.status,
      ...(opts.endUserId !== undefined && { endUserId: opts.endUserId }),
    };
    const [rows, total] = await Promise.all([
      prisma.supportCase.findMany({
        where,
        orderBy: opts.status === 'OPEN' ? [{ openedAt: 'asc' }, { id: 'asc' }] : [{ openedAt: 'desc' }, { id: 'desc' }],
        take: opts.take,
        skip: opts.skip,
      }),
      prisma.supportCase.count({ where }),
    ]);
    const [items, noteCounts] = await Promise.all([toDtos(rows), noteCountsFor(rows.map((r) => r.id))]);
    return { items: items.map((c) => ({ ...c, noteCount: noteCounts.get(c.id) ?? 0 })), total };
  },
};
