/**
 * With Stripe, PayPal and Razorpay all configured, a checkout is routed by the
 * buyer's country: Razorpay for India, Stripe everywhere else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { operatorsConfirmTheirEmail, endUsersConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();
endUsersConfirmTheirEmail();

interface Bootstrapped {
  applicationId: string;
  liveKey: string;
  endUserId: string;
  endUserAccess: string;
  tenantAccess: string;
}

describe('checkout routing by buyer country', () => {
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
        url: '/api/v1/billing/providers?country=in',
        headers: { authorization: `Bearer ${b.liveKey}` },
      })
      .then((r) => r.json().data as { country: string; countrySource: string; routedProvider: string; providers: Array<{ provider: string }> });
    expect(inList.country).toBe('IN');
    expect(inList.countrySource).toBe('declared');
    expect(inList.providers[0]!.provider).toBe('razorpay');
    expect(inList.routedProvider).toBe('razorpay');

    // A secret-key call comes from the operator's server, so the CDN's country
    // for that connection is not the buyer's and is not used.
    const fromServer = await app
      .inject({
        method: 'GET',
        url: '/api/v1/billing/providers',
        headers: { authorization: `Bearer ${b.liveKey}`, 'cf-ipcountry': 'IN' },
      })
      .then((r) => r.json().data as { country: string | null; routedProvider: string });
    expect(fromServer.country).toBeNull();
    expect(fromServer.routedProvider).toBe('stripe');

    // A browser caller with the publishable key: its own word is a hint, the
    // CDN's header on the request outranks it, and both route.
    const { publicKey } = await prisma.application.findUniqueOrThrow({ where: { id: b.applicationId }, select: { publicKey: true } });
    const fromBrowser = (url: string, headers: Record<string, string> = {}) =>
      app
        .inject({ method: 'GET', url, headers: { authorization: `Bearer ${publicKey}`, ...headers } })
        .then((r) => r.json().data as { country: string | null; countrySource: string | null; routedProvider: string });
    expect(await fromBrowser('/api/v1/billing/providers?country=IN')).toMatchObject({ country: 'IN', countrySource: 'hint', routedProvider: 'razorpay' });
    expect(await fromBrowser('/api/v1/billing/providers?country=IN', { 'cf-ipcountry': 'DE' })).toMatchObject({
      country: 'DE',
      countrySource: 'hint',
      routedProvider: 'paypal',
    });
    // Cloudflare's placeholder for Tor is forwarded as it is by many callers:
    // it must read as "no country", never as a refused request.
    for (const placeholder of ['T1', 'XX']) {
      const tor = await app.inject({
        method: 'GET',
        url: `/api/v1/billing/providers?country=${placeholder}`,
        headers: { authorization: `Bearer ${b.liveKey}` },
      });
      expect(tor.statusCode, tor.body).toBe(200);
      expect(tor.json().data).toMatchObject({ country: null, routedProvider: 'stripe' });
    }
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/providers?country=India',
      headers: { authorization: `Bearer ${b.liveKey}` },
    });
    expect(malformed.statusCode).toBe(400);

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
        url: '/api/v1/billing/providers?country=IN',
        headers: { authorization: `Bearer ${b.liveKey}` },
      })
      .then((r) => r.json().data as { providers: Array<{ provider: string }> });
    // For IN with razorpay disabled: no country-match, then globals (stripe),
    // then country-restricted-non-match (paypal for DE/FR).
    expect(inAfterDisable.providers.map((p) => p.provider)).toEqual(['stripe', 'paypal']);
  });
});
