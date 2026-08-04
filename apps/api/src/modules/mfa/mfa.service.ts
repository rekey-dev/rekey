/**
 * MFA service for end-users.
 *
 * Three-step enrollment:
 *   1. POST /mfa/setup        → returns otpauth URI + 10 backup codes (one-time-show)
 *   2. POST /mfa/setup-confirm { code } → user proves they scanned the QR; we set `enrolledAt`
 *   3. From now on, sign-in returns `mfaRequired` + an `mfaChallengeToken`
 *      instead of a session; the client completes it at
 *      POST /api/v1/auth/mfa-verify { mfaChallengeToken, code }. (Not
 *      /mfa/challenge — that route needs an existing session and is step-up for
 *      sensitive actions, not sign-in completion.)
 *
 * Backup codes are consumed by removing the matching hash from the stored array.
 */

import type { Application, EndUser } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import {
  generateSecret,
  generateBackupCodes,
  verifyTotp,
  consumeBackupCode,
} from '../../lib/mfa.js';
import { assertNotLocked, registerFailure, clearFailures, MFA_POLICY } from '../../lib/brute-force.js';
import { emailService } from '../email/email.service.js';
import { emitDetached } from '../webhooks/webhook.service.js';

interface SetupResult {
  /** otpauth:// URI for QR. The customer's app turns this into a QR code. */
  otpauthUrl: string;
  /** Plaintext backup codes — show ONCE, then forget. Only hashes are stored. */
  backupCodes: string[];
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
   * secret the caller chose takes its place — reaching the same end as
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
    if (!verifyTotp(base32, args.code)) {
      // 422 (not 401): this is enrollment confirmation — the caller is already
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
    await prisma.mfaCredential.update({
      where: { endUserId: args.endUserId },
      data: { enrolledAt: enabledAt },
    });

    // Security-critical confirmation: notify the user that 2FA was turned
    // on. Fire-and-forget — a delivery failure must not block enrollment.
    const endUser = await prisma.endUser.findUnique({
      where: { id: args.endUserId },
      select: { email: true },
    });
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
      emitDetached({
        applicationId: args.application.id,
        type: 'mfa.enabled',
        data: { userId: args.endUserId, email: endUser.email, enabledAt: enabledAt.toISOString() },
      });
    }

    return { ok: true };
  },

  /**
   * Verify a TOTP or backup code at sign-in time. Returns true on success.
   * Backup codes are single-use — consumed on accept.
   */
  async verify(args: { endUserId: string; code: string }): Promise<boolean> {
    const cred = await prisma.mfaCredential.findUnique({
      where: { endUserId: args.endUserId },
    });
    if (!cred || !cred.enrolledAt) return false;
    // Per-credential throttle via the Redis brute-force limiter — throws 429
    // if too many recent failures. Bounds distributed (multi-IP) TOTP guessing
    // that a per-IP rate limit alone wouldn't catch.
    const mfaScope = `eu:mfa:${args.endUserId}`;
    await assertNotLocked(mfaScope, 'MFA_TOO_MANY_ATTEMPTS');

    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    if (verifyTotp(base32, args.code)) {
      await clearFailures(mfaScope);
      return true;
    }

    // Try backup code path.
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    const remaining = consumeBackupCode(stored, args.code);
    if (!remaining) {
      await registerFailure(mfaScope, MFA_POLICY);
      return false;
    }
    await prisma.mfaCredential.update({
      where: { endUserId: args.endUserId },
      data: { backupCodesCiphertext: encryptJson(remaining) },
    });
    await clearFailures(mfaScope);
    return true;
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
    // unconditionally turned "cancel a half-finished enrollment" into a 401 —
    // disable used to be a successful no-op there.
    const enrolled = await prisma.mfaCredential.findUnique({
      where: { endUserId: args.endUserId },
      select: { enrolledAt: true },
    });
    if (args.requireCode && enrolled?.enrolledAt) {
      // Keeps the historical MFA_CODE_INVALID code and message: clients switch on
      // it, and this route has always demanded specifically a code. The shared
      // `assertStepUp` in lib/step-up.ts is the generalised version used by
      // passkey enrollment, which additionally accepts the account password —
      // that is deliberately NOT accepted here. Someone who has stolen a session
      // and knows the password should not be able to strip the factor that exists
      // precisely to survive both.
      const ok = args.code ? await this.verify({ endUserId: args.endUserId, code: args.code }) : false;
      if (!ok) {
        throw new RekeyError({
          statusCode: 401,
          code: 'MFA_CODE_INVALID',
          message: 'Disabling MFA from a browser requires a current authenticator or backup code.',
          fix: 'Send `code` with a current 6-digit TOTP or an unused backup code. Server-side callers using a secret key are not required to.',
        });
      }
    }
    const removed = await prisma.mfaCredential.deleteMany({ where: { endUserId: args.endUserId } });
    if (removed.count > 0 && args.application) {
      emitDetached({
        applicationId: args.application.id,
        type: 'mfa.disabled',
        data: { userId: args.endUserId },
      });
    }
  },

  async status(endUserId: string): Promise<{ enabled: boolean; remainingBackupCodes: number | null }> {
    const cred = await prisma.mfaCredential.findUnique({ where: { endUserId } });
    if (!cred || !cred.enrolledAt) return { enabled: false, remainingBackupCodes: null };
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    return { enabled: true, remainingBackupCodes: stored.length };
  },

  /** True if this end-user has MFA enrolled — used by sign-in to gate the session. */
  async isEnrolled(endUserId: string): Promise<boolean> {
    const cred = await prisma.mfaCredential.findUnique({ where: { endUserId } });
    return Boolean(cred?.enrolledAt);
  },
};
