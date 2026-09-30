import { Prisma, type EndUser } from '@prisma/client';
import type { EndUserProfile, ProfileField } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { enqueueUserUpdated, type UserUpdateSource } from '../auth/user-lifecycle.js';
import { applyProfilePatch, missingRequired, readProfile, type ProfileWriter } from './profile-values.js';
import { putSchema, readSchema, readSchemaLocked } from './profile-schema.service.js';

/**
 * Who completed or skipped onboarding, carried as `data.via` on
 * `user.onboarding_completed` and `user.onboarding_skipped`.
 */
export type OnboardingSource = 'self' | 'server' | 'operator';

export interface ProfileState {
  profile: EndUserProfile;
  onboardingCompletedAt: Date | null;
  onboardingSkippedAt: Date | null;
}

function notFound(endUserId: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'END_USER_NOT_FOUND',
    message: `End-user "${endUserId}" not found in this Application.`,
    fix: 'Confirm the id belongs to this Application.',
  });
}

function erased(): RekeyError {
  return new RekeyError({
    statusCode: 410,
    code: 'END_USER_ERASED',
    message: 'This end-user has been erased (GDPR); their profile can no longer be written.',
    fix: 'The account was permanently erased on a data-subject request. Create a fresh account if needed.',
  });
}

/**
 * Lock the user's row for the rest of the transaction and read what a profile
 * write needs. The lock is what keeps two patches of different keys from
 * losing one another's answers.
 */
async function lockUser(
  tx: Prisma.TransactionClient,
  applicationId: string,
  endUserId: string,
): Promise<ProfileState> {
  const rows = await tx.$queryRaw<
    Array<{
      application_id: string;
      profile: unknown;
      onboarding_completed_at: Date | null;
      onboarding_skipped_at: Date | null;
      erased_at: Date | null;
    }>
  >`SELECT "application_id", "profile", "onboarding_completed_at", "onboarding_skipped_at", "erased_at"
      FROM "end_users" WHERE "id" = ${endUserId} FOR UPDATE`;
  const row = rows[0];
  if (!row || row.application_id !== applicationId) throw notFound(endUserId);
  if (row.erased_at) throw erased();
  return {
    profile: readProfile(row.profile),
    onboardingCompletedAt: row.onboarding_completed_at,
    onboardingSkippedAt: row.onboarding_skipped_at,
  };
}

export const profileService = {
  /**
   * The Application's profile fields, in order.
   *
   * @example
   *   const fields = await profileService.schema(app.id);
   */
  async schema(applicationId: string): Promise<ProfileField[]> {
    return (await readSchema(applicationId)).fields;
  },

  /** The fields with the version a PUT names. */
  schemaWithVersion: readSchema,

  /** Replace the fields. See `putSchema` in profile-schema.service.ts. */
  putSchema,

  /**
   * Patch one user's answers and announce the change as `user.updated` with
   * `changed: ['profile.<key>', ...]` (names only, never values) in the same
   * transaction. A `user` writer may only set `writableBy: 'user'` fields.
   *
   * @example
   *   await profileService.update({ applicationId, endUserId, patch: { company: 'Acme' }, writer: 'user', via: 'self' });
   */
  async update(args: {
    applicationId: string;
    endUserId: string;
    patch: Record<string, unknown>;
    writer: ProfileWriter;
    via: UserUpdateSource;
  }): Promise<ProfileState> {
    const { state, deliveryIds } = await prisma.$transaction(async (tx) => {
      const { fields } = await readSchemaLocked(tx, args.applicationId, 'share');
      const current = await lockUser(tx, args.applicationId, args.endUserId);
      const { profile, changed } = applyProfilePatch(fields, current.profile, args.patch, args.writer);
      if (changed.length === 0) return { state: current, deliveryIds: [] as string[] };
      const user: EndUser = await tx.endUser.update({
        where: { id: args.endUserId },
        data: { profile: profile as Prisma.InputJsonValue },
      });
      const ids = await enqueueUserUpdated(tx, {
        user,
        changed: changed.map((k) => `profile.${k}`),
        via: args.via,
      });
      return { state: { ...current, profile }, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);
    return state;
  },

  /**
   * Mark onboarding complete once every required field is answered. The first
   * call stamps `onboardingCompletedAt` and emits `user.onboarding_completed`;
   * later calls return the stored time and emit nothing. A user who skipped
   * may still complete; `onboardingSkippedAt` is kept as history.
   *
   * @example
   *   const { onboardingCompletedAt } = await profileService.completeOnboarding({ applicationId, endUserId, via: 'self' });
   */
  async completeOnboarding(args: {
    applicationId: string;
    endUserId: string;
    via: OnboardingSource;
  }): Promise<ProfileState> {
    const { state, deliveryIds } = await prisma.$transaction(async (tx) => {
      const { fields } = await readSchemaLocked(tx, args.applicationId, 'share');
      const current = await lockUser(tx, args.applicationId, args.endUserId);
      if (current.onboardingCompletedAt) return { state: current, deliveryIds: [] as string[] };
      const missing = missingRequired(fields, current.profile);
      if (missing.length > 0) {
        throw new RekeyError({
          statusCode: 409,
          code: 'PROFILE_INCOMPLETE',
          message: `Onboarding cannot be completed: ${missing.map((k) => `"${k}"`).join(', ')} not answered yet.`,
          fix: 'Answer every field in `details.missing` (PATCH .../profile), then call onboarding/complete again.',
          details: { missing },
        });
      }
      const completedAt = new Date();
      await tx.endUser.update({ where: { id: args.endUserId }, data: { onboardingCompletedAt: completedAt } });
      const ids = await enqueueEvent(tx, {
        applicationId: args.applicationId,
        type: 'user.onboarding_completed',
        data: { userId: args.endUserId, completedAt: completedAt.toISOString(), via: args.via },
      });
      return { state: { ...current, onboardingCompletedAt: completedAt }, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);
    return state;
  },

  /**
   * Record that the user skipped onboarding. Validates nothing and gates
   * nothing: the client app decides what a skip means. The first call stamps
   * `onboardingSkippedAt` and emits `user.onboarding_skipped`; a repeat, or a
   * skip after completion, returns the current state and emits nothing.
   *
   * @example
   *   const { onboardingSkippedAt } = await profileService.skipOnboarding({ applicationId, endUserId, via: 'self' });
   */
  async skipOnboarding(args: {
    applicationId: string;
    endUserId: string;
    via: OnboardingSource;
  }): Promise<ProfileState> {
    const { state, deliveryIds } = await prisma.$transaction(async (tx) => {
      const current = await lockUser(tx, args.applicationId, args.endUserId);
      if (current.onboardingCompletedAt || current.onboardingSkippedAt) {
        return { state: current, deliveryIds: [] as string[] };
      }
      const skippedAt = new Date();
      await tx.endUser.update({ where: { id: args.endUserId }, data: { onboardingSkippedAt: skippedAt } });
      const ids = await enqueueEvent(tx, {
        applicationId: args.applicationId,
        type: 'user.onboarding_skipped',
        data: { userId: args.endUserId, skippedAt: skippedAt.toISOString(), via: args.via },
      });
      return { state: { ...current, onboardingSkippedAt: skippedAt }, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);
    return state;
  },
};
