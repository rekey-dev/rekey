/**
 * Licenses — perpetual, timed, or seat-based keys for software products.
 *
 * Issuance is operator-driven (admin / API key from the customer's billing
 * webhook handler). Verification is end-user-facing: customer's software
 * calls POST /api/v1/licenses/verify with the raw key + a machine
 * fingerprint, and we either confirm + record the activation or refuse.
 *
 * Activation tracking:
 *   - PERPETUAL / TIMED:  one row per unique (license, machineFingerprint).
 *     No upper bound today.
 *   - SEATS:              same shape, but verification refuses if
 *     `seatsAllowed` would be exceeded.
 */

import type { Application, EndUser, License, LicenseKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { generateLicenseKey, hashLicenseKey } from '../../lib/license-keys.js';

export type PublicLicense = Omit<License, 'keyHash'>;

export interface RotateKeyResult {
  license: PublicLicense;
  /** Freshly minted raw key. Show ONCE — only the hash is stored. */
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { keyHash, ...rest } = l;
  return rest;
}

export interface IssueInput {
  application: Application;
  endUser: EndUser;
  kind: LicenseKind;
  planId?: string | undefined;
  /** Beneficiary org: pools the license/seats to a team (owner+beneficiary). */
  organizationId?: string | undefined;
  expiresAt?: Date | undefined;
  seatsAllowed?: number | undefined;
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

  /** Licenses pooled to an org (beneficiary). Seats are shared by the team. */
  async listForOrganization(applicationId: string, organizationId: string): Promise<PublicLicense[]> {
    const rows = await prisma.license.findMany({
      where: { applicationId, organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(redactLicense);
  },

  async issue(input: IssueInput): Promise<IssueResult> {
    if (input.kind === 'TIMED' && !input.expiresAt) {
      throw new RelipayError({
        statusCode: 400,
        code: 'LICENSE_EXPIRES_AT_REQUIRED',
        message: 'TIMED licenses must include `expiresAt`.',
        fix: 'Pass an ISO-8601 future date, or use kind=PERPETUAL.',
      });
    }
    if (input.kind === 'SEATS' && (!input.seatsAllowed || input.seatsAllowed < 1)) {
      throw new RelipayError({
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
        ...(input.metadata !== undefined && { metadata: input.metadata as never }),
      },
    });
    return { license: redactLicense(license), rawKey: raw };
  },

  async revoke(applicationId: string, licenseId: string): Promise<PublicLicense> {
    const license = await prisma.license.findUnique({ where: { id: licenseId } });
    if (!license || license.applicationId !== applicationId) {
      throw new RelipayError({
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
   * ONCE — the delivery path for keys auto-issued during provisioning.
   *
   * Why this exists: an org-beneficiary subscription provisions exactly one
   * license pooled to the org (see entitlements.service `provision`), but the
   * provisioner stores only the hash and discards the raw key — so the team can
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
      throw new RelipayError({
        statusCode: 404,
        code: 'LICENSE_NOT_FOUND',
        message: `Org-pooled license "${licenseId}" not found for this organization.`,
        fix: 'List the org billing summary to see its pooled licenses.',
      });
    }
    if (license.status === 'REVOKED' || license.revokedAt !== null) {
      throw new RelipayError({
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
   * cases — the customer's software loops on this and we don't want a
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

    // Atomic seat allocation + activation upsert.
    //
    // Previously the seat count was read OUTSIDE a transaction, then the
    // activation row was inserted — two concurrent verify() calls for the
    // same SEATS license on different machines could both pass the count
    // check, over-issuing by `concurrency - 1` seats. The fix: take a
    // row-level lock on the license row for the duration of the
    // count+upsert, which serialises every concurrent verify against the
    // same license. Verifications across different licenses are
    // independent and proceed in parallel.
    //
    // The seat re-check inside the transaction is the authoritative one.
    // It still skips when an activation row already exists for this
    // machine — repeat verify from a previously-active machine never
    // consumes a new seat.
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM licenses WHERE id = ${license.id} FOR UPDATE`;

      if (license.kind === 'SEATS' && license.seatsAllowed !== null) {
        const existing = await tx.licenseActivation.findUnique({
          where: {
            licenseId_machineFingerprint: {
              licenseId: license.id,
              machineFingerprint: input.machineFingerprint,
            },
          },
        });
        if (!existing) {
          const used = await tx.licenseActivation.count({ where: { licenseId: license.id } });
          if (used >= license.seatsAllowed) {
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
          licenseId: license.id,
          machineFingerprint: input.machineFingerprint,
          ...(input.label !== undefined && { label: input.label }),
        },
        update: {
          lastSeenAt: new Date(),
          ...(input.label !== undefined && { label: input.label }),
        },
      });
      return { kind: 'ok' as const };
    });

    if (result.kind === 'seats_exhausted') {
      return { ok: false, reason: 'seats_exhausted', license: redactLicense(license) };
    }
    return { ok: true, license: redactLicense(license) };
  },
};
