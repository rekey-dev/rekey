/**
 * GDPR end-user erasure (roadmap §10).
 *
 * The ERASURE flow is distinct from a plain DELETE. A plain delete relies on
 * the schema's `onDelete: Cascade` FKs and removes the EndUser row plus every
 * dependent row — including financial records the operator may be legally
 * obliged to retain (invoices/payments for tax/accounting). Erasure instead:
 *
 *   1. HARD-DELETES pure PII / auth-credential rows (the data a data-subject
 *      erasure request is actually about): OAuth identities, refresh-token
 *      sessions of every kind (session AND the per-app OAuth/OIDC `mcp` ones),
 *      MFA, passkeys, magic-link / password-reset / email-verify tokens, and
 *      unredeemed OAuth authorization codes.
 *   2. ANONYMIZES the EndUser row in place (TOMBSTONE): email → a non-routable
 *      tombstone, name/metadata nulled, passwordHash cleared, `erasedAt` set.
 *   3. RETAINS but PII-SCRUBS financial / accounting rows — Subscription,
 *      Payment, License, CreditLedger, CreditBalance, UsageRecord. These keep
 *      their FK to the (now tombstoned) EndUser so the books stay intact, but
 *      any PII duplicated into their `metadata` / `description` is scrubbed.
 *
 * WHY tombstone instead of hard-delete + null FKs: the retained financial
 * rows FK to EndUser with `onDelete: Cascade`. Deleting the EndUser would
 * cascade them away, defeating retention. Keeping the row (PII stripped) is
 * the minimal change that satisfies both "erase the person's data" and "keep
 * the financial record". See docs/data-erasure.md for the full matrix.
 *
 * Idempotent: erasing an already-erased user is a no-op (returns the existing
 * `erasedAt`). All mutations run in a single transaction.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { webhookService } from '../webhooks/webhook.service.js';
import { clearFailures, euLoginLockScope } from '../../lib/brute-force.js';

/** Non-routable tombstone address. `.invalid` is reserved (RFC 2606) so it can never deliver. */
export function tombstoneEmail(endUserId: string): string {
  return `erased+${endUserId}@deleted.invalid`;
}

export interface EraseResult {
  /** True if this call performed the erasure; false if already erased (idempotent no-op). */
  erased: boolean;
  erasedAt: string;
  /** Per-model counts of what was hard-deleted vs scrubbed (for the audit metadata). */
  counts: {
    oauthIdentities: number;
    sessions: number;
    mfa: number;
    passkeys: number;
    magicLinkTokens: number;
    passwordResetTokens: number;
    emailVerificationTokens: number;
    oauthAuthCodes: number;
    subscriptionsScrubbed: number;
    paymentsScrubbed: number;
    licensesScrubbed: number;
    creditLedgerScrubbed: number;
    usageRecordsScrubbed: number;
  };
}

/**
 * Erase one end-user. Caller MUST have already authorized + confirmed the user
 * belongs to `applicationId` (the route does this). `operatorUserId` is
 * recorded on the tombstone for the audit trail.
 */
export async function eraseEndUser(args: {
  applicationId: string;
  endUserId: string;
  operatorUserId: string;
}): Promise<EraseResult> {
  const { applicationId, endUserId, operatorUserId } = args;

  // Captured inside the tx, used after it commits: the brute-force limiter is
  // in Redis, so clearing the lock cannot join the transaction.
  let erasedEmail: string | null = null;

  const result = await prisma.$transaction(async (tx) => {
    // Re-read inside the tx — guards against a concurrent erase / delete.
    const user = await tx.endUser.findUnique({ where: { id: endUserId } });
    if (!user || user.applicationId !== applicationId) {
      return null; // Vanished between the route check and here — treat as not-found upstream.
    }
    erasedEmail = user.email;
    if (user.erasedAt !== null) {
      // Already a tombstone — idempotent no-op.
      return {
        erased: false,
        erasedAt: user.erasedAt.toISOString(),
        counts: {
          oauthIdentities: 0, sessions: 0, mfa: 0, passkeys: 0,
          magicLinkTokens: 0, passwordResetTokens: 0, emailVerificationTokens: 0,
          oauthAuthCodes: 0,
          subscriptionsScrubbed: 0, paymentsScrubbed: 0, licensesScrubbed: 0,
          creditLedgerScrubbed: 0, usageRecordsScrubbed: 0,
        },
      } satisfies EraseResult;
    }

    // ── 1. HARD-DELETE pure PII / auth-credential rows ──────────────────────
    const [
      oauth,
      sessions,
      mfa,
      passkeys,
      magicLinks,
      pwdResets,
      emailVerifs,
      authCodes,
    ] = await Promise.all([
      tx.oAuthIdentity.deleteMany({ where: { endUserId } }),
      // Every kind, `mcp` included: an OAuth/OIDC refresh token is a 30-day
      // credential for this person's account like any other.
      tx.refreshToken.deleteMany({ where: { endUserId } }),
      tx.mfaCredential.deleteMany({ where: { endUserId } }),
      tx.webAuthnCredential.deleteMany({ where: { endUserId } }),
      tx.magicLinkToken.deleteMany({ where: { endUserId } }),
      tx.passwordResetToken.deleteMany({ where: { endUserId } }),
      tx.emailVerificationToken.deleteMany({ where: { endUserId } }),
      // Unredeemed authorization codes. 60-second TTL, so this rarely deletes
      // anything — but a code minted moments before the erasure is a live
      // credential, and the redemption path's own erasure gate should not be
      // the only thing standing between it and an `id_token` about someone we
      // have just promised to forget.
      tx.oAuthAuthCode.deleteMany({ where: { endUserId } }),
    ]);

    // ── 2. ANONYMIZE / scrub PII duplicated onto RETAINED financial rows ────
    // The canonical email lives on the EndUser (tombstoned below); these rows
    // hold no direct PII columns, but their free-form `metadata` / `description`
    // could, so we null/clear them. The numeric/accounting fields stay intact.
    const [subs, payments, licenses, ledger, usage] = await Promise.all([
      tx.subscription.updateMany({
        where: { applicationId, endUserId },
        data: { metadata: {} },
      }),
      tx.payment.updateMany({
        where: { applicationId, endUserId },
        data: { metadata: {}, description: null },
      }),
      tx.license.updateMany({
        where: { applicationId, endUserId },
        data: { metadata: {} },
      }),
      tx.creditLedger.updateMany({
        where: { applicationId, endUserId },
        data: { metadata: {}, description: null },
      }),
      // UsageRecord has no FK to EndUser (scalar endUserId) — scoped by meter.
      tx.usageRecord.updateMany({
        where: { endUserId, meter: { applicationId } },
        data: { metadata: {} },
      }),
    ]);
    // CreditBalance carries no free-form PII (just a numeric balance) — retained
    // as-is via its FK to the tombstone.

    // ── 3. TOMBSTONE the EndUser row in place ───────────────────────────────
    const erasedAt = new Date();
    await tx.endUser.update({
      where: { id: endUserId },
      data: {
        email: tombstoneEmail(endUserId),
        emailVerified: false,
        passwordHash: null,
        // Null the free-form profile PII (display name, avatar, custom fields).
        metadata: Prisma.DbNull,
        role: 'user',
        erasedAt,
        erasedBy: operatorUserId,
      },
    });

    return {
      erased: true,
      erasedAt: erasedAt.toISOString(),
      counts: {
        oauthIdentities: oauth.count,
        sessions: sessions.count,
        mfa: mfa.count,
        passkeys: passkeys.count,
        magicLinkTokens: magicLinks.count,
        passwordResetTokens: pwdResets.count,
        emailVerificationTokens: emailVerifs.count,
        oauthAuthCodes: authCodes.count,
        subscriptionsScrubbed: subs.count,
        paymentsScrubbed: payments.count,
        licensesScrubbed: licenses.count,
        creditLedgerScrubbed: ledger.count,
        usageRecordsScrubbed: usage.count,
      },
    } satisfies EraseResult;
  });

  if (result === null) return null as unknown as EraseResult;

  // Drop any live failed-sign-in counter / lockout for the erased address.
  //
  // This replaces the old `failedSignInAttempts: 0, lockedUntil: null` on the
  // tombstone update, which stopped meaning anything when lockout moved to
  // Redis (and whose columns are now gone). It is not cosmetic: the limiter's
  // key is `bf:lock:eu:login:<appId>:<email>`, so it holds the erased address in
  // PLAINTEXT for up to the 15-minute lock TTL, and the super-admin
  // locked-accounts list enumerates exactly those keys. An erasure that leaves
  // the email sitting in a Redis key an operator dashboard reads back is not an
  // erasure. Best-effort by design (`clearFailures` swallows store errors) —
  // failing here must not roll back a committed erasure, and the TTL is the
  // backstop.
  if (result.erased && erasedEmail !== null) {
    await clearFailures(euLoginLockScope(applicationId, erasedEmail));
  }

  // Outbound webhook — only on a real transition (not the idempotent no-op).
  // Fire-and-forget, same contract as the auth emit-sites.
  if (result.erased) {
    void webhookService
      .emit({
        applicationId,
        type: 'user.erased',
        data: {
          user: {
            id: endUserId,
            erasedAt: result.erasedAt,
          },
        },
      })
      .catch(() => undefined);
  }

  return result;
}
