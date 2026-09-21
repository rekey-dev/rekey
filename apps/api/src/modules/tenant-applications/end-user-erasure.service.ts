/**
 * GDPR end-user erasure (roadmap §10).
 *
 * The ERASURE flow is distinct from a plain DELETE. A plain delete relies on
 * the schema's `onDelete: Cascade` FKs and removes the EndUser row plus every
 * dependent row, including financial records the operator may be legally
 * obliged to retain (invoices/payments for tax/accounting). Erasure instead:
 *
 *   1. HARD-DELETES pure PII / auth-credential rows (the data a data-subject
 *      erasure request is actually about): OAuth identities, refresh-token
 *      sessions of every kind (session AND the per-app OAuth/OIDC `mcp` ones),
 *      MFA, passkeys, magic-link / password-reset / email-verify tokens, and
 *      unredeemed OAuth authorization codes.
 *   2. ANONYMIZES the EndUser row in place (TOMBSTONE): email → a non-routable
 *      tombstone, name/metadata nulled, passwordHash cleared, `erasedAt` set.
 *   3. RETAINS but PII-SCRUBS financial / accounting rows, Subscription,
 *      Payment, License, CreditLedger, CreditBalance, UsageRecord. These keep
 *      their FK to the (now tombstoned) EndUser so the books stay intact, but
 *      any PII duplicated into their `metadata` / `description` is scrubbed.
 *   4. SCRUBS the logs that copied the address when something was sent or
 *      received: email logs (rows kept, recipient tombstoned), email
 *      suppressions (deleted), outbound webhook delivery payloads and inbound
 *      billing receipts (rows kept, personal fields rewritten).
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
import { emitDetached } from '../webhooks/webhook.service.js';
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
    devicesDeleted: number;
    licenseActivationsScrubbed: number;
    creditLedgerScrubbed: number;
    usageRecordsScrubbed: number;
    emailLogsScrubbed: number;
    emailSuppressionsDeleted: number;
    webhookDeliveriesScrubbed: number;
    webhookEventsScrubbed: number;
  };
}

/** Rows loaded, rewritten and written back per statement when scrubbing payloads. */
const SCRUB_CHUNK = 500;

/**
 * Keys in an outbound webhook payload that carry personal data about the
 * subject. These payloads are shapes Rekey writes itself (auth, device and
 * billing emit sites), so the keys are known: `email` becomes the tombstone,
 * a device `fingerprint` is erased the way LicenseActivation's is, and the
 * free-form fields are nulled the way erasure nulls them on the source rows.
 */
const DELIVERY_NULLED_KEYS = new Set(['metadata', 'label', 'description']);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A case-insensitive match for any of the addresses as a whole address, used
 * both in JS and (via `.source`) by Postgres `regexp_replace`, whose ARE
 * dialect accepts the same syntax. Bounded on both sides, so a different
 * address that CONTAINS this one (`x` + address, or the address with another
 * domain label after it) is never rewritten.
 */
function addressPattern(addresses: readonly string[]): RegExp {
  // Never an empty alternation: that matches between every character.
  if (addresses.length === 0) return /(?!)/g;
  const body = addresses.map(escapeRegExp).join('|');
  return new RegExp(`(?<![A-Za-z0-9._%+-])(?:${body})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'gi');
}

interface ScrubContext {
  /** Matches any of the person's addresses, case-insensitively, anywhere in a string. */
  pattern: RegExp;
  tombstone: string;
  /** Apply DELIVERY_NULLED_KEYS / email / fingerprint rules (our own payloads only). */
  personalKeys: boolean;
}

function scrubJson(value: unknown, ctx: ScrubContext, key: string | null): unknown {
  if (ctx.personalKeys && key !== null) {
    if (key === 'email' && typeof value === 'string') return ctx.tombstone;
    if (key === 'fingerprint' && typeof value === 'string') return 'erased';
    if (DELIVERY_NULLED_KEYS.has(key)) return null;
  }
  if (typeof value === 'string') return value.replace(ctx.pattern, ctx.tombstone);
  if (Array.isArray(value)) return value.map((v) => scrubJson(v, ctx, null));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubJson(v, ctx, k);
    return out;
  }
  return value;
}

/**
 * Rewrite the `payload` of the given rows through `scrubJson`, a chunk at a
 * time, and return how many actually changed.
 *
 * Raw SQL rather than `update` per row for two reasons: one statement per chunk
 * instead of one round trip per row while the erasure transaction holds its
 * locks, and `webhook_deliveries.updated_at` is Prisma-managed, so a Prisma
 * update would bump it. The log retention sweep ages deliveries by that column,
 * and a scrub is not activity that should restart a delivery's retention clock.
 */
async function scrubPayloads(
  tx: Prisma.TransactionClient,
  table: 'webhook_deliveries' | 'webhook_events',
  ids: readonly string[],
  ctx: ScrubContext,
): Promise<number> {
  let changed = 0;
  for (let i = 0; i < ids.length; i += SCRUB_CHUNK) {
    const chunk = ids.slice(i, i + SCRUB_CHUNK);
    const rows =
      table === 'webhook_deliveries'
        ? await tx.webhookDelivery.findMany({ where: { id: { in: chunk } }, select: { id: true, payload: true } })
        : await tx.webhookEvent.findMany({ where: { id: { in: chunk } }, select: { id: true, payload: true } });
    const updates: Array<{ id: string; payload: unknown }> = [];
    for (const row of rows) {
      const next = scrubJson(row.payload, ctx, null);
      if (JSON.stringify(next) !== JSON.stringify(row.payload)) updates.push({ id: row.id, payload: next });
    }
    if (updates.length === 0) continue;
    const json = JSON.stringify(updates);
    if (table === 'webhook_deliveries') {
      await tx.$executeRaw`
        UPDATE webhook_deliveries AS d SET payload = v.payload
        FROM jsonb_to_recordset(${json}::jsonb) AS v(id text, payload jsonb)
        WHERE d.id = v.id`;
    } else {
      await tx.$executeRaw`
        UPDATE webhook_events AS e SET payload = v.payload
        FROM jsonb_to_recordset(${json}::jsonb) AS v(id text, payload jsonb)
        WHERE e.id = v.id`;
    }
    changed += updates.length;
  }
  return changed;
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
    // Re-read inside the tx, guards against a concurrent erase / delete.
    const user = await tx.endUser.findUnique({ where: { id: endUserId } });
    if (!user || user.applicationId !== applicationId) {
      return null; // Vanished between the route check and here, treat as not-found upstream.
    }
    erasedEmail = user.email;
    if (user.erasedAt !== null) {
      // Already a tombstone, idempotent no-op.
      return {
        erased: false,
        erasedAt: user.erasedAt.toISOString(),
        counts: {
          oauthIdentities: 0, sessions: 0, mfa: 0, passkeys: 0,
          magicLinkTokens: 0, passwordResetTokens: 0, emailVerificationTokens: 0,
          oauthAuthCodes: 0,
          subscriptionsScrubbed: 0, paymentsScrubbed: 0, licensesScrubbed: 0,
          devicesDeleted: 0, licenseActivationsScrubbed: 0,
          creditLedgerScrubbed: 0, usageRecordsScrubbed: 0,
          emailLogsScrubbed: 0, emailSuppressionsDeleted: 0,
          webhookDeliveriesScrubbed: 0, webhookEventsScrubbed: 0,
        },
      } satisfies EraseResult;
    }

    // ── 0. The addresses this person has been mailed at ─────────────────────
    // Their current address, plus any address an outstanding verification or
    // magic-link token names (an email change mails the NEW address before the
    // account holds it). Read now: step 1 deletes those tokens. An address
    // another end-user of this Application currently holds is not theirs to
    // erase, so it is dropped; the current address is unique per Application.
    const tokenAddresses = (
      await Promise.all([
        tx.emailVerificationToken.findMany({ where: { endUserId }, select: { email: true } }),
        tx.magicLinkToken.findMany({ where: { endUserId }, select: { email: true } }),
      ])
    )
      .flat()
      .map((t) => t.email)
      .filter((e): e is string => typeof e === 'string' && e.length > 0)
      .map((e) => e.toLowerCase());
    const candidates = [...new Set([user.email.toLowerCase(), ...tokenAddresses])];
    const heldByOthers = new Set(
      (
        await tx.endUser.findMany({
          where: { applicationId, id: { not: endUserId }, email: { in: candidates } },
          select: { email: true },
        })
      ).map((u) => u.email.toLowerCase()),
    );
    const addresses = candidates.filter((a) => !heldByOthers.has(a));

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
      // anything, but a code minted moments before the erasure is a live
      // credential, and the redemption path's own erasure gate should not be
      // the only thing standing between it and an `id_token` about someone we
      // have just promised to forget.
      tx.oAuthAuthCode.deleteMany({ where: { endUserId } }),
    ]);

    // ── 1b. DEVICES and license activations: the fingerprint is a machine
    // identifier the person supplied and can be re-derived from their
    // hardware, so it is personal data in the same sense a MAC address is.
    // Devices are deleted outright (sessions and activations SET NULL their
    // pointer). Activations are RETAINED for seat accounting like the license
    // rows they hang off, but the fingerprint and label are tombstoned to a
    // per-row value, the (license, fingerprint) unique index needs each row
    // to stay distinct.
    // Which activations are THEIRS: every one on a licence they hold, plus,
    // on the org-pooled licences of organizations they belong to, the ones
    // that name a machine they registered. A pooled activation belongs to
    // the org, not to them, but still names their machine.
    //
    // A fingerprint alone does not make an activation theirs. Devices are
    // unique per end-user, so two accounts in one Application can register
    // the same fingerprint (a shared workstation, a client that derives it
    // from hardware alone), and matching on it across the Application would
    // release and rename another person's seat in the course of erasing
    // this one. The fingerprints are collected before the device rows go.
    const fingerprints = (
      await tx.device.findMany({ where: { applicationId, endUserId }, select: { fingerprint: true } })
    ).map((d) => d.fingerprint);
    const organizationIds = (
      await tx.organizationMembership.findMany({ where: { endUserId }, select: { organizationId: true } })
    ).map((m) => m.organizationId);
    const devices = await tx.device.deleteMany({ where: { applicationId, endUserId } });
    const activations = await tx.licenseActivation.findMany({
      where: {
        applicationId,
        OR: [
          { license: { endUserId } },
          ...(fingerprints.length > 0 && organizationIds.length > 0
            ? [
                {
                  machineFingerprint: { in: fingerprints },
                  license: { organizationId: { in: organizationIds } },
                },
              ]
            : []),
        ],
      },
      select: { id: true, releasedAt: true },
    });
    const now = new Date();
    for (const a of activations) {
      // Released as well as tombstoned: a seat held by a machine nobody can
      // name any more is a seat nobody can give back, and the same machine
      // verifying again would burn a second one.
      await tx.licenseActivation.update({
        where: { id: a.id },
        data: {
          machineFingerprint: `erased:${a.id}`,
          label: null,
          deviceId: null,
          ...(a.releasedAt === null && { releasedAt: now }),
        },
      });
    }

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
      // UsageRecord has no FK to EndUser (scalar endUserId), scoped by meter.
      tx.usageRecord.updateMany({
        where: { endUserId, meter: { applicationId } },
        data: { metadata: {} },
      }),
    ]);
    // CreditBalance carries no free-form PII (just a numeric balance), retained
    // as-is via its FK to the tombstone.

    // ── 2b. EMAIL and WEBHOOK logs: the address outlives the account ────────
    // Every table below duplicates the address (or other personal fields) at
    // the moment something was sent or received, so tombstoning the EndUser
    // row alone leaves it readable in the operator console and hands it to the
    // log archive when the rows age out. All four are scoped to this
    // Application: the same address in another Application is a different
    // data subject of a different controller.
    const tombstone = tombstoneEmail(endUserId);
    const scrubCtx = {
      pattern: addressPattern(addresses),
      tombstone,
    };

    // Email logs: rows KEPT, delivery counts are operational data. The
    // recipient becomes the tombstone, and so does any copy of the address in
    // a provider error message. The subject is replaced outright: templates
    // interpolate variables into it, so it can hold a name as easily as the
    // address. `to_address` is stored lowercased by both writers in
    // lib/email-transport.ts, so an exact match on the lowercased address is
    // the complete match and can use the (application_id, to_address) index.
    const emailLogs =
      addresses.length === 0
        ? 0
        : await tx.$executeRaw`
            UPDATE email_logs
            SET to_address = ${tombstone},
                subject = '[erased]',
                error = regexp_replace(error, ${scrubCtx.pattern.source}, ${tombstone}, 'gi')
            WHERE application_id = ${applicationId} AND to_address = ANY(${addresses})`;

    // Suppressions: DELETED. A hashed address kept to refuse a future sign-up
    // would still be personal data (anyone holding a candidate address can
    // test it), and the person it protected no longer exists here. A new
    // sign-up at that address is a new consent; a transport's own bounce and
    // complaint list is unaffected. See docs/data-erasure.md.
    const suppressions = await tx.emailSuppression.deleteMany({
      where: { applicationId, address: { in: addresses } },
    });

    // Outbound deliveries: rows and status KEPT, payload scrubbed. Matched by
    // the end-user id at the fixed places Rekey's own emit sites put it, not
    // by searching payloads for the address, so another user's event that
    // merely mentions a similar string is never rewritten. Ids first (a scan
    // of this Application's deliveries returning ids only), payloads in
    // bounded chunks after.
    const deliveryIds = (
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM webhook_deliveries
        WHERE application_id = ${applicationId}
          AND ${endUserId} IN (
            payload #>> '{data,user,id}',
            payload #>> '{data,userId}',
            payload #>> '{data,endUserId}',
            payload #>> '{data,device,endUserId}',
            payload #>> '{data,subscription,endUserId}',
            payload #>> '{data,payment,endUserId}',
            payload #>> '{data,dunningCase,endUserId}',
            payload #>> '{data,license,endUserId}'
          )`
    ).map((r) => r.id);
    const deliveriesScrubbed = await scrubPayloads(tx, 'webhook_deliveries', deliveryIds, {
      ...scrubCtx,
      personalKeys: true,
    });

    // Inbound billing receipts: the provider's own event body, which carries
    // the customer's address (Stripe `customer_email`, PayPal `payer`) but no
    // Rekey end-user id to match on. The address is the only reference there
    // is, so these are matched by it, within this Application only, and only
    // occurrences of the address are replaced: the shapes are the provider's,
    // and guessing which of its keys are personal would rewrite fields a
    // receipt needs. Nothing replays a stored receipt (the pipeline applies
    // the request body), so rewriting it changes no billing state.
    const eventIds =
      addresses.length === 0
        ? []
        : (
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT id FROM webhook_events
              WHERE application_id = ${applicationId}
                AND EXISTS (
                  SELECT 1 FROM unnest(${addresses}::text[]) AS a(address)
                  WHERE strpos(lower(payload::text), a.address) > 0
                )`
          ).map((r) => r.id);
    const eventsScrubbed = await scrubPayloads(tx, 'webhook_events', eventIds, {
      ...scrubCtx,
      personalKeys: false,
    });

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
        devicesDeleted: devices.count,
        licenseActivationsScrubbed: activations.length,
        creditLedgerScrubbed: ledger.count,
        usageRecordsScrubbed: usage.count,
        emailLogsScrubbed: emailLogs,
        emailSuppressionsDeleted: suppressions.count,
        webhookDeliveriesScrubbed: deliveriesScrubbed,
        webhookEventsScrubbed: eventsScrubbed,
      },
    } satisfies EraseResult;
    // Prisma's 5-second default is sized for a handful of statements. A
    // long-lived user's email and delivery history makes the work proportional
    // to their activity; it stays one transaction so an erasure is never half
    // applied, and only this person's rows are locked while it runs.
  }, { timeout: 60_000 });

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
  // erasure. Best-effort by design (`clearFailures` swallows store errors),
  // failing here must not roll back a committed erasure, and the TTL is the
  // backstop.
  if (result.erased && erasedEmail !== null) {
    await clearFailures(euLoginLockScope(applicationId, erasedEmail));
  }

  // Outbound webhook, only on a real transition (not the idempotent no-op).
  // Fire-and-forget, same contract as the auth emit-sites.
  if (result.erased) {
    emitDetached({
      applicationId,
      type: 'user.erased',
      data: {
        user: {
          id: endUserId,
          erasedAt: result.erasedAt,
        },
      },
    });
  }

  return result;
}
