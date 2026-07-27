/**
 * Step-up re-authentication for privileged self-service actions.
 *
 * The problem this exists to solve: an end-user access token is a bearer
 * credential, and some self-service actions are worth more than the token that
 * reaches them. Enrolling a passkey is the sharpest example — a passkey bypasses
 * the MFA challenge at sign-in, and neither `change-password` (which requires the
 * current password) nor `sign-out-everywhere` removes an attacker's enrolled
 * credential. So a stolen token that can enroll one buys persistent account
 * takeover that the victim cannot revoke by any normal means.
 *
 * The answer is not "keep those actions on the secret key". That is a deployment
 * restriction masquerading as a security control: it makes the flow unreachable
 * from a browser-only app while doing nothing about the stolen-token case on a
 * server-side one. What actually helps is demanding a SECOND proof, one the token
 * alone does not carry.
 *
 * This generalises the narrow version that already lived inside
 * `mfaService.disable`, which demanded a current TOTP code from publishable
 * callers. One implementation, so a future action gets step-up by calling it
 * rather than by inventing a third variant.
 *
 * Accepted proofs, any one of:
 *   - the account's current password
 *   - a current TOTP code, or an unused backup code, when MFA is enrolled
 *
 * Deliberately NOT accepted: a recent sign-in timestamp. "You signed in five
 * minutes ago" is a property of the same stolen token, so it proves nothing about
 * who is holding it.
 *
 * Only enforced for PUBLISHABLE callers. A secret key is a server-side
 * credential: the customer's backend is the trusted gate, it already decides
 * which of its users may do what, and requiring a factor there would break
 * published SDK signatures for no gain.
 */

import type { EndUser } from '@prisma/client';
import { prisma } from './prisma.js';
import { RekeyError } from './error.js';
import { verifyPassword } from './passwords.js';

/** Proof material a caller may supply. Both optional; any ONE that verifies passes. */
export interface StepUpProof {
  /** The account's current password. */
  password?: string | undefined;
  /** A current TOTP code, or an unused backup code. */
  code?: string | undefined;
}

/** Verifies a TOTP or backup code for this user. Injected to avoid a cycle with mfa.service. */
export type MfaCodeVerifier = (args: { endUserId: string; code: string }) => Promise<boolean>;

/**
 * Throw unless the caller has re-proved identity.
 *
 * @param action Short human phrase naming what is being protected, used in the
 *   error message so the client can say something useful ("enroll a passkey").
 */
export async function assertStepUp(args: {
  endUserId: string;
  proof: StepUpProof;
  action: string;
  verifyMfaCode: MfaCodeVerifier;
}): Promise<void> {
  const { endUserId, proof, action, verifyMfaCode } = args;

  // `req.endUser` is a PublicEndUser with passwordHash stripped, so read the row
  // rather than trusting whatever the caller passed in.
  const row = await prisma.endUser.findUnique({
    where: { id: endUserId },
    select: { passwordHash: true },
  });
  const enrolled = await prisma.mfaCredential.findUnique({
    where: { endUserId },
    select: { enrolledAt: true },
  });

  const hasPassword = typeof row?.passwordHash === 'string' && row.passwordHash.length > 0;
  const hasMfa = enrolled?.enrolledAt != null;

  // Nothing to prove WITH. An OAuth-only account with no MFA has exactly one
  // credential — the access token now being presented — so no challenge we could
  // issue would tell the real owner apart from someone holding a stolen token.
  // Refuse rather than wave it through: waving it through is the takeover this
  // function exists to prevent, and pretending otherwise would be worse than
  // having no step-up at all.
  if (!hasPassword && !hasMfa) {
    throw new RekeyError({
      statusCode: 400,
      code: 'STEP_UP_UNAVAILABLE',
      message: `This account has no password and no authenticator, so there is no second factor to confirm before it can ${action}.`,
      fix: 'Set a password or enroll MFA first, then retry. A server-side caller using an Application secret key is not required to step up.',
    });
  }

  if (proof.code !== undefined && proof.code !== '' && hasMfa) {
    if (await verifyMfaCode({ endUserId, code: proof.code })) return;
  }

  if (proof.password !== undefined && proof.password !== '' && hasPassword) {
    if (await verifyPassword(row!.passwordHash, proof.password)) return;
  }

  // One message for "you sent nothing" and "what you sent was wrong". Splitting
  // them would report whether a given code or password was valid, which is a
  // guessing oracle on a route that is not otherwise rate-limited per attempt.
  throw new RekeyError({
    statusCode: 401,
    code: 'STEP_UP_REQUIRED',
    message: `Confirm it is you before you ${action}.`,
    fix: hasMfa
      ? 'Send `code` with a current 6-digit authenticator code or an unused backup code, or `password` with the account password.'
      : 'Send `password` with the account password.',
  });
}
