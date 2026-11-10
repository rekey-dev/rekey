/**
 * Changing a signed-in end-user's email address.
 *
 * The request mails a confirmation link to the NEW address and a notice to the
 * old one; nothing changes until the link is confirmed. The link is an
 * ordinary email-verification token whose address is not the account's
 * current one, so it is stored, hashed and expired by `lib/email-verification`
 * like every other, and `/auth/verify-email` refuses it as stale.
 *
 * The rules:
 *   - The requester is told the same thing whether or not the new address
 *     already has an account. When it does, that address gets a mail saying
 *     so instead of a link, and the change can never complete.
 *   - Confirming needs the token AND either a signed-in session of the same
 *     account or its current password: a forwarded or intercepted link alone
 *     moves nothing.
 *   - On confirmation the new address is verified (the link proved it), every
 *     session ends, and every unspent link mailed to the old address
 *     (verification, reset, sign-in) stops working. Linked social identities,
 *     passkeys and two-factor stay: they are not keyed by the address.
 *   - A pending change dies when every session is ended (password change,
 *     reset, sign-out everywhere), a newer request replaces it, and it expires
 *     after an hour.
 */

import { Prisma, type Application } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { verifyPassword } from '../../lib/passwords.js';
import { assertNotLocked, clearFailures, euLoginLockScope, LOGIN_POLICY, registerFailure } from '../../lib/brute-force.js';
import { assertAllowedTokenUrl, buildTokenUrl, defaultAuthLinkPage } from '../../lib/app-url.js';
import { issueVerificationToken, lookupVerificationToken } from '../../lib/email-verification.js';
import { fromEndedGeneration, revokeAllForEndUser } from '../../lib/refresh-tokens.js';
import { lockEndUserCredentials } from '../../lib/session-basis.js';
import { emailDomainAllowed } from '../../lib/signup-policy.js';
import { kickDeliveries } from '../webhooks/webhook.service.js';
import { emailService } from '../email/email.service.js';
import { applicationEmailScope, authEmailCappedError, reserveAuthEmail } from '../email/auth-email-caps.js';
import { assertEndUserCanAuthenticate } from './auth.service.js';
import { enqueueUserUpdated } from './user-lifecycle.js';

const LINK_LIFETIME_MS = 60 * 60 * 1000;

function linkInvalid(): RekeyError {
  return new RekeyError({
    statusCode: 401,
    code: 'EMAIL_CHANGE_TOKEN_INVALID',
    message: 'This email change link is unknown, used, expired, or was cancelled.',
    fix: 'Ask for the change again from the signed-in account (POST /api/v1/users/me/email) and use the newest link. A link works once, for an hour, and a password change, a reset or sign-out everywhere cancels it.',
  });
}

/**
 * @example
 *   await requestEmailChange({ application, endUserId, newEmail: 'new@example.com' });
 */
export async function requestEmailChange(input: {
  application: Application;
  endUserId: string;
  newEmail: string;
  /** Link template with `{token}`; defaults to the app's or hosted portal's email-change page. */
  confirmUrl?: string;
}): Promise<{ sent: true }> {
  const user = await prisma.endUser.findUniqueOrThrow({ where: { id: input.endUserId } });
  const newEmail = input.newEmail.trim().toLowerCase();
  if (newEmail === user.email) {
    throw new RekeyError({
      statusCode: 400,
      code: 'EMAIL_CHANGE_SAME_ADDRESS',
      message: 'That is already the address on this account.',
      fix: 'Send a different `newEmail`.',
    });
  }
  const config = AuthConfigSchema.parse(input.application.authConfig);
  if (!emailDomainAllowed(config.signupRestrictions, newEmail)) {
    throw new RekeyError({
      statusCode: 403,
      code: 'EMAIL_CHANGE_DOMAIN_NOT_ALLOWED',
      message: 'This application does not accept accounts at that email address.',
      fix: 'Use an address the application accepts for sign-up. Its operator sets the allowed and blocked domains.',
    });
  }
  assertAllowedTokenUrl(input.application, input.confirmUrl, 'confirmUrl');
  const page = input.confirmUrl === undefined ? defaultAuthLinkPage(input.application, 'emailChange') : null;
  if (input.confirmUrl === undefined && page === null) {
    throw new RekeyError({
      statusCode: 400,
      code: 'EMAIL_CHANGE_URL_REQUIRED',
      message: 'No page to confirm an email change on could be worked out for this application.',
      fix: 'Send `confirmUrl` with a `{token}` placeholder on a registered origin, or set authConfig.appUrl, or turn on the hosted portal.',
    });
  }

  // Counted before the address is looked up, so the cap says nothing about it.
  const reserved = await reserveAuthEmail(applicationEmailScope(input.application), newEmail);
  if (!reserved.allowed) throw authEmailCappedError(reserved.retryAfterSeconds);

  const taken = await prisma.endUser.findUnique({
    where: { applicationId_email: { applicationId: input.application.id, email: newEmail } },
    select: { id: true },
  });
  // A newer request replaces any pending one. Tokens for the current address
  // are ordinary verification links and are left alone.
  await prisma.emailVerificationToken.deleteMany({
    where: { endUserId: user.id, consumedAt: null, email: { not: user.email } },
  });
  // Minted on both paths so they do the same work; a token for a taken
  // address is never mailed and confirming it is refused.
  const issued = await issueVerificationToken({
    applicationId: input.application.id,
    endUserId: user.id,
    email: newEmail,
    lifetimeMs: LINK_LIFETIME_MS,
  });
  const outcome = taken
    ? await emailService.dispatch({
        application: input.application,
        eventKey: 'email_change_address_taken',
        to: newEmail,
        variables: { userEmail: newEmail },
      })
    : await emailService.dispatch({
        application: input.application,
        eventKey: 'email_change_confirm',
        to: newEmail,
        variables: {
          userEmail: newEmail,
          previousEmail: user.email,
          confirmUrl:
            input.confirmUrl !== undefined
              ? input.confirmUrl.replace('{token}', encodeURIComponent(issued.raw))
              : buildTokenUrl(page, '', issued.raw),
          expiresAtIso: issued.record.expiresAt.toISOString(),
        },
      });
  // A suppression is the operator's switch and answers like a send; only a
  // broken or missing transport, which fails both paths alike, is reported.
  if (outcome.kind === 'no_transport' || (outcome.kind === 'error' && outcome.suppressed !== true)) {
    await prisma.emailVerificationToken.deleteMany({ where: { id: issued.record.id } });
    await reserved.unsent();
    throw new RekeyError({
      statusCode: 503,
      code: 'EMAIL_CHANGE_NOT_SENT',
      message: 'The confirmation email could not be sent, so nothing was requested.',
      fix: 'The Application has no working email delivery: check its email settings in the panel (Email), then ask again.',
    });
  }
  void emailService
    .dispatch({
      application: input.application,
      eventKey: 'email_change_requested',
      to: user.email,
      variables: { userEmail: user.email, newEmail, requestedAtIso: new Date().toISOString() },
    })
    .catch(() => undefined);
  return { sent: true };
}

/**
 * @example
 *   await confirmEmailChange({ application, token, sessionEndUserId: req.endUser?.id });
 */
export async function confirmEmailChange(input: {
  application: Application;
  token: string;
  /** The signed-in end-user presenting the link, if a session came with it. */
  sessionEndUserId?: string;
  password?: string;
}): Promise<{ ok: true; email: string; endUserId: string }> {
  const outcome = await lookupVerificationToken(input.token);
  if (outcome.kind !== 'ok' || outcome.token.applicationId !== input.application.id) throw linkInvalid();
  const token = outcome.token;
  const user = await prisma.endUser.findUniqueOrThrow({ where: { id: token.endUserId } });
  assertEndUserCanAuthenticate(user);
  // A link for the current address is a verification link, not a change.
  if (token.email === user.email) throw linkInvalid();
  // Every session ended since the request (a password change, a reset, sign
  // out everywhere) cancels it: whoever asked may be who was just locked out.
  if (fromEndedGeneration(token, user.sessionsInvalidBefore)) throw linkInvalid();

  if (input.sessionEndUserId !== user.id) {
    if (!input.password) {
      throw new RekeyError({
        statusCode: 401,
        code: 'EMAIL_CHANGE_PROOF_REQUIRED',
        message: 'Confirming an email change needs a session of the same account, or its current password.',
        fix: 'Send the request with the account\'s X-Rekey-User-Token, or send `password` with the account\'s current password. An account with no password signs in first.',
      });
    }
    // Same lockout as sign-in: this checks the same secret.
    const lockScope = euLoginLockScope(input.application.id, user.email);
    await assertNotLocked(lockScope);
    if (!(await verifyPassword(user.passwordHash, input.password))) {
      await registerFailure(lockScope, LOGIN_POLICY);
      throw new RekeyError({
        statusCode: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'That is not the current password of the account this link belongs to.',
        fix: 'Send the account\'s current password, or confirm while signed in to it.',
      });
    }
    await clearFailures(lockScope);
  }

  const config = AuthConfigSchema.parse(input.application.authConfig);
  if (!emailDomainAllowed(config.signupRestrictions, token.email)) {
    throw new RekeyError({
      statusCode: 403,
      code: 'EMAIL_CHANGE_DOMAIN_NOT_ALLOWED',
      message: 'This application does not accept accounts at that email address.',
      fix: 'Ask for a change to an address the application accepts for sign-up.',
    });
  }

  const addressTaken = (): RekeyError =>
    new RekeyError({
      statusCode: 409,
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'Another account in this application already uses that email address, so nothing changed.',
      fix: 'Sign in to that account instead, or ask for a change to a different address.',
    });
  let deliveryIds: string[];
  try {
    deliveryIds = await prisma.$transaction(async (tx) => {
      await lockEndUserCredentials(tx, user.id);
      const spent = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (spent.count !== 1) throw linkInvalid();
      const updated = await tx.endUser.update({
        where: { id: user.id },
        data: { email: token.email, emailVerified: true },
      });
      // Links already mailed to the old address must not outlive the change.
      await tx.emailVerificationToken.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
      await tx.passwordResetToken.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
      await tx.magicLinkToken.deleteMany({ where: { endUserId: user.id, consumedAt: null } });
      await revokeAllForEndUser(user.id, tx);
      return enqueueUserUpdated(tx, {
        user: updated,
        changed: user.emailVerified ? ['email'] : ['email', 'emailVerified'],
        via: 'self',
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw addressTaken();
    throw err;
  }
  kickDeliveries(deliveryIds);
  return { ok: true, email: token.email, endUserId: user.id };
}
