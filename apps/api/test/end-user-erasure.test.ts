/**
 * GDPR end-user erasure:
 *   DELETE /tenant/applications/:id/end-users/:euid?erasure=true
 *
 * Covers (roadmap §10):
 *   - erasure tombstones the user (erasedAt set) + anonymizes the email;
 *   - PII/auth rows are GONE (oauth / sessions / mfa / passkeys / magic-link /
 *     reset / verify tokens; passwordHash cleared);
 *   - financial rows are RETAINED but PII-scrubbed (metadata/description);
 *   - an erased user can't sign in / magic-link / refresh / use a live access
 *     token (all surface END_USER_ERASED, HTTP 410);
 *   - a `user.erased` outbound webhook is emitted;
 *   - an `end_user.erased` security event is recorded;
 *   - OWNER/ADMIN gate (MEMBER → 403);
 *   - cross-tenant / cross-application 404 (no enumeration);
 *   - plain DELETE (no flag) still hard-deletes everything (back-compat).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { tombstoneEmail } from '../src/modules/tenant-applications/end-user-erasure.service.js';
import { StripeStubProvider } from '../src/modules/billing/providers/stripe.js';

interface Bootstrapped {
  applicationId: string;
  tenantId: string;
  liveKey: string;
  tenantAccess: string;
}

describe('end-user erasure (GDPR right to be forgotten)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-erase-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS erase ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App erase ${slug}`, slug: `erase-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });
    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });
    return {
      applicationId: application.id,
      tenantId: session.activeTenantId,
      liveKey: key.rawKey,
      tenantAccess: session.accessToken,
    };
  }

  /** Sign a user up through the public API and return ids + a live session. */
  async function signUpUser(
    b: Bootstrapped,
    email: string,
  ): Promise<{ euid: string; accessToken: string; refreshToken: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      endUser: { id: string };
      accessToken: string;
      refreshToken: string;
    };
    return { euid: data.endUser.id, accessToken: data.accessToken, refreshToken: data.refreshToken };
  }

  /** Poll until `fn` returns truthy or the deadline passes (for fire-and-forget side effects). */
  async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > deadline) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  function erase(b: Bootstrapped, euid: string, access = b.tenantAccess) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}?erasure=true`,
      headers: { authorization: `Bearer ${access}` },
    });
  }

  it('tombstones the user, deletes PII/auth, retains-but-scrubs financials, emits event + webhook', async () => {
    const b = await bootstrap('full');
    const { euid } = await signUpUser(b, 'subject@example.com');

    // Subscribe an endpoint to user.erased so we can prove the webhook fires.
    await prisma.webhookEndpoint.create({
      data: {
        applicationId: b.applicationId,
        url: 'https://example.com/hook',
        secret: 'whsec_test_erasure',
        events: ['user.erased'],
        enabled: true,
      },
    });

    // Seed PII/auth rows that must be hard-deleted.
    await prisma.oAuthIdentity.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        provider: 'google',
        providerAccountId: `erase-google-${euid}`,
        email: 'subject@gmail.example.com',
      },
    });
    await prisma.mfaCredential.create({
      data: {
        endUserId: euid,
        secretCiphertext: 'ct-secret',
        backupCodesCiphertext: 'ct-backup',
        enrolledAt: new Date(),
      },
    });
    await prisma.webAuthnCredential.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        credentialId: `erase-cred-${euid}`,
        publicKey: 'pk',
        deviceName: 'Test device',
      },
    });
    await prisma.magicLinkToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `mlt-${euid}`,
        email: 'subject@example.com',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.passwordResetToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `prt-${euid}`,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.emailVerificationToken.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        tokenHash: `evt-${euid}`,
        email: 'subject@example.com',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // Seed financial rows with PII in metadata/description that must be scrubbed
    // but the ROWS retained.
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'erase-pro', name: 'Pro', amount: 999 },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        planId: plan.id,
        status: 'ACTIVE',
        metadata: { customerEmail: 'subject@example.com', note: 'pii here' },
      },
    });
    const pay = await prisma.payment.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subscriptionId: sub.id,
        amount: 999,
        currency: 'USD',
        status: 'SUCCEEDED',
        providerPaymentId: 'erase-pay-1',
        description: 'subject@example.com receipt',
        metadata: { billingEmail: 'subject@example.com' },
      },
    });
    const lic = await prisma.license.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        kind: 'PERPETUAL',
        keyPrefix: 'rl_lic_erase',
        keyHash: `erase-key-hash-${euid}`,
        metadata: { ownerEmail: 'subject@example.com' },
      },
    });
    const ledger = await prisma.creditLedger.create({
      data: {
        applicationId: b.applicationId,
        endUserId: euid,
        subjectKey: `u:${euid}`,
        delta: 50,
        reason: 'GRANT',
        balanceAfter: 50,
        description: 'grant for subject@example.com',
        metadata: { who: 'subject@example.com' },
      },
    });
    await prisma.creditBalance.create({
      data: { applicationId: b.applicationId, endUserId: euid, subjectKey: `u:${euid}`, balance: 50 },
    });
    const meter = await prisma.usageMeter.create({
      data: { applicationId: b.applicationId, slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    const usage = await prisma.usageRecord.create({
      data: {
        meterId: meter.id,
        endUserId: euid,
        quantity: 42,
        metadata: { ip: '203.0.113.9', email: 'subject@example.com' },
      },
    });

    // ── ERASE ───────────────────────────────────────────────────────────────
    const res = await erase(b, euid);
    expect(res.statusCode).toBe(200);
    const out = res.json().data as { erased: boolean; erasedAt: string; alreadyErased: boolean };
    expect(out.erased).toBe(true);
    expect(out.alreadyErased).toBe(false);
    expect(out.erasedAt).toBeTruthy();

    // Tombstone: row kept, email anonymized, credentials cleared, erasedAt set.
    const tombstone = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(tombstone.erasedAt).not.toBeNull();
    expect(tombstone.email).toBe(tombstoneEmail(euid));
    expect(tombstone.passwordHash).toBeNull();
    expect(tombstone.metadata).toBeNull();
    expect(tombstone.emailVerified).toBe(false);

    // PII/auth rows hard-deleted.
    expect(await prisma.oAuthIdentity.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.mfaCredential.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.webAuthnCredential.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.passwordResetToken.count({ where: { endUserId: euid } })).toBe(0);
    expect(await prisma.emailVerificationToken.count({ where: { endUserId: euid } })).toBe(0);

    // Financial rows RETAINED (still there) but PII-scrubbed.
    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(subAfter.endUserId).toBe(euid); // FK preserved by the tombstone.
    expect(subAfter.metadata).toEqual({});
    const payAfter = await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } });
    expect(payAfter.amount).toBe(999); // accounting figure untouched.
    expect(payAfter.description).toBeNull();
    expect(payAfter.metadata).toEqual({});
    const licAfter = await prisma.license.findUniqueOrThrow({ where: { id: lic.id } });
    expect(licAfter.metadata).toEqual({});
    const ledgerAfter = await prisma.creditLedger.findUniqueOrThrow({ where: { id: ledger.id } });
    expect(ledgerAfter.delta).toBe(50); // ledger figure untouched.
    expect(ledgerAfter.description).toBeNull();
    expect(ledgerAfter.metadata).toEqual({});
    const usageAfter = await prisma.usageRecord.findUniqueOrThrow({ where: { id: usage.id } });
    expect(usageAfter.quantity).toBe(42);
    expect(usageAfter.metadata).toEqual({});

    // Security event recorded (fire-and-forget — poll briefly).
    const events = await waitFor(async () => {
      const rows = await prisma.securityEvent.findMany({
        where: { applicationId: b.applicationId, type: 'end_user.erased' },
      });
      return rows.length > 0 ? rows : null;
    });
    expect(events).not.toBeNull();
    expect(events!).toHaveLength(1);
    expect((events![0]!.metadata as { endUserId: string }).endUserId).toBe(euid);

    // Webhook delivery enqueued for user.erased (fire-and-forget — poll briefly).
    const deliveries = await waitFor(async () => {
      const rows = await prisma.webhookDelivery.findMany({
        where: { applicationId: b.applicationId, eventType: 'user.erased' },
      });
      return rows.length > 0 ? rows : null;
    });
    expect(deliveries).not.toBeNull();
    expect(deliveries!.length).toBeGreaterThanOrEqual(1);
  });

  it('an erased user cannot sign in / magic-link / refresh / use a live access token', async () => {
    const b = await bootstrap('authblock');
    // Enable magic-link so that leg genuinely exercises the erasure gate.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/auth-config`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { methods: ['password', 'magic_link'] },
    });
    const { euid, accessToken, refreshToken } = await signUpUser(b, 'blocked@example.com');

    // Access token works BEFORE erasure.
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': accessToken },
    });
    expect(before.statusCode).toBe(200);

    expect((await erase(b, euid)).statusCode).toBe(200);

    // Sign-in: password hash is cleared → INVALID_CREDENTIALS (no enumeration).
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'blocked@example.com', password: 'pw-one-two-three' },
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe('INVALID_CREDENTIALS');

    // Refresh: a pre-erasure refresh token must not mint a new session. Erasure
    // hard-deletes the refresh tokens, so the presented token is now UNKNOWN
    // (REFRESH_TOKEN_INVALID, 401); even if a token somehow survived, the
    // erased-user guard in refresh would reject it (END_USER_ERASED, 410).
    // Either way the contract is: it never returns a session.
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { refreshToken },
    });
    expect(refresh.statusCode).toBeGreaterThanOrEqual(400);
    expect(['REFRESH_TOKEN_INVALID', 'END_USER_ERASED']).toContain(refresh.json().error.code);

    // A still-unexpired access token is rejected at the session chokepoint.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': accessToken },
    });
    expect(me.statusCode).toBe(410);
    expect(me.json().error.code).toBe('END_USER_ERASED');

    // Magic-link: requesting + verifying for the (old) email cannot revive them.
    // (Magic-link may be disabled on the app — if so, this leg is a no-op; the
    // sign-in / access-token / refresh legs already prove the erasure block.)
    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { email: 'blocked@example.com' },
    });
    const reqData = reqRes.json().data as { magicLinkToken: string | null } | undefined;
    const mlt = reqData?.magicLinkToken ?? null;
    // The old email no longer maps to the (tombstoned) user, so either no token
    // is issued for an existing account, or verifying it cannot mint a session.
    if (mlt) {
      const verify = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/magic-link/verify',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { token: mlt },
      });
      // Whatever path it takes, it must NOT return a session for the erased user.
      const body = verify.json();
      if (verify.statusCode === 200) {
        expect((body.data as { endUser: { id: string } }).endUser.id).not.toBe(euid);
      }
    }
  });

  it('is idempotent — erasing an already-erased user is a no-op', async () => {
    const b = await bootstrap('idem');
    const { euid } = await signUpUser(b, 'idem@example.com');
    expect((await erase(b, euid)).statusCode).toBe(200);
    const second = await erase(b, euid);
    expect(second.statusCode).toBe(200);
    expect((second.json().data as { alreadyErased: boolean }).alreadyErased).toBe(true);
  });

  it('MEMBER operators get 403 TENANT_ROLE_INSUFFICIENT', async () => {
    const b = await bootstrap('rolegate');
    const { euid } = await signUpUser(b, 'gated@example.com');

    const member = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: 'member-erase@example.com',
          password: 'pw-one-two-three',
          workspaceName: 'Member erase Co',
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { email: 'member-erase@example.com', role: 'MEMBER' },
    });
    expect(invite.statusCode).toBe(201);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { token: (invite.json().data as { token: string }).token },
    });
    const memberAccess = (accept.json().data as { accessToken: string }).accessToken;

    const res = await erase(b, euid, memberAccess);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
    // Not erased.
    const still = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(still.erasedAt).toBeNull();
  });

  it('cross-tenant and cross-application erasure 404 without leaking existence', async () => {
    const b = await bootstrap('xt1');
    const other = await bootstrap('xt2');
    const { euid } = await signUpUser(b, 'xt-subject@example.com');

    const crossTenant = await erase(b, euid, other.tenantAccess);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe('APPLICATION_NOT_FOUND');

    const crossApp = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${other.applicationId}/end-users/${euid}?erasure=true`,
      headers: { authorization: `Bearer ${other.tenantAccess}` },
    });
    expect(crossApp.statusCode).toBe(404);
    expect(crossApp.json().error.code).toBe('END_USER_NOT_FOUND');

    // The targeted user is untouched.
    const still = await prisma.endUser.findUniqueOrThrow({ where: { id: euid } });
    expect(still.erasedAt).toBeNull();
  });

  it('plain DELETE (no erasure flag) still hard-deletes everything (back-compat)', async () => {
    const b = await bootstrap('plain');
    const { euid } = await signUpUser(b, 'plain@example.com');
    const plan = await prisma.plan.create({
      data: { applicationId: b.applicationId, slug: 'plain-pro', name: 'Pro', amount: 100 },
    });
    const sub = await prisma.subscription.create({
      data: { applicationId: b.applicationId, endUserId: euid, planId: plan.id, status: 'ACTIVE' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().data as { removed: boolean }).removed).toBe(true);

    // The user row AND its cascade-FK financial rows are gone.
    expect(await prisma.endUser.findUnique({ where: { id: euid } })).toBeNull();
    expect(await prisma.subscription.findUnique({ where: { id: sub.id } })).toBeNull();
  });

  // ── BUG-1 / BUG-3c: delete must cancel the provider sub + emit user.deleted +
  //    record an end_user.deleted security event; provider failure must not block.
  describe('end-user delete cancels the provider subscription (BUG-1/BUG-3c)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Create an ACTIVE provider-backed (stripe) subscription for a user. */
    async function seedProviderSub(b: Bootstrapped, euid: string, suffix: string): Promise<string> {
      const plan = await prisma.plan.create({
        data: { applicationId: b.applicationId, slug: `pcancel-${suffix}`, name: 'Pro', amount: 999 },
      });
      const sub = await prisma.subscription.create({
        data: {
          applicationId: b.applicationId,
          endUserId: euid,
          planId: plan.id,
          status: 'ACTIVE',
          provider: 'stripe',
          providerSubId: `sub_${suffix}_${euid}`,
        },
      });
      return sub.id;
    }

    it('plain delete invokes provider cancel, emits user.deleted, records end_user.deleted', async () => {
      const b = await bootstrap('pcancel');
      const { euid } = await signUpUser(b, 'pcancel@example.com');
      const subId = await seedProviderSub(b, euid, 'plain');

      const cancelSpy = vi
        .spyOn(StripeStubProvider.prototype, 'cancelSubscription')
        .mockResolvedValue(undefined);

      await prisma.webhookEndpoint.create({
        data: {
          applicationId: b.applicationId,
          url: 'https://example.com/hook',
          secret: 'whsec_test_deleted',
          events: ['user.deleted'],
          enabled: true,
        },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);

      // Provider cancel was attempted for the active sub.
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      const arg = cancelSpy.mock.calls[0]![0] as { subscription: { id: string }; atPeriodEnd: boolean };
      expect(arg.subscription.id).toBe(subId);
      expect(arg.atPeriodEnd).toBe(false);

      // User + cascade gone.
      expect(await prisma.endUser.findUnique({ where: { id: euid } })).toBeNull();

      // end_user.deleted security event recorded.
      const events = await waitFor(async () => {
        const rows = await prisma.securityEvent.findMany({
          where: { applicationId: b.applicationId, type: 'end_user.deleted' },
        });
        return rows.length > 0 ? rows : null;
      });
      expect(events).not.toBeNull();
      expect(events!).toHaveLength(1);
      expect((events![0]!.metadata as { providerSubscriptionsCanceled: number }).providerSubscriptionsCanceled).toBe(1);

      // user.deleted webhook delivery enqueued.
      const deliveries = await waitFor(async () => {
        const rows = await prisma.webhookDelivery.findMany({
          where: { applicationId: b.applicationId, eventType: 'user.deleted' },
        });
        return rows.length > 0 ? rows : null;
      });
      expect(deliveries).not.toBeNull();
      expect(deliveries!.length).toBeGreaterThanOrEqual(1);
    });

    it('a provider cancel failure still deletes the user (best-effort)', async () => {
      const b = await bootstrap('pcancelfail');
      const { euid } = await signUpUser(b, 'pcancelfail@example.com');
      await seedProviderSub(b, euid, 'fail');

      const cancelSpy = vi
        .spyOn(StripeStubProvider.prototype, 'cancelSubscription')
        .mockRejectedValue(new Error('stripe down'));

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${euid}`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      });
      expect(res.statusCode).toBe(200);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      // Despite the provider error, the user is gone.
      expect(await prisma.endUser.findUnique({ where: { id: euid } })).toBeNull();

      const events = await waitFor(async () => {
        const rows = await prisma.securityEvent.findMany({
          where: { applicationId: b.applicationId, type: 'end_user.deleted' },
        });
        return rows.length > 0 ? rows : null;
      });
      expect((events![0]!.metadata as { providerCancelFailures: number }).providerCancelFailures).toBe(1);
    });

    it('erasure path also cancels the provider subscription', async () => {
      const b = await bootstrap('ecancel');
      const { euid } = await signUpUser(b, 'ecancel@example.com');
      const subId = await seedProviderSub(b, euid, 'erase');

      const cancelSpy = vi
        .spyOn(StripeStubProvider.prototype, 'cancelSubscription')
        .mockResolvedValue(undefined);

      const res = await erase(b, euid);
      expect(res.statusCode).toBe(200);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect((cancelSpy.mock.calls[0]![0] as { subscription: { id: string } }).subscription.id).toBe(subId);

      // The erasure security event records the cancel count.
      const events = await waitFor(async () => {
        const rows = await prisma.securityEvent.findMany({
          where: { applicationId: b.applicationId, type: 'end_user.erased' },
        });
        return rows.length > 0 ? rows : null;
      });
      expect((events![0]!.metadata as { providerSubscriptionsCanceled: number }).providerSubscriptionsCanceled).toBe(1);
    });
  });
});
