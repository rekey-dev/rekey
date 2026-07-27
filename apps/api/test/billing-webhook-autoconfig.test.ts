/**
 * Billing webhook auto-configuration.
 *
 * Operators can save provider credentials WITHOUT a webhook secret/id, then
 * call register-webhook to have Rekey create the endpoint via the provider
 * API and store the secret (Stripe) / id (PayPal). Under NODE_ENV=test the
 * stub providers return deterministic values so this is verifiable offline.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('billing webhook auto-config', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let tenantAccess: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const slug = `whcfg-${Math.random().toString(36).slice(2, 8)}`;
    tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });

  const putCreds = (provider: string, data: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/${provider}`,
      headers: { authorization: `Bearer ${tenantAccess}` },
      payload: { data, mode: 'test' },
    });

  const register = (provider: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/${provider}/register-webhook`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });

  const statusOf = (provider: string) =>
    app
      .inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${applicationId}/billing-credentials`,
        headers: { authorization: `Bearer ${tenantAccess}` },
      })
      .then((r) => (r.json().data as Array<{ provider: string; webhookConfigured: boolean }>).find((x) => x.provider === provider));

  it('Stripe: save apiKey only, then auto-configure the webhook', async () => {
    expect((await putCreds('stripe', { apiKey: 'sk_test_abc123' })).statusCode).toBe(200);
    expect((await statusOf('stripe'))?.webhookConfigured).toBe(false);

    const reg = await register('stripe');
    expect(reg.statusCode).toBe(200);
    expect((reg.json().data as { webhookConfigured: boolean }).webhookConfigured).toBe(true);
    expect((await statusOf('stripe'))?.webhookConfigured).toBe(true);
  });

  it('PayPal: save client creds only, then auto-configure the webhook', async () => {
    expect((await putCreds('paypal', { clientId: 'pp_client', clientSecret: 'pp_secret' })).statusCode).toBe(200);
    expect((await statusOf('paypal'))?.webhookConfigured).toBe(false);

    const reg = await register('paypal');
    expect(reg.statusCode).toBe(200);
    expect((reg.json().data as { webhookConfigured: boolean }).webhookConfigured).toBe(true);
    expect((await statusOf('paypal'))?.webhookConfigured).toBe(true);
  });

  it('register-webhook before saving credentials → 400 NOT_CONFIGURED', async () => {
    const reg = await register('stripe');
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  it('Razorpay auto-config is unsupported → 400', async () => {
    expect(
      (await putCreds('razorpay', { keyId: 'rzp_test_x', keySecret: 'secret', webhookSecret: 'whksecret' })).statusCode,
    ).toBe(200);
    const reg = await register('razorpay');
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error.code).toBe('BILLING_WEBHOOK_AUTOCONFIG_UNSUPPORTED');
  });
});
