import type { Application, EndUser, Prisma } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { resolveAppUrl } from '../../lib/app-url.js';
import { emailService } from '../email/email.service.js';
import { enqueueEvent } from '../webhooks/webhook.service.js';
import { recordSignIn, type SignInClient } from '../end-users/sign-in-stats.js';
import { claimDailyActivity } from '../end-users/daily-activity.js';

/**
 * Write `session.created` for a session a sign-in just minted, through the
 * transaction that wrote its refresh row. Also claims the user's first
 * sign-in: a conditional update on `firstSignedInAt`, so of several first
 * sign-ins racing exactly one reports `firstSignIn: true`, and one that rolls
 * back leaves the claim for the next. Counts the sign-in and the day's
 * activity in the same transaction.
 *
 * @example
 *   const ids = await enqueueSessionCreated(tx, { endUser, sessionId, deviceId, via: 'password' });
 */
export async function enqueueSessionCreated(
  tx: Prisma.TransactionClient,
  args: {
    endUser: EndUser;
    sessionId: string;
    deviceId: string | null;
    via: string;
    client?: SignInClient | null;
  },
): Promise<string[]> {
  const first = await tx.endUser.updateMany({
    where: { id: args.endUser.id, firstSignedInAt: null },
    data: { firstSignedInAt: new Date() },
  });
  await recordSignIn(tx, args.endUser.id, args.via, args.client ?? null);
  await claimDailyActivity(tx, args.endUser.id, { lastActiveOn: args.endUser.lastActiveOn });
  return enqueueEvent(tx, {
    applicationId: args.endUser.applicationId,
    type: 'session.created',
    data: {
      userId: args.endUser.id,
      sessionId: args.sessionId,
      deviceId: args.deviceId,
      via: args.via,
      firstSignIn: first.count === 1,
      platform: args.client?.platform ?? null,
      country: args.client?.country ?? null,
    },
  });
}

/** Where a `user.updated` change came from, carried as `data.via`. */
export type UserUpdateSource = 'self' | 'server' | 'operator' | 'email_verification' | 'magic_link';

/** The fields an end-user webhook describes, the same shape `user.created` has always carried. */
export function userSnapshot(user: EndUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    metadata: user.metadata ?? null,
  };
}

/**
 * Write `user.updated` through the caller's transaction, so the event commits
 * or rolls back with the change it announces. `changed` holds field names only,
 * never values. Enqueues nothing when nothing changed.
 *
 * @example
 *   await prisma.$transaction(async (tx) => {
 *     const user = await tx.endUser.update({ where: { id }, data: { role: 'admin' } });
 *     return enqueueUserUpdated(tx, { user, changed: ['role'], via: 'operator' });
 *   });
 */
export async function enqueueUserUpdated(
  tx: Prisma.TransactionClient,
  args: { user: EndUser; changed: readonly string[]; via: UserUpdateSource },
): Promise<string[]> {
  if (args.changed.length === 0) return [];
  return enqueueEvent(tx, {
    applicationId: args.user.applicationId,
    type: 'user.updated',
    data: { user: userSnapshot(args.user), changed: [...args.changed], via: args.via },
  });
}

/** When a new account's welcome mail goes out: at creation, on first verification, or not at all. */
export type WelcomeTiming = 'now' | 'pending' | 'never';

/**
 * Decide a new account's welcome from `authConfig.welcomeEmail`. `on_signup`
 * still waits when `requireEmailVerification` refuses the unverified account a
 * session, since a welcome then greets an address nobody has proven.
 *
 * @example
 *   const welcome = welcomeTiming(application, user.emailVerified);
 *   if (welcome === 'now') sendWelcomeEmail(application, user.email);
 */
export function welcomeTiming(application: Application, emailVerified: boolean): WelcomeTiming {
  const config = AuthConfigSchema.parse(application.authConfig);
  if (config.welcomeEmail === 'off') return 'never';
  if (emailVerified) return 'now';
  if (config.welcomeEmail === 'on_verified' || config.requireEmailVerification) return 'pending';
  return 'now';
}

/**
 * Send the welcome mail, fire and forget. A delivery failure never fails the
 * request that created the account. The per-event switch is honoured by
 * `dispatch`.
 *
 * @example
 *   sendWelcomeEmail(application, user.email, input.appUrl);
 */
export function sendWelcomeEmail(application: Application, to: string, appUrl?: string): void {
  void emailService
    .dispatch({
      application,
      eventKey: 'welcome',
      to,
      variables: {
        userEmail: to,
        // Empty when nothing resolves, which drops the button rather than
        // shipping a dead one. See lib/app-url.ts.
        appUrl: resolveAppUrl(application, appUrl) ?? '',
      },
    })
    .catch(() => undefined);
}

/**
 * Take the welcome that sign-up held back, if there is one. Conditional on the
 * flag, so of several verifications racing for one account exactly one gets
 * `true`. The flag is cleared either way; a welcome switched `off` since
 * sign-up is dropped rather than kept for later.
 *
 * @example
 *   const welcome = await claimPendingWelcome(tx, application, user.id);
 */
export async function claimPendingWelcome(
  tx: Prisma.TransactionClient,
  application: Application,
  endUserId: string,
): Promise<boolean> {
  const claimed = await tx.endUser.updateMany({
    where: { id: endUserId, welcomeEmailPending: true },
    data: { welcomeEmailPending: false },
  });
  if (claimed.count !== 1) return false;
  return AuthConfigSchema.parse(application.authConfig).welcomeEmail !== 'off';
}
