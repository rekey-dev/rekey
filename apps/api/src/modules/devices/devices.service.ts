/**
 * Devices, the machines an end-user signs in from.
 *
 * A device is an (application, end-user, fingerprint) triple. The fingerprint
 * is whatever the customer's client computes and is opaque here, exactly like
 * `LicenseActivation.machineFingerprint`: Rekey stores and compares the string,
 * never its parts. Uniqueness is per end-user, so the same fingerprint under
 * two accounts is two devices; cross-account reuse is a signal for the
 * security-events trail, not a constraint.
 *
 * `touch` is THE write path for the ACTIVE count. Sign-in and refresh go
 * through it, and it is the only place the device limit is enforced, for the
 * same reason `licenses.verify` keeps its seat check in one transaction: a
 * limit checked in two places is a limit that is wrong in at least one of
 * them. Licence verification does NOT touch: it links an activation to a
 * device that already exists for the holder and otherwise leaves devices
 * alone, so `max_devices` bounds session devices and licence machines
 * independently (see licenses.service.ts). The check-then-insert runs under
 * a per-(application, end-user) advisory lock so two concurrent sign-ins from
 * two new machines cannot both pass the count.
 *
 * The limit itself is not stored here. It is the `max_devices` FEATURE
 * entitlement resolved through the plan union (MAX across subscriptions, the
 * default plan supplying the free tier), so a plan upgrade raises the cap
 * without touching a device row. No entitlement means no cap, an Application
 * that never configured one sees no change from this module existing.
 *
 * Side effects (webhooks, security events) are emitted after the transaction
 * commits and never block the caller, the AGENTS.md rule.
 */

import type { Device, DeviceStatus, Prisma } from '@prisma/client';
import { DEVICE_LIMIT_FEATURE_KEY } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { entitlementsService } from '../billing/entitlements.service.js';
import { emitDetached } from '../webhooks/webhook.service.js';

export type { Device, DeviceStatus };

export interface TouchDeviceInput {
  applicationId: string;
  endUserId: string;
  /** Opaque client-computed identifier, 8–256 chars (validated at the route). */
  fingerprint: string;
  /** Human-readable hint; overwrites the stored label when present. */
  label?: string | null | undefined;
  /** Inbound IP at the time of the touch, for `lastSeenIp`. */
  ip?: string | null | undefined;
  /** Which path is touching the device, for the security-events trail. */
  via?: 'sign_in' | 'refresh';
}

export interface DeviceSummary {
  id: string;
  label: string | null;
  status: DeviceStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export type TouchDeviceOutcome =
  | { kind: 'ok'; device: Device; created: boolean; reactivated: boolean }
  /** The fingerprint is BLOCKED for this end-user. The caller must refuse. */
  | { kind: 'blocked'; device: Device }
  /**
   * A new (or previously released) device would exceed `max_devices`. The
   * current ACTIVE devices ride along so the client can offer "release one".
   */
  | { kind: 'limit_reached'; limit: number; devices: DeviceSummary[] };

/** What `preflight` answers: the refusals `touch` can return, or a clean `ok`. */
export type PreflightDeviceOutcome =
  | { kind: 'ok' }
  | { kind: 'blocked'; device: Device }
  | { kind: 'limit_reached'; limit: number; devices: DeviceSummary[] };

/** The webhook and security event a refused-by-limit attempt produces. */
function announceLimitReached(
  input: TouchDeviceInput,
  outcome: { limit: number; devices: DeviceSummary[] },
  ip: string | null,
): void {
  emitDetached({
    applicationId: input.applicationId,
    type: 'device.limit_reached',
    data: {
      endUserId: input.endUserId,
      limit: outcome.limit,
      fingerprint: input.fingerprint,
      devices: outcome.devices.map((d) => ({
        id: d.id,
        label: d.label,
        firstSeenAt: d.firstSeenAt.toISOString(),
        lastSeenAt: d.lastSeenAt.toISOString(),
      })),
    },
  });
  void recordSecurityEvent({
    type: 'user.device_limit_reached',
    actorType: 'end_user',
    actorId: input.endUserId,
    applicationId: input.applicationId,
    ip,
    metadata: { limit: outcome.limit, via: input.via ?? null },
  });
}

function lockKey(applicationId: string, endUserId: string): string {
  return `device:${applicationId}:${endUserId}`;
}

/**
 * Serialise every status write for one end-user's devices. `touch` holds
 * this across its count-then-write; `release`, `block` and `unblock` hold it
 * across their read-then-write so a block cannot land between a touch's read
 * of RELEASED and its write of ACTIVE (which would have flipped a just-blocked
 * device back to ACTIVE with `blockedAt` still set), and a release cannot be
 * lost to a touch that read ACTIVE a moment earlier.
 */
async function lockDevices(
  tx: Prisma.TransactionClient,
  applicationId: string,
  endUserId: string,
): Promise<void> {
  // `hashtextextended` gives a 64-bit key from the composite string; the
  // `device:` prefix keeps it from colliding with billing-binding locks that
  // hash their own strings into the same space.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(applicationId, endUserId)}, 0))`;
}

function summary(d: Device): DeviceSummary {
  return {
    id: d.id,
    label: d.label,
    status: d.status,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
  };
}

function devicePayload(d: Device): Record<string, unknown> {
  return {
    id: d.id,
    endUserId: d.endUserId,
    fingerprint: d.fingerprint,
    label: d.label,
    status: d.status,
    firstSeenAt: d.firstSeenAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    releasedAt: d.releasedAt?.toISOString() ?? null,
    blockedAt: d.blockedAt?.toISOString() ?? null,
  };
}

function notFound(deviceId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'DEVICE_NOT_FOUND',
    message: `Device "${deviceId}" was not found for this end-user.`,
    fix: 'List the end-user\'s devices to see what exists.',
  });
}

export const devicesService = {
  /**
   * The ACTIVE-device ceiling for one end-user, or `null` when their plans
   * grant no `max_devices` feature (uncapped).
   *
   * Resolved OUTSIDE any transaction on purpose: the entitlement union reads
   * plans, subscriptions and memberships through the global client, and doing
   * that while holding a transaction's connection is how a pool deadlocks
   * under load. The count that the limit is compared against is what gets
   * locked, not the limit.
   */
  async maxDevicesFor(applicationId: string, endUserId: string): Promise<number | null> {
    const { features } = await entitlementsService.resolveForEndUser(applicationId, endUserId);
    const v = features[DEVICE_LIMIT_FEATURE_KEY];
    // An operator who declared the feature as STRING "3" meant three, not
    // "no cap"; a value that is not a number at all means no cap.
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  },

  /**
   * Register or refresh a device for an end-user, enforcing the limit.
   *
   * - Known + ACTIVE → refresh `lastSeenAt` / `lastSeenIp` / `label`. Never
   *   consumes a slot, never fails on the limit.
   * - Known + BLOCKED → `blocked`. Nothing is written.
   * - Unknown, or known + RELEASED → needs a slot. Under the advisory lock the
   *   ACTIVE count is compared with `max_devices`; if there is room the row is
   *   inserted (or flipped back to ACTIVE in place), otherwise `limit_reached`.
   *
   * Returns an outcome rather than throwing on `blocked` / `limit_reached`
   * because each caller turns those into a different error: sign-in refuses
   * the session, licence verify answers `ok: false`, and neither wants a 4xx
   * decided here.
   */
  async touch(input: TouchDeviceInput): Promise<TouchDeviceOutcome> {
    const limit = await this.maxDevicesFor(input.applicationId, input.endUserId);
    const now = new Date();
    const ip = input.ip ? input.ip.slice(0, 64) : null;
    const label = input.label === undefined ? undefined : input.label?.slice(0, 120) ?? null;

    const outcome = await prisma.$transaction(async (tx) => {
      await lockDevices(tx, input.applicationId, input.endUserId);

      const existing = await tx.device.findUnique({
        where: {
          applicationId_endUserId_fingerprint: {
            applicationId: input.applicationId,
            endUserId: input.endUserId,
            fingerprint: input.fingerprint,
          },
        },
      });

      if (existing?.status === 'BLOCKED') {
        return { kind: 'blocked' as const, device: existing };
      }

      if (existing?.status === 'ACTIVE') {
        const device = await tx.device.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            lastSeenIp: ip,
            ...(label !== undefined && { label }),
          },
        });
        return { kind: 'ok' as const, device, created: false, reactivated: false };
      }

      // New device, or a RELEASED one coming back: both need a slot.
      if (limit !== null) {
        const active = await tx.device.count({
          where: { applicationId: input.applicationId, endUserId: input.endUserId, status: 'ACTIVE' },
        });
        if (active >= limit) {
          const devices = await tx.device.findMany({
            where: { applicationId: input.applicationId, endUserId: input.endUserId, status: 'ACTIVE' },
            orderBy: { lastSeenAt: 'desc' },
          });
          return { kind: 'limit_reached' as const, limit, devices: devices.map(summary) };
        }
      }

      if (existing) {
        const device = await tx.device.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            releasedAt: null,
            lastSeenAt: now,
            lastSeenIp: ip,
            ...(label !== undefined && { label }),
          },
        });
        return { kind: 'ok' as const, device, created: false, reactivated: true };
      }

      const device = await tx.device.create({
        data: {
          applicationId: input.applicationId,
          endUserId: input.endUserId,
          fingerprint: input.fingerprint,
          label: label ?? null,
          status: 'ACTIVE',
          firstSeenAt: now,
          lastSeenAt: now,
          lastSeenIp: ip,
        },
      });
      return { kind: 'ok' as const, device, created: true, reactivated: false };
    });

    // Side effects after commit, never on the request's critical path.
    if (outcome.kind === 'ok' && (outcome.created || outcome.reactivated)) {
      emitDetached({
        applicationId: input.applicationId,
        type: 'device.registered',
        data: { device: devicePayload(outcome.device), reactivated: outcome.reactivated },
      });
      void recordSecurityEvent({
        type: 'user.device_registered',
        actorType: 'end_user',
        actorId: input.endUserId,
        applicationId: input.applicationId,
        ip,
        metadata: { deviceId: outcome.device.id, via: input.via ?? null, reactivated: outcome.reactivated },
      });
    } else if (outcome.kind === 'limit_reached') {
      announceLimitReached(input, outcome, ip);
    }

    return outcome;
  },

  /**
   * Would `touch` with this input be refused, and why? Nothing is written.
   *
   * For the refresh flow, which has to make the device DECISION before it
   * spends the presented token (a refusal must not cost the client its
   * session) and the device WRITE after (a replayed token must not register
   * the replayer's machine or announce it). `touch` after a successful
   * rotation is the write; this is the decision. Same reads, same lock, no
   * mutation, so a `limit_reached` here is announced exactly as `touch`
   * would announce it: the refusal is the news, not the write.
   *
   * The answer can go stale between the two phases (another device of the
   * same user admitted in the gap), which is why `touch` re-decides under the
   * lock rather than trusting this.
   */
  async preflight(input: TouchDeviceInput): Promise<PreflightDeviceOutcome> {
    const limit = await this.maxDevicesFor(input.applicationId, input.endUserId);
    const ip = input.ip ? input.ip.slice(0, 64) : null;

    const outcome = await prisma.$transaction(async (tx) => {
      await lockDevices(tx, input.applicationId, input.endUserId);
      const existing = await tx.device.findUnique({
        where: {
          applicationId_endUserId_fingerprint: {
            applicationId: input.applicationId,
            endUserId: input.endUserId,
            fingerprint: input.fingerprint,
          },
        },
      });
      if (existing?.status === 'BLOCKED') return { kind: 'blocked' as const, device: existing };
      if (existing?.status === 'ACTIVE') return { kind: 'ok' as const };
      if (limit !== null) {
        const active = await tx.device.count({
          where: { applicationId: input.applicationId, endUserId: input.endUserId, status: 'ACTIVE' },
        });
        if (active >= limit) {
          const devices = await tx.device.findMany({
            where: { applicationId: input.applicationId, endUserId: input.endUserId, status: 'ACTIVE' },
            orderBy: { lastSeenAt: 'desc' },
          });
          return { kind: 'limit_reached' as const, limit, devices: devices.map(summary) };
        }
      }
      return { kind: 'ok' as const };
    });

    if (outcome.kind === 'limit_reached') announceLimitReached(input, outcome, ip);
    return outcome;
  },

  async listForEndUser(
    applicationId: string,
    endUserId: string,
    opts: { status?: DeviceStatus | undefined; take?: number; skip?: number } = {},
  ): Promise<{ items: Device[]; total: number }> {
    const where: Prisma.DeviceWhereInput = {
      applicationId,
      endUserId,
      ...(opts.status !== undefined && { status: opts.status }),
    };
    const [items, total] = await Promise.all([
      prisma.device.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        ...(opts.take !== undefined && { take: opts.take }),
        ...(opts.skip !== undefined && { skip: opts.skip }),
      }),
      prisma.device.count({ where }),
    ]);
    return { items, total };
  },

  /** One device, scoped to (application, end-user). 404 across either boundary. */
  async get(applicationId: string, endUserId: string, deviceId: string): Promise<Device> {
    const device = await prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.applicationId !== applicationId || device.endUserId !== endUserId) {
      throw notFound(deviceId);
    }
    return device;
  },

  /**
   * Give the slot back. Every session minted on the device is revoked in the
   * same transaction, "release my old laptop" that leaves the laptop signed
   * in would not be a release. Idempotent: releasing a RELEASED device is a
   * no-op that still returns the row. A BLOCKED device stays BLOCKED (an
   * operator decision is not undone by the user asking nicely).
   */
  async release(args: {
    applicationId: string;
    endUserId: string;
    deviceId: string;
    /**
     * Who asked. `server` is the customer's own backend on a secret key
     * (`id` is the API key id); it is recorded as an operator-side action
     * because the end-user did not do it, and a support tool releasing a
     * device must not read as the user releasing it.
     */
    actor: { type: 'end_user' | 'operator' | 'server'; id: string | null };
  }): Promise<{ device: Device; sessionsRevoked: number }> {
    const found = await this.get(args.applicationId, args.endUserId, args.deviceId);
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockDevices(tx, args.applicationId, args.endUserId);
      // Re-read under the lock: the status may have moved since the lookup.
      const current = await tx.device.findUniqueOrThrow({ where: { id: found.id } });
      if (current.status === 'BLOCKED') {
        throw new RekeyError({
          statusCode: 409,
          code: 'DEVICE_BLOCKED',
          message: 'This device is blocked and cannot be released.',
          fix: 'An operator must unblock it first (POST …/devices/:id/unblock).',
        });
      }
      if (current.status === 'RELEASED') return { device: current, sessionsRevoked: 0, changed: false };
      const device = await tx.device.update({
        where: { id: current.id },
        data: { status: 'RELEASED', releasedAt: now },
      });
      // The access tokens those sessions hold stop too, from now, and only
      // theirs: the session middleware refuses a token whose `sid` names a
      // revoked session or whose `dev` names a device that is no longer
      // ACTIVE. No per-user stamp, which would sign the user out of every
      // OTHER device as well.
      const revoked = await tx.refreshToken.updateMany({
        where: { deviceId: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
      return { device, sessionsRevoked: revoked.count, changed: true };
    });
    if (!result.changed) return { device: result.device, sessionsRevoked: 0 };
    const released = { device: result.device, sessionsRevoked: result.sessionsRevoked };

    emitDetached({
      applicationId: args.applicationId,
      type: 'device.released',
      data: {
        device: devicePayload(result.device),
        sessionsRevoked: result.sessionsRevoked,
        releasedBy: args.actor.type,
      },
    });
    void recordSecurityEvent({
      type: args.actor.type === 'end_user' ? 'user.device_released' : 'end_user.device_released',
      actorType: args.actor.type === 'server' ? 'system' : args.actor.type,
      actorId: args.actor.id,
      applicationId: args.applicationId,
      metadata: {
        deviceId: result.device.id,
        endUserId: args.endUserId,
        sessionsRevoked: result.sessionsRevoked,
        releasedBy: args.actor.type,
        ...(args.actor.type === 'server' && { apiKeyId: args.actor.id }),
      },
    });
    return released;
  },

  /**
   * Operator decision: refuse sign-in from this fingerprint until unblocked.
   * Revokes the device's sessions like `release` does. Idempotent.
   */
  async block(args: {
    applicationId: string;
    endUserId: string;
    deviceId: string;
    reason?: string | undefined;
    operatorUserId: string | null;
  }): Promise<{ device: Device; sessionsRevoked: number }> {
    const found = await this.get(args.applicationId, args.endUserId, args.deviceId);
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await lockDevices(tx, args.applicationId, args.endUserId);
      const current = await tx.device.findUniqueOrThrow({ where: { id: found.id } });
      if (current.status === 'BLOCKED') return { device: current, sessionsRevoked: 0, changed: false };
      const device = await tx.device.update({
        where: { id: current.id },
        data: {
          status: 'BLOCKED',
          blockedAt: now,
          blockedReason: args.reason?.slice(0, 500) ?? null,
        },
      });
      // Same as release: this device's access tokens are refused by `sid` and
      // `dev`, without a per-user stamp that would end the others.
      const revoked = await tx.refreshToken.updateMany({
        where: { deviceId: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
      return { device, sessionsRevoked: revoked.count, changed: true };
    });
    if (!result.changed) return { device: result.device, sessionsRevoked: 0 };
    const blocked = { device: result.device, sessionsRevoked: result.sessionsRevoked };

    emitDetached({
      applicationId: args.applicationId,
      type: 'device.blocked',
      data: { device: devicePayload(result.device), sessionsRevoked: result.sessionsRevoked },
    });
    void recordSecurityEvent({
      type: 'end_user.device_blocked',
      actorType: 'operator',
      actorId: args.operatorUserId,
      applicationId: args.applicationId,
      metadata: {
        deviceId: result.device.id,
        endUserId: args.endUserId,
        reason: args.reason ?? null,
        sessionsRevoked: result.sessionsRevoked,
      },
    });
    return blocked;
  },

  /**
   * Lift a block. The device comes back as RELEASED, not ACTIVE: it takes a
   * slot again only when it next signs in, and only if the limit allows,
   * unblocking must not be a way to exceed `max_devices`.
   */
  async unblock(args: {
    applicationId: string;
    endUserId: string;
    deviceId: string;
    operatorUserId: string | null;
  }): Promise<Device> {
    const found = await this.get(args.applicationId, args.endUserId, args.deviceId);
    const { device, changed } = await prisma.$transaction(async (tx) => {
      await lockDevices(tx, args.applicationId, args.endUserId);
      const current = await tx.device.findUniqueOrThrow({ where: { id: found.id } });
      if (current.status !== 'BLOCKED') return { device: current, changed: false };
      const updated = await tx.device.update({
        where: { id: current.id },
        data: { status: 'RELEASED', releasedAt: new Date(), blockedAt: null, blockedReason: null },
      });
      return { device: updated, changed: true };
    });
    if (!changed) return device;

    emitDetached({
      applicationId: args.applicationId,
      type: 'device.unblocked',
      data: { device: devicePayload(device) },
    });
    void recordSecurityEvent({
      type: 'end_user.device_unblocked',
      actorType: 'operator',
      actorId: args.operatorUserId,
      applicationId: args.applicationId,
      metadata: { deviceId: device.id, endUserId: args.endUserId },
    });
    return device;
  },
};
