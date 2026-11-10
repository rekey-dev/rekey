/**
 * A signed-in end-user's view of their licences' machines: which ones hold a
 * seat, and freeing one from their account when they no longer have the key.
 */

import type { License } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { organizationsService } from '../organizations/organizations.service.js';
import type { DeactivateResult } from './licenses.service.js';
import { inactiveReason, releaseSeat } from './license-seat-release.js';

/**
 * A machine holding (or having held) a seat, as the licence's holder sees it.
 * The fingerprint is shortened: it names the machine for the customer without
 * handing a licence-key holder the exact value that verifies as that machine.
 */
export interface EndUserLicenseActivation {
  id: string;
  label: string | null;
  fingerprintHint: string;
  status: 'ACTIVE' | 'RELEASED';
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function fingerprintHint(fingerprint: string): string {
  return `${fingerprint.slice(0, Math.min(6, Math.floor(fingerprint.length / 3)))}…`;
}

const LICENSE_NOT_FOUND_FOR_END_USER = (licenseId: string): RekeyError =>
  new RekeyError({
    statusCode: 404,
    code: 'LICENSE_NOT_FOUND',
    message: `License "${licenseId}" is not one of yours.`,
    fix: 'List your licences with GET /api/v1/users/me/licenses and use one of their ids.',
  });

export const licensesSelfService = {
  /**
   * A licence the signed-in end-user may look at: one issued to them, or one
   * pooled to an organization they belong to. Anything else is 404, so an id
   * from another account or Application says nothing about whether it exists.
   */
  async visibleToEndUser(args: { applicationId: string; endUserId: string; licenseId: string }): Promise<License> {
    const license = await prisma.license.findUnique({ where: { id: args.licenseId } });
    if (!license || license.applicationId !== args.applicationId) throw LICENSE_NOT_FOUND_FOR_END_USER(args.licenseId);
    if (license.endUserId === args.endUserId) return license;
    const member =
      license.organizationId !== null &&
      (await organizationsService.isMember({
        applicationId: args.applicationId,
        endUserId: args.endUserId,
        organizationId: license.organizationId,
      }));
    if (!member) throw LICENSE_NOT_FOUND_FOR_END_USER(args.licenseId);
    return license;
  },

  /** The machines on one of the caller's licences, active first, then most recently seen. */
  async listActivationsForEndUser(args: {
    applicationId: string;
    endUserId: string;
    licenseId: string;
    take: number;
    skip: number;
  }): Promise<{ items: EndUserLicenseActivation[]; total: number }> {
    const license = await licensesSelfService.visibleToEndUser(args);
    const where = { licenseId: license.id };
    const [rows, total] = await Promise.all([
      prisma.licenseActivation.findMany({
        where,
        orderBy: [{ releasedAt: { sort: 'desc', nulls: 'first' } }, { lastSeenAt: 'desc' }, { id: 'desc' }],
        take: args.take,
        skip: args.skip,
      }),
      prisma.licenseActivation.count({ where }),
    ]);
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        label: r.label,
        fingerprintHint: fingerprintHint(r.machineFingerprint),
        status: r.releasedAt === null ? 'ACTIVE' : 'RELEASED',
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
      })),
    };
  },

  /**
   * Free a seat from the caller's account, by activation id, with the same
   * policy and webhook as the client's own deactivate. A personal licence is
   * its holder's to manage; a licence pooled to an organization is managed by
   * that organization's OWNER and ADMIN tiers, whoever bought it.
   */
  async releaseActivationForEndUser(args: {
    applicationId: string;
    endUserId: string;
    licenseId: string;
    activationId: string;
  }): Promise<DeactivateResult> {
    const license = await licensesSelfService.visibleToEndUser(args);
    if (license.organizationId !== null) {
      await organizationsService.requireRole(
        { application: { id: args.applicationId }, actorEndUserId: args.endUserId, organizationId: license.organizationId },
        ['OWNER', 'ADMIN'],
      );
    }
    const activation = await prisma.licenseActivation.findUnique({ where: { id: args.activationId } });
    if (!activation || activation.licenseId !== license.id) {
      throw new RekeyError({
        statusCode: 404,
        code: 'LICENSE_ACTIVATION_NOT_FOUND',
        message: `Activation "${args.activationId}" is not on that licence.`,
        fix: "List the licence's machines with GET /api/v1/users/me/licenses/:licenseId/activations and use one of their ids.",
      });
    }
    const inactive = inactiveReason(license);
    if (inactive) return { ok: false, reason: inactive };
    return { ok: true, released: await releaseSeat(license, { id: activation.id }, 'end_user') };
  },
};
