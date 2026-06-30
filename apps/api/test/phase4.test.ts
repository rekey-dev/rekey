/**
 * Phase 4 smoke tests — BYO billing creds, OAuth (with mock provider),
 * MFA, licenses, usage. Each new surface gets at least one happy path
 * + one failure-mode assertion.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { registerOAuthProvider } from '../src/modules/oauth/providers/index.js';
import { generateSecret } from '../src/lib/mfa.js';
import * as OTPAuth from 'otpauth';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  endUserId: string;
  endUserAccess: string;
  tenantAccess: string;
}

describe('Phase 4: BYO creds + OAuth + MFA + licenses + usage', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    // Tenant operator path (4.0).
    const tenantSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });

    // App via the tenant-scoped route.
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: `App ${slug}`, slug, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string });

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${application.id}/api-keys`,
        headers: { authorization: `Bearer ${tenantSession.accessToken}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => r.json().data as { rawKey: string });

    // End-user via the public auth surface.
    const endUserSession = await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: { authorization: `Bearer ${key.rawKey}` },
        payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { accessToken: string; endUser: { id: string } });

    return {
      applicationId: application.id,
      liveKey: key.rawKey,
      endUserId: endUserSession.endUser.id,
      endUserAccess: endUserSession.accessToken,
      tenantAccess: tenantSession.accessToken,
    };
  }

  // ---------- BYO billing creds ----------

  it('PUT /billing-credentials/stripe stores creds; list reflects configured', async () => {
    const b = await bootstrap('byo');

    let list = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })
      .then((r) => r.json().data as Array<{ provider: string; configured: boolean }>);
    expect(list).toEqual([]);

    const set = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { apiKey: 'sk_test_xxx', webhookSecret: 'whsec_xxx' },
      },
    });
    expect(set.statusCode).toBe(200);

    list = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })
      .then((r) => r.json().data as Array<{ provider: string; configured: boolean }>);
    expect(list).toHaveLength(1);
    expect(list[0]!.provider).toBe('stripe');
    expect(list[0]!.configured).toBe(true);

    // Verify stored ciphertext does NOT contain plaintext apiKey.
    const stored = await prisma.billingCredentials.findUniqueOrThrow({
      where: { applicationId_provider: { applicationId: b.applicationId, provider: 'stripe' } },
    });
    expect(stored.ciphertext).toBeTruthy();
    expect(stored.ciphertext).not.toContain('sk_test_xxx');
    expect(stored.ciphertext).not.toContain('whsec_xxx');
  });

  it('PUT /billing-credentials/stripe rejects malformed values', async () => {
    const b = await bootstrap('byo-bad');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { apiKey: 'definitely-not-stripe', webhookSecret: 'whsec_xxx' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_INVALID');
  });

  // ---------- Multi-provider billing (Phase 6) ----------

  it('multi-provider: configure stripe+paypal+razorpay; geo router picks razorpay for IN, stripe globally', async () => {
    const b = await bootstrap('multi');

    // Configure all three with country routing.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { apiKey: 'sk_test_xxx', webhookSecret: 'whsec_xxx' },
        countries: [],
        priority: 100,
      },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/paypal`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { clientId: 'pp_id', clientSecret: 'pp_secret', webhookId: 'pp_wh' },
        countries: ['DE', 'FR'],
        priority: 50,
      },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/razorpay`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        data: { keyId: 'rzp_test_x', keySecret: 'rzp_secret', webhookSecret: 'rzp_wh' },
        countries: ['IN'],
        priority: 10,
      },
    });

    // List shows all three.
    const list = await app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
      })
      .then((r) => r.json().data as Array<{ provider: string; enabled: boolean; countries: string[] }>);
    expect(list).toHaveLength(3);
    const providers = list.map((p) => p.provider).sort();
    expect(providers).toEqual(['paypal', 'razorpay', 'stripe']);

    // Public /providers endpoint, IN → razorpay first.
    const inList = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/providers',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'cf-ipcountry': 'IN',
        },
      })
      .then((r) => r.json().data as { country: string; providers: Array<{ provider: string }> });
    expect(inList.country).toBe('IN');
    expect(inList.providers[0]!.provider).toBe('razorpay');

    // Public /providers, no country → globals (stripe) first because
    // country-restricted ones don't have a known match. Within tiers,
    // priority asc.
    const globalList = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/providers',
        headers: { authorization: `Bearer ${b.liveKey}` },
      })
      .then((r) => r.json().data as { country: string | null; providers: Array<{ provider: string }> });
    expect(globalList.country).toBeNull();
    // stripe is global (tier 1), razorpay+paypal are country-restricted-no-match
    // (tier 2), then by priority asc.
    expect(globalList.providers.map((p) => p.provider)).toEqual(['stripe', 'razorpay', 'paypal']);

    // Disable razorpay → it drops out of the list entirely.
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/razorpay`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { enabled: false },
    });
    const inAfterDisable = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/providers',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'cf-ipcountry': 'IN',
        },
      })
      .then((r) => r.json().data as { providers: Array<{ provider: string }> });
    // For IN with razorpay disabled: no country-match, then globals (stripe),
    // then country-restricted-non-match (paypal for DE/FR).
    expect(inAfterDisable.providers.map((p) => p.provider)).toEqual(['stripe', 'paypal']);
  });

  it('multi-provider: explicit provider in checkout body wins; unknown provider rejects', async () => {
    const b = await bootstrap('multi-pick');

    // Make a plan + configure two providers (stripe + paypal).
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/plans`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { slug: 'pro', name: 'Pro', amount: 999, currency: 'USD', interval: 'MONTH' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/stripe`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data: { apiKey: 'sk_test_xxx', webhookSecret: 'whsec_xxx' } },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/billing-credentials/paypal`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { data: { clientId: 'aaaa', clientSecret: 'bbbb', webhookId: 'cccc' } },
    });

    // Explicit pick: paypal.
    const paypalCheckout = await app
      .inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': b.endUserAccess,
        },
        payload: {
          planSlug: 'pro',
          successUrl: 'https://example.com/ok',
          cancelUrl: 'https://example.com/cancel',
          provider: 'paypal',
        },
      })
      .then((r) => r.json());
    expect(paypalCheckout.success).toBe(true);
    expect(paypalCheckout.data.provider).toBe('paypal');
    expect(paypalCheckout.data.subscription.provider).toBe('paypal');
    expect(paypalCheckout.data.url).toContain('stub_provider=paypal');

    // Switching providers on a PENDING sub is allowed (only ACTIVE/PAST_DUE blocks).
    const stripeCheckout = await app
      .inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: {
          authorization: `Bearer ${b.liveKey}`,
          'x-relipay-user-token': b.endUserAccess,
        },
        payload: {
          planSlug: 'pro',
          successUrl: 'https://example.com/ok',
          cancelUrl: 'https://example.com/cancel',
          provider: 'stripe',
        },
      })
      .then((r) => r.json());
    expect(stripeCheckout.data.provider).toBe('stripe');
    expect(stripeCheckout.data.subscription.provider).toBe('stripe');

    // Asking for a provider that's not configured → 400.
    const reject = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
      payload: {
        planSlug: 'pro',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/cancel',
        provider: 'razorpay',
      },
    });
    expect(reject.statusCode).toBe(400);
    expect(reject.json().error.code).toBe('BILLING_PROVIDER_NOT_AVAILABLE');
  });

  // ---------- OAuth (with mock provider) ----------

  it('OAuth callback creates a new EndUser and signs them in (mock provider)', async () => {
    const b = await bootstrap('oauth-new');
    // Configure the application's OAuth.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${b.applicationId}/oauth-config/google`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: {
        clientId: 'gid',
        clientSecret: 'gsecret',
        redirectUri: 'https://app.example/oauth/google/callback',
      },
    });

    // Inject a mock provider that pretends Google returned a stable id +
    // verified email. `emailVerified` is now required by the provider
    // contract — see oauth/providers/types.ts. Verified-only auto-link is
    // the security gate against unverified-email account takeover.
    registerOAuthProvider({
      name: 'google',
      buildAuthUrl: () => 'https://mock.example/start',
      exchange: async () => ({
        providerAccountId: 'g-acct-new',
        email: 'newvia-oauth@example.com',
        emailVerified: true,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth/google/callback',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { code: 'mock-code' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      endUser: { email: string; emailVerified: boolean };
      accessToken: string;
    };
    expect(data.endUser.email).toBe('newvia-oauth@example.com');
    expect(data.endUser.emailVerified).toBe(true);
    expect(data.accessToken).toBeTruthy();
  });

  // ---------- MFA ----------

  it('MFA setup → confirm → status reports enabled', async () => {
    const b = await bootstrap('mfa');

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
    });
    expect(setup.statusCode).toBe(201);
    const setupData = setup.json().data as { otpauthUrl: string; backupCodes: string[] };
    expect(setupData.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setupData.backupCodes).toHaveLength(10);

    // Extract the secret from the otpauth URL and produce a valid current code.
    const url = new URL(setupData.otpauthUrl.replace('otpauth://', 'https://placeholder/'));
    const secret = url.searchParams.get('secret')!;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6 });
    const code = totp.generate();

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);

    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/mfa/status',
      headers: {
        authorization: `Bearer ${b.liveKey}`,
        'x-relipay-user-token': b.endUserAccess,
      },
    });
    const sd = status.json().data as { enabled: boolean; remainingBackupCodes: number };
    expect(sd.enabled).toBe(true);
    expect(sd.remainingBackupCodes).toBe(10);
  });

  it('MFA challenge with backup code consumes it', async () => {
    const b = await bootstrap('mfa-backup');
    const setup = (await app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/mfa/setup',
        headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': b.endUserAccess },
      })
      .then((r) => r.json().data)) as { otpauthUrl: string; backupCodes: string[] };
    const secret = new URL(setup.otpauthUrl.replace('otpauth://', 'https://x/')).searchParams.get('secret')!;
    const code = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/setup-confirm',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': b.endUserAccess },
      payload: { code },
    });

    const backup = setup.backupCodes[0]!;
    const c1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/challenge',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': b.endUserAccess },
      payload: { code: backup },
    });
    expect((c1.json().data as { ok: boolean }).ok).toBe(true);
    // Replay should fail — backup code is single-use.
    const c2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/mfa/challenge',
      headers: { authorization: `Bearer ${b.liveKey}`, 'x-relipay-user-token': b.endUserAccess },
      payload: { code: backup },
    });
    expect((c2.json().data as { ok: boolean }).ok).toBe(false);
  });

  // ---------- Licenses ----------

  it('issue license → verify ok → revoke → verify revoked', async () => {
    const b = await bootstrap('lic');
    const issue = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/licenses`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { endUserId: b.endUserId, kind: 'PERPETUAL' },
    });
    expect(issue.statusCode).toBe(201);
    const issued = issue.json().data as { license: { id: string }; rawKey: string };
    expect(issued.rawKey).toMatch(/^rl_lic_/);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { key: issued.rawKey, machineFingerprint: 'machine-1' },
    });
    expect((verify.json().data as { ok: boolean }).ok).toBe(true);

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${b.applicationId}/licenses/${issued.license.id}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/licenses/verify',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { key: issued.rawKey, machineFingerprint: 'machine-1' },
    });
    expect((after.json().data as { ok: boolean; reason?: string }).reason).toBe('revoked');
  });

  it('SEATS license caps activations at seatsAllowed', async () => {
    const b = await bootstrap('lic-seats');
    const issue = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${b.applicationId}/licenses`,
        headers: { authorization: `Bearer ${b.tenantAccess}` },
        payload: { endUserId: b.endUserId, kind: 'SEATS', seatsAllowed: 2 },
      })
      .then((r) => r.json().data as { rawKey: string });
    const verifyMachine = (m: string): Promise<{ ok: boolean; reason?: string }> =>
      app
        .inject({
          method: 'POST',
          url: '/api/v1/licenses/verify',
          headers: { authorization: `Bearer ${b.liveKey}` },
          payload: { key: issue.rawKey, machineFingerprint: m },
        })
        .then((r) => r.json().data as { ok: boolean; reason?: string });

    expect((await verifyMachine('m1')).ok).toBe(true);
    expect((await verifyMachine('m2')).ok).toBe(true);
    const third = await verifyMachine('m3');
    expect(third.ok).toBe(false);
    expect(third.reason).toBe('seats_exhausted');
    // Existing machines still validate.
    expect((await verifyMachine('m1')).ok).toBe(true);
  });

  // ---------- Usage ----------

  it('create meter → record events → aggregate sums quantity', async () => {
    const b = await bootstrap('usage');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
    for (const q of [1, 5, 10]) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/usage/record',
        headers: { authorization: `Bearer ${b.liveKey}` },
        payload: { meterSlug: 'api_calls', quantity: q },
      });
    }
    const agg = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/aggregate?meterSlug=api_calls',
      headers: { authorization: `Bearer ${b.liveKey}` },
    });
    expect((agg.json().data as { total: number; count: number }).total).toBe(16);
    expect((agg.json().data as { total: number; count: number }).count).toBe(3);
  });

  it('record against an inactive meter is rejected', async () => {
    const b = await bootstrap('usage-inactive');
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { slug: 'storage', name: 'Storage', unit: 'GB-hours' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${b.applicationId}/usage-meters/storage`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { active: false },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/usage/record',
      headers: { authorization: `Bearer ${b.liveKey}` },
      payload: { meterSlug: 'storage', quantity: 1 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('USAGE_METER_INACTIVE');
  });
});
