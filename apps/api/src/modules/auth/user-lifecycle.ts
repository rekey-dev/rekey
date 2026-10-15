import type { Application, EndUser, Prisma } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { resolveAppUrl } from '../../lib/app-url.js';
import { RekeyError } from '../../lib/error.js';
import { emailService } from '../email/email.service.js';
import { enqueueEvent } from '../webhooks/webhook.service.js';
import { recordSignIn, type SignInClient } from '../end-users/sign-in-stats.js';
import { claimDailyActivity } from '../end-users/daily-activity.js';
import { recordSecurityEventIn } from '../../lib/security-events.js';
import { lockEndUserCredentials } from '../../lib/session-basis.js';
import { generateLicenseKey } from '../../lib/license-keys.js';
import { applicationEmailScope, mayMailUnattended } from '../email/auth-email-caps.js';

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
export type UserUpdateSource =
  | 'self'
  | 'server'
  | 'operator'
  | 'email_verification'
  | 'magic_link'
  | 'oauth'
  | 'password_reset'
  | 'mfa';

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
  void (async (): Promise<void> => {
    if (!(await mayMailUnattended(applicationEmailScope(application), to))) return;
    await emailService.dispatch({
      application,
      eventKey: 'welcome',
      to,
      variables: {
        userEmail: to,
        // Empty when nothing resolves, which drops the button rather than
        // shipping a dead one. See lib/app-url.ts.
        appUrl: resolveAppUrl(application, appUrl) ?? '',
      },
    });
  })().catch(() => undefined);
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

/**
 * How a sign-in proved the mailbox. A reset carries the password its holder
 * just chose; an OAuth link names the identity that did the proving, which is
 * the one identity that stays.
 */
export type MailboxProof = (
  | { via: 'magic_link' }
  | { via: 'oauth'; keepIdentityId: string }
  | { via: 'password_reset'; passwordHash: string }
) & { ip?: string | null; userAgent?: string | null };

export type AccountClaim =
  | {
      kind: 'claimed';
      user: EndUser;
      deliveryIds: string[];
      welcome: boolean;
      /** A password, passkey or linked provider was removed, so the address is owed the notice. */
      signInMethodsRemoved: boolean;
    }
  /** An enrolled second factor stands in the way: nothing changed, see `promoteAfterMfa`. */
  | { kind: 'held_for_mfa' }
  | { kind: 'already_verified' };

/**
 * Hand an account whose address nobody had confirmed to the person who just
 * proved the mailbox.
 *
 * Sign-up asks for no proof of the address, so the password, sessions,
 * passkeys and linked providers on an unconfirmed account belong to whoever
 * registered first, who may not own the mailbox. Leaving any of them in place
 * would let that person keep signing in to an account its real owner now uses.
 * Everything that signs in is removed in the same transaction as the
 * `emailVerified` flip; the row, its role, profile, subscriptions, licences
 * and memberships stay with it.
 *
 * Conditional on `emailVerified: false`, so of several proofs racing for one
 * account exactly one claims it. An enrolled second factor is the exception:
 * it is neither removed nor trusted here, and the claim waits for the code.
 *
 * Not for the verification link. That link ratifies a sign-up, password
 * included; this replaces one.
 *
 * @example
 *   const claim = await claimUnverifiedAccount(tx, existing, { via: 'magic_link' });
 *   if (claim.kind === 'claimed') kickDeliveries(claim.deliveryIds);
 */
export async function claimUnverifiedAccount(
  tx: Prisma.TransactionClient,
  user: Pick<EndUser, 'id' | 'applicationId'>,
  provenBy: MailboxProof,
): Promise<AccountClaim> {
  // The row first: a sign-in or refresh in flight either wrote its session
  // before this and loses it below, or looks at the row afterwards and finds
  // the stamp moved (lib/session-basis.ts).
  await lockEndUserCredentials(tx, user.id);
  const mfa = await tx.mfaCredential.findUnique({
    where: { endUserId: user.id },
    select: { enrolledAt: true },
  });
  const unverified = await tx.endUser.findFirst({
    where: { id: user.id, emailVerified: false },
    select: { passwordHash: true },
  });
  if (unverified === null) return { kind: 'already_verified' };
  if (mfa?.enrolledAt) return { kind: 'held_for_mfa' };

  const now = new Date();
  const flipped = await tx.endUser.updateMany({
    where: { id: user.id, emailVerified: false },
    data: {
      emailVerified: true,
      passwordHash: provenBy.via === 'password_reset' ? provenBy.passwordHash : null,
      sessionsInvalidBefore: now,
    },
  });
  if (flipped.count !== 1) return { kind: 'already_verified' };

  const sessions = await tx.refreshToken.updateMany({
    where: { endUserId: user.id, revokedAt: null },
    data: { revokedAt: now },
  });
  const passkeys = await tx.webAuthnCredential.deleteMany({ where: { endUserId: user.id } });
  await tx.mfaCredential.deleteMany({ where: { endUserId: user.id } });
  const identities = await tx.oAuthIdentity.deleteMany({
    where: {
      endUserId: user.id,
      ...(provenBy.via === 'oauth' && { id: { not: provenBy.keepIdentityId } }),
    },
  });
  await tx.passwordResetToken.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
  await tx.emailVerificationToken.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
  await tx.oAuthAuthCode.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
  // Released, not deleted: licence seats and the operator's device history
  // point at these rows. A released device ends the tokens bound to it and
  // gives its slot back to the owner.
  const devices = await tx.device.updateMany({
    where: { endUserId: user.id, status: 'ACTIVE' },
    data: { status: 'RELEASED', releasedAt: now },
  });

  // Invitations this account sent and nobody accepted: whoever accepted one
  // later would join an organization on the word of the first registrant.
  const invitations = await tx.organizationInvitation.updateMany({
    where: { invitedById: user.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  // A licence key is shown once, to whoever was signed in when it was issued,
  // and it activates devices by itself. The person proving the mailbox now
  // never saw it, so replacing it costs them nothing and ends it for the
  // first registrant. The raw replacement is discarded: nobody is here to be
  // shown it, and the integrator reissues from `user.updated`. Licences pooled
  // to an organization are left alone, other members rely on those keys.
  const licences = await tx.license.findMany({
    where: { endUserId: user.id, organizationId: null, status: 'ACTIVE', revokedAt: null },
    select: { id: true },
  });
  for (const licence of licences) {
    const replacement = generateLicenseKey();
    await tx.licenseActivation.deleteMany({ where: { licenseId: licence.id } });
    await tx.license.update({
      where: { id: licence.id },
      data: { keyHash: replacement.hash, keyPrefix: replacement.prefix },
    });
  }

  const claimed = await tx.endUser.findUniqueOrThrow({ where: { id: user.id } });
  // Links for this address minted before it had an account carry no user id.
  // SKIP LOCKED leaves alone a link another request is consuming right now:
  // that request holds its link's row and is waiting for this user's, so
  // deleting it here would deadlock two proofs of the same mailbox.
  await tx.$executeRaw`
    DELETE FROM magic_link_tokens WHERE id IN (
      SELECT id FROM magic_link_tokens
      WHERE consumed_at IS NULL
        AND (end_user_id = ${user.id}
          OR (end_user_id IS NULL AND application_id = ${user.applicationId} AND email = ${claimed.email}))
      FOR UPDATE SKIP LOCKED
    )`;
  const application = await tx.application.findUniqueOrThrow({ where: { id: user.applicationId } });
  await recordSecurityEventIn(tx, {
    type: 'auth.unverified_account_claimed',
    actorType: 'end_user',
    actorId: user.id,
    tenantId: application.tenantId,
    applicationId: application.id,
    ip: provenBy.ip ?? null,
    userAgent: provenBy.userAgent ?? null,
    metadata: {
      provenBy: provenBy.via,
      passwordRemoved: unverified.passwordHash !== null && provenBy.via !== 'password_reset',
      passwordReplaced: provenBy.via === 'password_reset',
      sessionsRevoked: sessions.count,
      passkeysRemoved: passkeys.count,
      oauthIdentitiesRemoved: identities.count,
      devicesReleased: devices.count,
      organizationInvitationsRevoked: invitations.count,
      licenseKeysReplaced: licences.length,
    },
  });
  const deliveryIds = await enqueueUserUpdated(tx, {
    user: claimed,
    changed: licences.length > 0 ? ['emailVerified', 'credentials', 'licenseKeys'] : ['emailVerified', 'credentials'],
    via: provenBy.via,
  });
  return {
    kind: 'claimed',
    user: claimed,
    deliveryIds,
    welcome: await claimPendingWelcome(tx, application, user.id),
    signInMethodsRemoved:
      (unverified.passwordHash !== null && provenBy.via !== 'password_reset') ||
      passkeys.count > 0 ||
      identities.count > 0 ||
      licences.length > 0,
  };
}

/**
 * Finish a claim that waited on a second factor. The mailbox proof came with
 * the challenge and the code proves the prover enrolled that factor, so the
 * account was theirs all along: promote it and remove nothing.
 *
 * @example
 *   if (claims.mbx) await promoteAfterMfa(tx, application, endUser.id);
 */
export async function promoteAfterMfa(
  tx: Prisma.TransactionClient,
  application: Application,
  endUserId: string,
): Promise<{ user: EndUser; deliveryIds: string[]; welcome: boolean }> {
  const flipped = await tx.endUser.updateMany({
    where: { id: endUserId, emailVerified: false },
    data: { emailVerified: true },
  });
  const user = await tx.endUser.findUniqueOrThrow({ where: { id: endUserId } });
  if (flipped.count !== 1) return { user, deliveryIds: [], welcome: false };
  return {
    user,
    deliveryIds: await enqueueUserUpdated(tx, { user, changed: ['emailVerified'], via: 'mfa' }),
    welcome: await claimPendingWelcome(tx, application, endUserId),
  };
}

/**
 * Tell the address that its earlier sign-in details are gone. A security
 * notice, so it is never counted against the per-recipient cap. Fire and
 * forget.
 *
 * @example
 *   sendAccountClaimedEmail(application, user.email);
 */
export function sendAccountClaimedEmail(application: Application, to: string): void {
  void emailService
    .dispatch({
      application,
      eventKey: 'account_claimed',
      to,
      variables: {
        userEmail: to,
        claimedAtIso: new Date().toISOString(),
        appUrl: resolveAppUrl(application) ?? '',
      },
    })
    .catch(() => undefined);
}

/**
 * Refuse to add a sign-in method to an account whose address is unconfirmed.
 *
 * A passkey, a second factor or a linked provider added before the mailbox is
 * proven would survive as a way in for whoever registered the address first.
 * Refusing them keeps an unconfirmed account down to a password and its
 * sessions, which a claim removes.
 *
 * @example
 *   assertVerifiedForCredential(endUser, 'register a passkey');
 */
export function assertVerifiedForCredential(
  user: Pick<EndUser, 'emailVerified'>,
  action: string,
): void {
  if (user.emailVerified) return;
  throw new RekeyError({
    statusCode: 403,
    code: 'EMAIL_NOT_VERIFIED',
    message: `Confirm this account's email address before you ${action}.`,
    fix: 'Have the user click the link in their verification email (POST /api/v1/auth/send-verification mails a new one for the signed-in user, POST /api/v1/auth/verify-email consumes it), then retry. A magic-link sign-in also confirms the address, and removes the password chosen at sign-up.',
  });
}
