/**
 * "Does this end-user belong to this Application?", answered once.
 *
 * Every secret-key, operator and MCP surface that takes an end-user id from
 * its caller has to refuse an id from another Application with the same
 * 404 it gives a typo, so that the id space of one tenant is not an oracle
 * for another. The check is four lines and it was written out at each site;
 * this is the one copy.
 */

import { prisma } from './prisma.js';
import { RekeyError } from './error.js';

export async function assertEndUserInApplication(
  applicationId: string,
  endUserId: string,
  fix = 'Confirm the id belongs to this Application.',
): Promise<void> {
  const endUser = await prisma.endUser.findUnique({
    where: { id: endUserId },
    select: { applicationId: true },
  });
  if (!endUser || endUser.applicationId !== applicationId) {
    throw new RekeyError({
      statusCode: 404,
      code: 'END_USER_NOT_FOUND',
      message: `End-user "${endUserId}" not found in this Application.`,
      fix,
    });
  }
}
