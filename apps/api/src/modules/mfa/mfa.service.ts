/**
 * MFA service for end-users.
 *
 * Three-step enrollment:
 *   1. POST /mfa/setup        → returns otpauth URI + 10 backup codes (one-time-show)
 *   2. POST /mfa/setup-confirm { code } → user proves they scanned the QR; we set `enrolledAt`
 *   3. From now on, sign-in returns `mfaRequired` + an `mfaChallengeToken`
 *      instead of a session; the client completes it at
 *      POST /api/v1/auth/mfa-verify { mfaChallengeToken, code }. (Not
 *      /mfa/challenge, that route needs an existing session and is step-up for
 *      sensitive actions, not sign-in completion.)
 *
 * Backup codes are consumed by removing the matching hash from the stored array.
 */

import type { Application, EndUser } from '@prisma/client';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import { generateSecret, generateBackupCodes, matchTotpStep } from '../../lib/mfa.js';
import { assertNotLocked, clearFailures, MFA_POLICY, registerFailure } from '../../lib/brute-force.js';
import {
  acceptTotpCode,
  claimTotpStep,
  matchMfaCode,
  mfaCodeReusedError,
  type BackupCodeStore,
  type MfaMatch,
  type TotpOutcome,
} from '../../lib/mfa-replay.js';
import { emailService } from '../email/email.service.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';

interface SetupResult {
  /** otpauth:// URI for QR. The customer's app turns this into a QR code. */
  otpauthUrl: string;
  /** Plaintext backup codes, show ONCE, then forget. Only hashes are stored. */
  backupCodes: string[];
}

function backupStore(endUserId: string): BackupCodeStore {
  return {
    swap: async (expected, next, spentHash) => {
      const { count } = await prisma.mfaCredential.updateMany({
        where: { endUserId, backupCodesCiphertext: expected },
        data: { backupCodesCiphertext: next, usedBackupCodeHashes: { push: spentHash } },
      });
      return count === 1;
    },
    reload: async () =>
      (
        await prisma.mfaCredential.findUnique({
          where: { endUserId },
          select: { backupCodesCiphertext: true },
        })
      )?.backupCodesCiphertext ?? null,
  };
}

export const mfaService = {
  /**
   * Initialise MFA. Stores secret + backup-code hashes (encrypted), but
   * does NOT mark `enrolledAt` until the user proves they have the secret
   * via /mfa/setup-confirm. Sign-in only enforces MFA when enrolled.
   *
   * **The `update` branch un-enrolls an enrolled user.** That is what makes
   * this route a credential change rather than a setup step: calling it resets
   * `enrolledAt: null`, so the user's real authenticator stops counting and a
   * secret the caller chose takes its place, reaching the same end as
   * `/mfa/disable` without passing its guard. The route demands a current
   * factor from browser callers for exactly that reason; see `mfa.routes.ts`.
   */
  async setup(args: { endUser: EndUser; issuer: string }): Promise<SetupResult> {
    const secret = generateSecret(args.issuer, args.endUser.email);
    const backups = generateBackupCodes();

    await prisma.mfaCredential.upsert({
      where: { endUserId: args.endUser.id },
      create: {
        endUserId: args.endUser.id,
        secretCiphertext: encryptJson({ base32: secret.base32 }),
        backupCodesCiphertext: encryptJson(backups.hashes),
        enrolledAt: null,
      },
      update: {
        secretCiphertext: encryptJson({ base32: secret.base32 }),
        backupCodesCiphertext: encryptJson(backups.hashes),
        usedBackupCodeHashes: [],
        enrolledAt: null,
      },
    });

    return {
      otpauthUrl: secret.otpauthUrl,
      backupCodes: backups.plaintext,
    };
  },

  async confirm(args: {
    endUserId: string;
    code: string;
    /**
     * Required: enrollment sends a security-critical "2FA was turned on"
     * notification, and both the email template and the outbound webhook are
     * Application-scoped. Making it non-optional means a new caller cannot
     * silently skip that notification.
     */
    application: Application;
  }): Promise<{ ok: true }> {
    const cred = await prisma.mfaCredential.findUnique({
      where: { endUserId: args.endUserId },
    });
    if (!cred) {
      throw new RekeyError({
        statusCode: 400,
        code: 'MFA_NOT_INITIATED',
        message: 'Call /mfa/setup before /mfa/setup-confirm.',
        fix: 'POST to /api/v1/auth/mfa/setup first to mint a secret + backup codes.',
      });
    }
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    const outcome = await acceptTotpCode(base32, args.code);
    if (outcome === 'reused') throw mfaCodeReusedError('enrolment');
    if (outcome === 'invalid') {
      // 422 (not 401): this is enrollment confirmation, the caller is already
      // authenticated, only the submitted TOTP is wrong. 401 would signal an
      // invalid session/credential and trip client-side "log out" handling.
      throw new RekeyError({
        statusCode: 422,
        code: 'MFA_CODE_INVALID',
        message: 'TOTP code did not verify.',
        fix: 'Re-scan the QR if your authenticator clock is out of sync, then enter the current 6-digit code.',
      });
    }
    const enabledAt = new Date();
    // `mfa.enabled` commits with the enrollment it announces.
    const { endUser, deliveryIds } = await prisma.$transaction(async (tx) => {
      await tx.mfaCredential.update({
        where: { endUserId: args.endUserId },
        data: { enrolledAt: enabledAt },
      });
      const user = await tx.endUser.findUnique({
        where: { id: args.endUserId },
        select: { email: true },
      });
      const ids = user
        ? await enqueueEvent(tx, {
            applicationId: args.application.id,
            type: 'mfa.enabled',
            data: { userId: args.endUserId, email: user.email, enabledAt: enabledAt.toISOString() },
          })
        : [];
      return { endUser: user, deliveryIds: ids };
    });
    kickDeliveries(deliveryIds);

    // Security-critical confirmation: notify the user that 2FA was turned
    // on. Fire-and-forget, a delivery failure must not block enrollment.
    if (endUser) {
      void emailService
        .dispatch({
          application: args.application,
          eventKey: 'mfa_enabled',
          to: endUser.email,
          variables: {
            userEmail: endUser.email,
            enabledAtIso: enabledAt.toISOString(),
          },
        })
        .catch(() => undefined);
    }

    return { ok: true };
  },

  /**
   * Match a TOTP or backup code without spending it; `spend` on the result
   * consumes it. Sign-in uses the gap to refuse on the device limit only
   * after the second factor is proven, and without costing the user the code.
   * The lockout is enforced and counted here (a per-credential Redis limiter,
   * which bounds distributed multi-IP guessing that a per-IP limit misses).
   */
  async match(args: { endUserId: string; code: string }): Promise<MfaMatch> {
    const cred = await prisma.mfaCredential.findUnique({
      where: { endUserId: args.endUserId },
    });
    if (!cred || !cred.enrolledAt) return { outcome: 'invalid' };
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    return matchMfaCode(
      {
        base32,
        backupCodesCiphertext: cred.backupCodesCiphertext,
        usedBackupCodeHashes: cred.usedBackupCodeHashes,
        backupStore: backupStore(args.endUserId),
        lockScope: `eu:mfa:${args.endUserId}`,
      },
      args.code,
    );
  },

  /**
   * Check a TOTP or backup code and spend it. Both are single-use: a TOTP
   * code's time step is recorded on accept, a backup code is removed.
   * `reused` is a TOTP code that matched but was already accepted. It is
   * refused but not counted toward the lockout: it is not a guess, and a
   * double-submitted form must not burn the user's attempts.
   */
  async check(args: { endUserId: string; code: string }): Promise<TotpOutcome> {
    const match = await this.match(args);
    return match.outcome === 'matched' ? match.spend() : match.outcome;
  },

  /** `check`, as a yes or no for callers that answer every refusal the same way. */
  async verify(args: { endUserId: string; code: string }): Promise<boolean> {
    return (await this.check(args)) === 'accepted';
  },

  /**
   * Turn MFA off.
   *
   * `requireCode` is set for browser (publishable-key) callers. Disabling MFA
   * used to be secret-key-only, so in practice only the customer's backend
   * could reach it and could gate it however it liked. Now that a browser can
   * call it with just a user session, an attacker holding a stolen access token
   * could otherwise switch off the one control specifically meant to survive
   * token theft. So a browser must prove a current factor first; a secret-key
   * caller keeps the previous contract (its backend is the trusted gate, and
   * adding a required field would break existing integrations).
   */
  async disable(args: {
    endUserId: string;
    application?: Application;
    requireCode?: boolean;
    code?: string | undefined;
  }): Promise<void> {
    // Only demand a factor when one is actually enrolled. `verify` returns
    // false for a credential with enrolledAt=null, so requiring a code
    // unconditionally turned "cancel a half-finished enrollment" into a 401,
    // disable used to be a successful no-op there.
    const enrolled = await prisma.mfaCredential.findUnique({
      where: { endUserId: args.endUserId },
      select: { enrolledAt: true },
    });
    if (args.requireCode && enrolled?.enrolledAt) {
      // Keeps the historical MFA_CODE_INVALID code and message: clients switch on
      // it, and this route has always demanded specifically a code. The shared
      // `assertStepUp` in lib/step-up.ts is the generalised version used by
      // passkey enrollment, which additionally accepts the account password,
      // that is deliberately NOT accepted here. Someone who has stolen a session
      // and knows the password should not be able to strip the factor that exists
      // precisely to survive both.
      const outcome = args.code ? await this.check({ endUserId: args.endUserId, code: args.code }) : 'invalid';
      if (outcome === 'reused') throw mfaCodeReusedError('step-up');
      if (outcome !== 'accepted') {
        throw new RekeyError({
          statusCode: 401,
          code: 'MFA_CODE_INVALID',
          message: 'Disabling MFA from a browser requires a current authenticator or backup code.',
          fix: 'Send `code` with a current 6-digit TOTP or an unused backup code. Server-side callers using a secret key are not required to.',
        });
      }
    }
    const application = args.application;
    const deliveryIds = await prisma.$transaction(async (tx) => {
      const removed = await tx.mfaCredential.deleteMany({ where: { endUserId: args.endUserId } });
      if (removed.count === 0 || !application) return [];
      return enqueueEvent(tx, {
        applicationId: application.id,
        type: 'mfa.disabled',
        data: { userId: args.endUserId },
      });
    });
    kickDeliveries(deliveryIds);
  },

  /**
   * Replace the backup codes of an enrolled authenticator, invalidating every
   * old one. Accepts only a current TOTP code: a backup code would let one
   * leaked code mint ten, and a stolen session alone must not be able to mint
   * any. Counted against the same lockout as every other MFA code check.
   */
  async regenerateBackupCodes(args: { endUserId: string; code: string }): Promise<string[]> {
    const cred = await prisma.mfaCredential.findUnique({ where: { endUserId: args.endUserId } });
    if (!cred?.enrolledAt) {
      throw new RekeyError({
        statusCode: 409,
        code: 'MFA_NOT_ENROLLED',
        message: 'This account has no two-factor authenticator, so it has no backup codes to replace.',
        fix: 'Turn on two-factor first: POST /api/v1/auth/mfa/setup, then POST /api/v1/auth/mfa/setup-confirm. Setup returns the first set of backup codes.',
      });
    }
    const lockScope = `eu:mfa:${args.endUserId}`;
    await assertNotLocked(lockScope, 'MFA_TOO_MANY_ATTEMPTS');
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    const step = matchTotpStep(base32, args.code);
    if (step === null) {
      await registerFailure(lockScope, MFA_POLICY);
      throw new RekeyError({
        statusCode: 401,
        code: 'MFA_CODE_INVALID',
        message: 'New backup codes need a current code from the authenticator app. A backup code is not accepted.',
        fix: 'Send `code` with the 6-digit code the authenticator app shows now.',
      });
    }
    if (!(await claimTotpStep(base32, step))) throw mfaCodeReusedError('authenticator-only');
    await clearFailures(lockScope);
    const backups = generateBackupCodes();
    await prisma.mfaCredential.update({
      where: { endUserId: args.endUserId },
      data: { backupCodesCiphertext: encryptJson(backups.hashes), usedBackupCodeHashes: [] },
    });
    return backups.plaintext;
  },

  async status(endUserId: string): Promise<{ enabled: boolean; remainingBackupCodes: number | null }> {
    const cred = await prisma.mfaCredential.findUnique({ where: { endUserId } });
    if (!cred || !cred.enrolledAt) return { enabled: false, remainingBackupCodes: null };
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    return { enabled: true, remainingBackupCodes: stored.length };
  },

  /** True if this end-user has MFA enrolled, used by sign-in to gate the session. */
  async isEnrolled(endUserId: string): Promise<boolean> {
    const cred = await prisma.mfaCredential.findUnique({
      where: { endUserId },
      select: { enrolledAt: true },
    });
    return Boolean(cred?.enrolledAt);
  },
};

/**
 * Whether the Application's `mfa: 'required'` policy is unmet for this user:
 * the policy is `required` and they have no confirmed authenticator. A passkey
 * does not count. Sign-in's `mfaEnrollmentRequired` flag and the session guard
 * both decide with this, so they cannot disagree.
 *
 * @example
 * if (await mfaEnrollmentOutstanding(application, endUser.id)) redirectToSetUp();
 */
export async function mfaEnrollmentOutstanding(
  application: Pick<Application, 'authConfig'>,
  endUserId: string,
): Promise<boolean> {
  if (AuthConfigSchema.parse(application.authConfig).mfa !== 'required') return false;
  return !(await mfaService.isEnrolled(endUserId));
}
