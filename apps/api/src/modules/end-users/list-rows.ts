import type { Prisma } from '@prisma/client';
import { onboardingStatus } from '@rekey.dev/shared-types';

/** The columns the operator end-user list reads. */
export const END_USER_LIST_SELECT = {
  id: true, email: true, emailVerified: true, role: true, metadata: true, bannedAt: true, erasedAt: true,
  createdAt: true, lastSignedInAt: true, lastActiveOn: true, lastPlatform: true, lastCountry: true, profile: true,
  onboardingCompletedAt: true, onboardingSkippedAt: true, createdVia: true,
} as const satisfies Prisma.EndUserSelect;

type EndUserListRecord = Prisma.EndUserGetPayload<{ select: typeof END_USER_LIST_SELECT }>;

/**
 * One row of the operator end-user list, as REST and the operator MCP return it.
 * A ban no longer applies to an erased end-user, so it lists `bannedAt: null`.
 *
 * @example
 *   const rows = (await prisma.endUser.findMany({ where, select: END_USER_LIST_SELECT })).map(endUserListRow);
 */
export function endUserListRow({
  erasedAt,
  bannedAt,
  onboardingCompletedAt,
  onboardingSkippedAt,
  createdVia,
  lastActiveOn,
  ...user
}: EndUserListRecord) {
  return {
    ...user,
    bannedAt: erasedAt ? null : bannedAt,
    lastActiveOn: lastActiveOn ? lastActiveOn.toISOString().slice(0, 10) : null,
    onboardingStatus: onboardingStatus({ onboardingCompletedAt, onboardingSkippedAt }),
    createdVia: createdVia ?? 'unknown',
  };
}
