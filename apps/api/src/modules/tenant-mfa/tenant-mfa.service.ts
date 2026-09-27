/**
 * Operator (TenantUser) MFA, mirrors `modules/mfa` for the operator side.
 * Writes to `tenant_mfa_credentials`. Same TOTP + backup-code primitives
 * via lib/mfa.ts.
 */

import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import { generateSecret, generateBackupCodes } from '../../lib/mfa.js';
import {
  acceptTotpCode,
  matchMfaCode,
  mfaCodeReusedError,
  type BackupCodeStore,
  type MfaMatch,
  type TotpOutcome,
} from '../../lib/mfa-replay.js';

function backupStore(tenantUserId: string): BackupCodeStore {
  return {
    swap: async (expected, next) => {
      const { count } = await prisma.tenantMfaCredential.updateMany({
        where: { tenantUserId, backupCodesCiphertext: expected },
        data: { backupCodesCiphertext: next },
      });
      return count === 1;
    },
    reload: async () =>
      (
        await prisma.tenantMfaCredential.findUnique({
          where: { tenantUserId },
          select: { backupCodesCiphertext: true },
        })
      )?.backupCodesCiphertext ?? null,
  };
}

export const tenantMfaService = {
  /**
   * Mint a fresh secret + backup codes. Enrollment is not complete until
   * `/setup-confirm`.
   *
   * **Re-enrolment is a credential change and the route steps it up.** This
   * method resets `enrolledAt: null` on an EXISTING credential, which was a way
   * around the disable guard: call setup, and the operator's enrolled
   * authenticator stops counting without anyone proving they hold it. The
   * step-up lives at the route (see `tenant-mfa.routes.ts`) because that is
   * where the caller's proof arrives; keep them together if either moves.
   */
  async setup(args: { tenantUserId: string; email: string; issuer?: string }): Promise<{
    otpauthUrl: string;
    backupCodes: string[];
  }> {
    const secret = generateSecret(args.issuer ?? 'Rekey Panel', args.email);
    const backups = generateBackupCodes();
    await prisma.tenantMfaCredential.upsert({
      where: { tenantUserId: args.tenantUserId },
      create: {
        tenantUserId: args.tenantUserId,
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
    return { otpauthUrl: secret.otpauthUrl, backupCodes: backups.plaintext };
  },

  async confirm(args: { tenantUserId: string; code: string }): Promise<{ ok: true }> {
    const cred = await prisma.tenantMfaCredential.findUnique({
      where: { tenantUserId: args.tenantUserId },
    });
    if (!cred) {
      throw new RekeyError({
        statusCode: 400,
        code: 'MFA_NOT_INITIATED',
        message: 'Call /mfa/setup before /mfa/setup-confirm.',
        fix: 'POST to /api/v1/tenant/auth/mfa/setup first.',
      });
    }
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    const outcome = await acceptTotpCode(base32, args.code);
    if (outcome === 'reused') throw mfaCodeReusedError('enrolment');
    if (outcome === 'invalid') {
      // 422 (not 401): the operator's *session* is valid, only the submitted
      // code is wrong. A 401 here makes the panel's api() client treat the
      // session as expired and log the operator out mid-enrollment.
      throw new RekeyError({
        statusCode: 422,
        code: 'MFA_CODE_INVALID',
        message: 'TOTP code did not verify.',
        fix: 'Re-scan the QR if your authenticator clock is out of sync, then enter the current 6-digit code.',
      });
    }
    await prisma.tenantMfaCredential.update({
      where: { tenantUserId: args.tenantUserId },
      data: { enrolledAt: new Date() },
    });
    return { ok: true };
  },

  /** Match a code without spending it. Mirrors `mfaService.match`. */
  async match(args: { tenantUserId: string; code: string }): Promise<MfaMatch> {
    const cred = await prisma.tenantMfaCredential.findUnique({
      where: { tenantUserId: args.tenantUserId },
    });
    if (!cred || !cred.enrolledAt) return { outcome: 'invalid' };
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    return matchMfaCode(
      {
        base32,
        backupCodesCiphertext: cred.backupCodesCiphertext,
        backupStore: backupStore(args.tenantUserId),
        lockScope: `op:mfa:${args.tenantUserId}`,
      },
      args.code,
    );
  },

  /** Check a TOTP or backup code and spend it. Mirrors `mfaService.check`. */
  async check(args: { tenantUserId: string; code: string }): Promise<TotpOutcome> {
    const match = await this.match(args);
    return match.outcome === 'matched' ? match.spend() : match.outcome;
  },

  async verify(args: { tenantUserId: string; code: string }): Promise<boolean> {
    return (await this.check(args)) === 'accepted';
  },

  /**
   * Turn operator MFA off. The step-up is at the route, for the same reason as
   * `setup`, and it is the whole control here: nothing else stands between a
   * stolen panel access token and the factor that exists to survive one.
   */
  async disable(tenantUserId: string): Promise<void> {
    await prisma.tenantMfaCredential.deleteMany({ where: { tenantUserId } });
  },

  /** Whether this operator has COMPLETED enrollment, the gate the step-up keys off. */
  async enrollmentComplete(tenantUserId: string): Promise<boolean> {
    const cred = await prisma.tenantMfaCredential.findUnique({
      where: { tenantUserId },
      select: { enrolledAt: true },
    });
    return cred?.enrolledAt != null;
  },

  async status(tenantUserId: string): Promise<{ enabled: boolean; remainingBackupCodes: number | null }> {
    const cred = await prisma.tenantMfaCredential.findUnique({ where: { tenantUserId } });
    if (!cred || !cred.enrolledAt) return { enabled: false, remainingBackupCodes: null };
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    return { enabled: true, remainingBackupCodes: stored.length };
  },

  /** Mirror of mfaService.isEnrolled, used by sign-in to gate the session. */
  async isEnrolled(tenantUserId: string): Promise<boolean> {
    const cred = await prisma.tenantMfaCredential.findUnique({ where: { tenantUserId } });
    return Boolean(cred?.enrolledAt);
  },
};
