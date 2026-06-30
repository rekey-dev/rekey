/**
 * Operator (TenantUser) MFA — mirrors `modules/mfa` for the operator side.
 * Writes to `tenant_mfa_credentials`. Same TOTP + backup-code primitives
 * via lib/mfa.ts.
 */

import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';
import { encryptJson, decryptJson } from '../../lib/secrets.js';
import {
  generateSecret,
  generateBackupCodes,
  verifyTotp,
  consumeBackupCode,
} from '../../lib/mfa.js';
import { assertNotLocked, registerFailure, clearFailures, MFA_POLICY } from '../../lib/brute-force.js';

export const tenantMfaService = {
  async setup(args: { tenantUserId: string; email: string; issuer?: string }): Promise<{
    otpauthUrl: string;
    backupCodes: string[];
  }> {
    const secret = generateSecret(args.issuer ?? 'ReliPay Panel', args.email);
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
      throw new RelipayError({
        statusCode: 400,
        code: 'MFA_NOT_INITIATED',
        message: 'Call /mfa/setup before /mfa/setup-confirm.',
        fix: 'POST to /api/v1/tenant/auth/mfa/setup first.',
      });
    }
    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    if (!verifyTotp(base32, args.code)) {
      // 422 (not 401): the operator's *session* is valid — only the submitted
      // code is wrong. A 401 here makes the panel's api() client treat the
      // session as expired and log the operator out mid-enrollment.
      throw new RelipayError({
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

  async verify(args: { tenantUserId: string; code: string }): Promise<boolean> {
    const cred = await prisma.tenantMfaCredential.findUnique({
      where: { tenantUserId: args.tenantUserId },
    });
    if (!cred || !cred.enrolledAt) return false;
    // Per-credential throttle via the Redis brute-force limiter (see mfa.service).
    const mfaScope = `op:mfa:${args.tenantUserId}`;
    await assertNotLocked(mfaScope, 'MFA_TOO_MANY_ATTEMPTS');

    const { base32 } = decryptJson<{ base32: string }>(cred.secretCiphertext);
    if (verifyTotp(base32, args.code)) {
      await clearFailures(mfaScope);
      return true;
    }
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    const remaining = consumeBackupCode(stored, args.code);
    if (!remaining) {
      await registerFailure(mfaScope, MFA_POLICY);
      return false;
    }
    await prisma.tenantMfaCredential.update({
      where: { tenantUserId: args.tenantUserId },
      data: { backupCodesCiphertext: encryptJson(remaining) },
    });
    await clearFailures(mfaScope);
    return true;
  },

  async disable(tenantUserId: string): Promise<void> {
    await prisma.tenantMfaCredential.deleteMany({ where: { tenantUserId } });
  },

  async status(tenantUserId: string): Promise<{ enabled: boolean; remainingBackupCodes: number | null }> {
    const cred = await prisma.tenantMfaCredential.findUnique({ where: { tenantUserId } });
    if (!cred || !cred.enrolledAt) return { enabled: false, remainingBackupCodes: null };
    const stored = decryptJson<string[]>(cred.backupCodesCiphertext);
    return { enabled: true, remainingBackupCodes: stored.length };
  },

  /** Mirror of mfaService.isEnrolled — used by sign-in to gate the session. */
  async isEnrolled(tenantUserId: string): Promise<boolean> {
    const cred = await prisma.tenantMfaCredential.findUnique({ where: { tenantUserId } });
    return Boolean(cred?.enrolledAt);
  },
};
