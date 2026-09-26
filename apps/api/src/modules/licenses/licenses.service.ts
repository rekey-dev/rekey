/**
 * Licenses, perpetual, timed, or seat-based keys for software products.
 *
 * Issuance is operator-driven (admin / API key from the customer's billing
 * webhook handler). Verification is end-user-facing: customer's software
 * calls POST /api/v1/licenses/verify with the raw key + a machine
 * fingerprint, and we either confirm + record the activation or refuse.
 *
 * Activation tracking:
 *   - PERPETUAL / TIMED:  one row per unique (license, machineFingerprint).
 *     Bounded by the holder's `max_devices` FEATURE entitlement when their
 *     plans grant one (the same cap that bounds their sessions, see
 *     modules/devices); uncapped otherwise, which is what every deployment
 *     had before the entitlement existed.
 *   - SEATS:              same shape, but verification refuses if
 *     `seatsAllowed` would be exceeded. `seatsAllowed` is what was bought and
 *     is not raised or lowered by `max_devices`.
 *
 * An activation with `releasedAt` set has given its seat back: it does not
 * count toward `seatsAllowed`, and a later verify from the same machine
 * reactivates the row in place rather than inserting a second one. Rows also
 * carry `applicationId` (denormalised from the license) so app-scoped
 * listings and erasure can address them without a join.
 */

import type { Application, EndUser, License, LicenseActivation, LicenseKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { generateLicenseKey, hashLicenseKey } from '../../lib/license-keys.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { devicesService } from '../devices/devices.service.js';

export type PublicLicense = Omit<License, 'keyHash'>;

export interface RotateKeyResult {
  license: PublicLicense;
  /** Freshly minted raw key. Show ONCE, only the hash is stored. */
  rawKey: string;
  /**
   * Activations invalidated by the rotation. Rotating discards the previous
   * key's hash, so any machine activated under the OLD key must re-verify with
   * the new one. For org-pooled licenses provisioned by a subscription this is
   * normally 0 (the original key was never delivered), but we surface it so the
   * operator can warn the team when a key was already in circulation.
   */
  activationsReset: number;
}

function redactLicense(l: License): PublicLicense {
  const { keyHash, ...rest } = l;
  return rest;
}

/**
 * A licence as its holder sees it. Picked field by field rather than spread,
 * so a column added to `License` later does not reach end-users by default:
 * `keyHash` is a credential verifier and `metadata` is the operator's notes.
 */
export type EndUserLicense = Pick<
  License,
  | 'id'
  | 'applicationId'
  | 'endUserId'
  | 'organizationId'
  | 'planId'
  | 'kind'
  | 'status'
  | 'keyPrefix'
  | 'entitlementKey'
  | 'expiresAt'
  | 'seatsAllowed'
  | 'createdAt'
  | 'updatedAt'
  | 'revokedAt'
>;

const END_USER_LICENSE_SELECT = {
  id: true,
  applicationId: true,
  endUserId: true,
  organizationId: true,
  planId: true,
  kind: true,
  status: true,
  keyPrefix: true,
  entitlementKey: true,
  expiresAt: true,
  seatsAllowed: true,
  createdAt: true,
  updatedAt: true,
  revokedAt: true,
} as const satisfies Record<keyof EndUserLicense, true>;

/** How many licences `include=licenses` carries: the first page at the maximum size. */
export const SELF_LICENSE_INCLUDE_LIMIT = 100;

export interface IssueInput {
  application: Application;
  endUser: EndUser;
  kind: LicenseKind;
  planId?: string | undefined;
  /** Beneficiary org: pools the license/seats to a team (owner+beneficiary). */
  organizationId?: string | undefined;
  expiresAt?: Date | undefined;
  seatsAllowed?: number | undefined;
  /**
   * Which of the plan's LICENSE entitlements this licence is for.
   *
   * A plan may carry more than one (`@@unique([planId, kind, key])` permits
   * `LICENSE:a` and `LICENSE:b`). Part of the licence's pool identity, so two
   * such rows cannot resolve to one licence and overwrite each other.
   */
  entitlementKey?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface IssueResult {
  license: PublicLicense;
  /** Raw key. Show ONCE. */
  rawKey: string;
}

export interface VerifyInput {
  applicationId: string;
  rawKey: string;
  machineFingerprint: string;
  label?: string | undefined;
}

export interface VerifyResult {
  /** True if the license is valid + activation recorded. */
  ok: boolean;
  license?: PublicLicense;
  /** When `ok=false`, why. */
  reason?:
    | 'unknown'
    | 'revoked'
    | 'expired'
    | 'seats_exhausted'
    | 'wrong_application';
}

export interface DeactivateInput {
  applicationId: string;
  rawKey: string;
  machineFingerprint: string;
}

export type DeactivateResult =
  /** The seat was given back (or was already free, idempotent). */
  | { ok: true; released: boolean }
  /** Same reasons as verify, minus seat exhaustion: releasing never needs a seat. */
  | { ok: false; reason: 'unknown' | 'wrong_application' | 'revoked' | 'expired' };

export const licensesService = {
  async listForApplication(
    applicationId: string,
    opts?: { take?: number; skip?: number },
  ): Promise<PublicLicense[]> {
    const rows = await prisma.license.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
    return rows.map(redactLicense);
  },

  /** Total licenses on this Application, ignoring take/skip. */
  async countForApplication(applicationId: string): Promise<number> {
    return prisma.license.count({ where: { applicationId } });
  },

  /** Licenses pooled to an org (beneficiary). Seats are shared by the team. */
  async listForOrganization(applicationId: string, organizationId: string): Promise<PublicLicense[]> {
    const rows = await prisma.license.findMany({
      where: { applicationId, organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(redactLicense);
  },

  /**
   * The licences a signed-in end-user holds, newest first: every licence
   * issued to them (personal, and any they bought for a team), plus, with
   * `organizationId`, every licence pooled to that organization whoever
   * bought it. The caller decides whether the organization applies and has
   * confirmed membership (see `billingSubjectOrganization`).
   */
  async listForEndUser(
    applicationId: string,
    endUserId: string,
    opts: { organizationId?: string; take: number; skip: number },
  ): Promise<{ items: EndUserLicense[]; total: number }> {
    const where = {
      applicationId,
      OR: [{ endUserId }, ...(opts.organizationId ? [{ organizationId: opts.organizationId }] : [])],
    };
    const [items, total] = await Promise.all([
      prisma.license.findMany({
        where,
        select: END_USER_LICENSE_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: opts.take,
        skip: opts.skip,
      }),
      prisma.license.count({ where }),
    ]);
    return { items, total };
  },

  async issue(input: IssueInput): Promise<IssueResult> {
    if (input.kind === 'TIMED' && !input.expiresAt) {
      throw new RekeyError({
        statusCode: 400,
        code: 'LICENSE_EXPIRES_AT_REQUIRED',
        message: 'TIMED licenses must include `expiresAt`.',
        fix: 'Pass an ISO-8601 future date, or use kind=PERPETUAL.',
      });
    }
    if (input.kind === 'SEATS' && (!input.seatsAllowed || input.seatsAllowed < 1)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'LICENSE_SEATS_REQUIRED',
        message: 'SEATS licenses must include `seatsAllowed >= 1`.',
        fix: 'Pass `seatsAllowed`, or use kind=PERPETUAL / TIMED.',
      });
    }

    const { raw, hash, prefix } = generateLicenseKey();
    const license = await prisma.license.create({
      data: {
        applicationId: input.application.id,
        endUserId: input.endUser.id,
        kind: input.kind,
        keyPrefix: prefix,
        keyHash: hash,
        ...(input.planId !== undefined && { planId: input.planId }),
        ...(input.organizationId !== undefined && { organizationId: input.organizationId }),
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
        ...(input.seatsAllowed !== undefined && { seatsAllowed: input.seatsAllowed }),
        ...(input.entitlementKey !== undefined && { entitlementKey: input.entitlementKey }),
        ...(input.metadata !== undefined && { metadata: input.metadata as never }),
      },
    });
    return { license: redactLicense(license), rawKey: raw };
  },

  async revoke(applicationId: string, licenseId: string): Promise<PublicLicense> {
    const license = await prisma.license.findUnique({ where: { id: licenseId } });
    if (!license || license.applicationId !== applicationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'LICENSE_NOT_FOUND',
        message: `License "${licenseId}" not found in this application.`,
        fix: 'List licenses to see what exists.',
      });
    }
    if (license.revokedAt) return redactLicense(license);
    const updated = await prisma.license.update({
      where: { id: license.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return redactLicense(updated);
  },

  /**
   * Mint a fresh raw key for an existing **org-pooled** license and return it
   * ONCE, the delivery path for keys auto-issued during provisioning.
   *
   * Why this exists: an org-beneficiary subscription provisions exactly one
   * license pooled to the org (see entitlements.service `provision`), but the
   * provisioner stores only the hash and discards the raw key, so the team can
   * never obtain a key to call `licenses/verify`. Reading a stored key back is
   * impossible by design (hash-only). Rotation is the safe delivery: it mints a
   * new key, resets the hash, and hands the raw value over once.
   *
   * Scoped to org-pooled licenses (`organizationId` set) so this stays an
   * org-billing operation and can never be used to silently re-key a personal
   * license out from under its holder.
   *
   * Rotating invalidates any prior activations (the old key's hash is gone); we
   * clear the activation rows so SEATS counting stays accurate and report how
   * many were reset.
   */
  async rotateKeyForOrganization(
    applicationId: string,
    organizationId: string,
    licenseId: string,
  ): Promise<RotateKeyResult> {
    const license = await prisma.license.findUnique({ where: { id: licenseId } });
    if (
      !license ||
      license.applicationId !== applicationId ||
      license.organizationId !== organizationId
    ) {
      throw new RekeyError({
        statusCode: 404,
        code: 'LICENSE_NOT_FOUND',
        message: `Org-pooled license "${licenseId}" not found for this organization.`,
        fix: 'List the org billing summary to see its pooled licenses.',
      });
    }
    if (license.status === 'REVOKED' || license.revokedAt !== null) {
      throw new RekeyError({
        statusCode: 409,
        code: 'LICENSE_REVOKED',
        message: 'Cannot rotate the key of a revoked license.',
        fix: 'Provision a new subscription for the org, or issue a fresh license.',
      });
    }

    const { raw, hash, prefix } = generateLicenseKey();
    // Reset the key (hash-only) + clear stale activations atomically so the
    // returned raw key is the only valid one and seat counts start clean.
    const updated = await prisma.$transaction(async (tx) => {
      const cleared = await tx.licenseActivation.deleteMany({ where: { licenseId: license.id } });
      const row = await tx.license.update({
        where: { id: license.id },
        data: { keyPrefix: prefix, keyHash: hash },
      });
      return { row, activationsReset: cleared.count };
    });

    return { license: redactLicense(updated.row), rawKey: raw, activationsReset: updated.activationsReset };
  },

  /**
   * Verify a license by raw key + record an activation.
   *
   * Returns `ok: false` (no exception) for the common "invalid license"
   * cases, the customer's software loops on this and we don't want a
   * 404 to confuse it. Operators see the failure reason.
   */
  async verify(input: VerifyInput): Promise<VerifyResult> {
    const license = await prisma.license.findUnique({
      where: { keyHash: hashLicenseKey(input.rawKey) },
    });
    if (!license) return { ok: false, reason: 'unknown' };
    if (license.applicationId !== input.applicationId) {
      return { ok: false, reason: 'wrong_application' };
    }
    if (license.status === 'REVOKED' || license.revokedAt !== null) {
      return { ok: false, reason: 'revoked', license: redactLicense(license) };
    }
    if (license.expiresAt !== null && license.expiresAt <= new Date()) {
      // Mark EXPIRED on the way through if not already.
      if (license.status !== 'EXPIRED') {
        await prisma.license.update({ where: { id: license.id }, data: { status: 'EXPIRED' } });
      }
      return { ok: false, reason: 'expired', license: redactLicense(license) };
    }

    // The cap for this license. SEATS licenses carry their own; the other
    // kinds borrow the holder's `max_devices` entitlement, when any. Resolved
    // BEFORE the transaction for the reason devicesService.maxDevicesFor
    // documents: the entitlement union reads through the global client, and
    // doing that while holding a transaction's connection is how a pool
    // deadlocks under load. Org-pooled licenses (`organizationId` set) have no
    // single end-user to resolve for and stay uncapped unless SEATS.
    let cap: number | null = null;
    if (license.kind === 'SEATS' && license.seatsAllowed !== null) {
      cap = license.seatsAllowed;
    } else if (license.organizationId === null) {
      cap = await devicesService.maxDevicesFor(license.applicationId, license.endUserId);
    }

    // Atomic seat allocation + activation upsert.
    //
    // Reading the seat count outside a transaction before inserting the
    // activation row let two concurrent verify() calls for the same SEATS
    // license on different machines both pass the count check, over-issuing
    // by `concurrency - 1` seats. A row-level lock on the license row for the
    // duration of the count+upsert serialises every concurrent verify against
    // the same license. Verifications across different licenses are
    // independent and proceed in parallel.
    //
    // The seat re-check inside the transaction is the authoritative one.
    // It still skips when an activation row already exists for this
    // machine, repeat verify from a previously-active machine never
    // consumes a new seat.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${license.id} FOR UPDATE`;

      if (cap !== null) {
        const existing = await tx.licenseActivation.findUnique({
          where: {
            licenseId_machineFingerprint: {
              licenseId: license.id,
              machineFingerprint: input.machineFingerprint,
            },
          },
        });
        // A released activation holds no seat, so it is "not existing" for
        // the count and needs a free seat to come back.
        if (!existing || existing.releasedAt !== null) {
          const used = await tx.licenseActivation.count({
            where: { licenseId: license.id, releasedAt: null },
          });
          if (used >= cap) {
            return { kind: 'seats_exhausted' as const };
          }
        }
      }

      await tx.licenseActivation.upsert({
        where: {
          licenseId_machineFingerprint: {
            licenseId: license.id,
            machineFingerprint: input.machineFingerprint,
          },
        },
        create: {
          applicationId: license.applicationId,
          licenseId: license.id,
          machineFingerprint: input.machineFingerprint,
          ...(input.label !== undefined && { label: input.label }),
        },
        update: {
          lastSeenAt: new Date(),
          // Reactivate in place if this machine had released its seat.
          releasedAt: null,
          ...(input.label !== undefined && { label: input.label }),
        },
      });
      return { kind: 'ok' as const };
    });

    if (result.kind === 'ok') {
      // Point the activation at the holder's Device row for the same
      // fingerprint, when one exists, so the seat list and the device list
      // agree about which machine is which. Outside the seat transaction
      // because it is not part of the seat decision; a missing device is not
      // a verification failure, and a retry after a failure here finds the
      // seat already held and links again.
      const device = await prisma.device.findUnique({
        where: {
          applicationId_endUserId_fingerprint: {
            applicationId: license.applicationId,
            endUserId: license.endUserId,
            fingerprint: input.machineFingerprint,
          },
        },
        select: { id: true },
      });
      if (device) {
        await prisma.licenseActivation.updateMany({
          where: { licenseId: license.id, machineFingerprint: input.machineFingerprint, deviceId: null },
          data: { deviceId: device.id },
        });
      }
    }

    if (result.kind === 'seats_exhausted') {
      return { ok: false, reason: 'seats_exhausted', license: redactLicense(license) };
    }
    return { ok: true, license: redactLicense(license) };
  },

  /**
   * Give a seat back from the machine that holds it, the customer's software
   * calling "deactivate this install" before a re-image, or on uninstall.
   *
   * Same deterministic-body contract as `verify`: an invalid key is `ok:
   * false` + reason, never an HTTP error, so a client can call it from an
   * uninstaller without try/catch. Releasing is idempotent and never needs a
   * seat, so `seats_exhausted` cannot occur here. A revoked or expired license
   * is refused rather than silently "released": there is nothing to give back,
   * and the client should learn the license is dead.
   */
  async deactivate(input: DeactivateInput): Promise<DeactivateResult> {
    const license = await prisma.license.findUnique({
      where: { keyHash: hashLicenseKey(input.rawKey) },
    });
    if (!license) return { ok: false, reason: 'unknown' };
    if (license.applicationId !== input.applicationId) return { ok: false, reason: 'wrong_application' };
    if (license.status === 'REVOKED' || license.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (license.expiresAt !== null && license.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

    const now = new Date();
    const { released, deliveryIds } = await prisma.$transaction(async (tx) => {
      const updated = await tx.licenseActivation.updateMany({
        where: { licenseId: license.id, machineFingerprint: input.machineFingerprint, releasedAt: null },
        data: { releasedAt: now },
      });
      if (updated.count !== 1) return { released: false, deliveryIds: [] };
      const ids = await enqueueEvent(tx, {
        applicationId: license.applicationId,
        type: 'license.deactivated',
        data: {
          license: { id: license.id, endUserId: license.endUserId, kind: license.kind },
          machineFingerprint: input.machineFingerprint,
          releasedBy: 'client',
        },
      });
      return { released: true, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);
    return { ok: true, released };
  },

  /**
   * Operator-side seat release by activation id. Idempotent. Scoped to
   * (application, license) so an id from elsewhere 404s.
   */
  async releaseActivation(args: {
    applicationId: string;
    licenseId: string;
    activationId: string;
  }): Promise<LicenseActivation> {
    const activation = await prisma.licenseActivation.findUnique({ where: { id: args.activationId } });
    if (
      !activation ||
      activation.licenseId !== args.licenseId ||
      activation.applicationId !== args.applicationId
    ) {
      throw new RekeyError({
        statusCode: 404,
        code: 'LICENSE_ACTIVATION_NOT_FOUND',
        message: `Activation "${args.activationId}" not found on that license in this application.`,
        fix: 'List the license\'s activations to see what exists.',
      });
    }
    if (activation.releasedAt !== null) return activation;
    const { released, deliveryIds } = await prisma.$transaction(async (tx) => {
      const row = await tx.licenseActivation.update({
        where: { id: activation.id },
        data: { releasedAt: new Date() },
      });
      const license = await tx.license.findUniqueOrThrow({ where: { id: row.licenseId } });
      const ids = await enqueueEvent(tx, {
        applicationId: args.applicationId,
        type: 'license.deactivated',
        data: {
          license: { id: license.id, endUserId: license.endUserId, kind: license.kind },
          machineFingerprint: row.machineFingerprint,
          releasedBy: 'operator',
        },
      });
      return { released: row, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);
    return released;
  },
};
