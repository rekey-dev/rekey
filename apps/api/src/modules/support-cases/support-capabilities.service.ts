/**
 * The per-Application catalogue of support capability names. Free-form names
 * the application interprets and Rekey never does, like application roles.
 * A name is a client contract, so there is no rename.
 */

import type { Prisma, SupportCapability } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

const SUPPORT_CAPABILITY_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const SUPPORT_CAPABILITY_NAME_MAX = 64;
export const SUPPORT_CAPABILITY_DESCRIPTION_MAX = 240;
export const SUPPORT_CAPABILITY_LIMIT = 100;

function notFound(name: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'SUPPORT_CAPABILITY_NOT_FOUND',
    message: `No support capability "${name}" in this Application's catalogue.`,
    fix: 'GET .../support-capabilities lists the names that exist.',
  });
}

/**
 * Refuse names that are not in the catalogue. The rows are share-locked until
 * the caller's transaction ends, so a capability cannot be deleted between
 * this check and the case that uses it being written.
 */
export async function assertCapabilitiesInCatalogue(
  tx: Prisma.TransactionClient,
  applicationId: string,
  names: readonly string[],
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ name: string }>>`
    SELECT name FROM support_capabilities
    WHERE application_id = ${applicationId} AND name = ANY(${[...names]}::text[])
    FOR SHARE`;
  const known = new Set(rows.map((r) => r.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length === 0) return;
  throw new RekeyError({
    statusCode: 400,
    code: 'SUPPORT_CAPABILITY_UNKNOWN',
    message: `Not in this Application's support capability catalogue: ${unknown.map((n) => `"${n.slice(0, SUPPORT_CAPABILITY_NAME_MAX)}"`).join(', ')}.`,
    fix: 'Add the name with POST .../support-capabilities first, or send only names GET .../support-capabilities returns.',
    details: { unknown },
  });
}

export const supportCapabilitiesService = {
  /**
   * @example
   *   const catalogue = await supportCapabilitiesService.list(applicationId);
   */
  list(applicationId: string): Promise<SupportCapability[]> {
    return prisma.supportCapability.findMany({ where: { applicationId }, orderBy: { name: 'asc' } });
  },

  /**
   * @example
   *   await supportCapabilitiesService.create({ applicationId, name: 'diagnostics.debug', description: 'Verbose logs' });
   */
  async create(input: { applicationId: string; name: string; description?: string | undefined }): Promise<SupportCapability> {
    const name = input.name.trim();
    if (name.length > SUPPORT_CAPABILITY_NAME_MAX || !SUPPORT_CAPABILITY_NAME_RE.test(name)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'SUPPORT_CAPABILITY_NAME_INVALID',
        message:
          `A capability name is 1 to ${SUPPORT_CAPABILITY_NAME_MAX} characters: lowercase letters and digits, ` +
          'in groups joined by a single dot, hyphen or underscore.',
        fix: 'Send a name like "diagnostics.debug" or "beta-builds".',
      });
    }
    // Counted, then inserted: the limit is soft under concurrent creates.
    const count = await prisma.supportCapability.count({ where: { applicationId: input.applicationId } });
    if (count >= SUPPORT_CAPABILITY_LIMIT) {
      throw new RekeyError({
        statusCode: 409,
        code: 'SUPPORT_CAPABILITY_LIMIT',
        message: `This Application already has ${SUPPORT_CAPABILITY_LIMIT} support capabilities, the most a catalogue holds.`,
        fix: 'Delete a capability no open case uses (DELETE .../support-capabilities/:name), then add this one.',
      });
    }
    try {
      return await prisma.supportCapability.create({
        data: {
          applicationId: input.applicationId,
          name,
          ...(input.description !== undefined && { description: input.description }),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      throw new RekeyError({
        statusCode: 409,
        code: 'SUPPORT_CAPABILITY_NAME_TAKEN',
        message: `Support capability "${name}" already exists in this Application.`,
        fix: 'Use the existing one. To change its description, delete it (DELETE .../support-capabilities/:name, refused while an open case uses it) and add it again.',
      });
    }
  },

  /**
   * Refused while an open case uses the name. Closed cases keep it as history.
   *
   * @example
   *   await supportCapabilitiesService.remove({ applicationId, name: 'diagnostics.debug' });
   */
  async remove(args: { applicationId: string; name: string }): Promise<void> {
    const { applicationId, name } = args;
    await prisma.$transaction(async (tx) => {
      // Deleted before counting: the delete waits for any case being opened
      // with this name (see assertCapabilitiesInCatalogue), so the count
      // below sees that case and the refusal rolls the delete back.
      const { count } = await tx.supportCapability.deleteMany({ where: { applicationId, name } });
      if (count === 0) throw notFound(name);
      const inUse = await tx.supportCase.count({
        where: { applicationId, status: 'OPEN', capabilities: { has: name } },
      });
      if (inUse === 0) return;
      throw new RekeyError({
        statusCode: 409,
        code: 'SUPPORT_CAPABILITY_IN_USE',
        message: `Support capability "${name}" is on ${inUse} open support ${inUse === 1 ? 'case' : 'cases'}.`,
        fix:
          `List them with GET .../support-cases?status=open, then remove "${name}" from each ` +
          '(PATCH .../end-users/:euid/support) or end the case (POST .../end-users/:euid/support/end), and delete again.',
        details: { openCases: inUse },
      });
    });
  },
};
