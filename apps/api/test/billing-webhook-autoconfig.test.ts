/**
 * Billing webhook auto-configuration.
 *
 * Operators can save provider credentials WITHOUT a webhook secret/id, then
 * call register-webhook to have Rekey create the endpoint via the provider
 * API and store the secret (Stripe) / id (PayPal). Under NODE_ENV=test the
 * provider fakes return deterministic values so this is verifiable offline.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { fakePaypal } from './fakes/billing-providers.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

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

  describe('after a credential edit', () => {
    const OLD_ACCOUNT = { clientId: 'pp_client', clientSecret: 'pp_secret', webhookId: 'WH-old-account' };
    const storedWebhookId = async () =>
      (await billingCredentialsService.loadDecrypted(applicationId, 'paypal'))?.webhookId;
    const webhookOf = (res: { json: () => { data: { webhook: string } } }) => res.json().data.webhook;

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('registers the webhook again when the keys change, since the saved id belongs to the old account', async () => {
      expect(webhookOf(await putCreds('paypal', OLD_ACCOUNT))).toBe('unchanged');

      const rotated = await putCreds('paypal', { clientSecret: 'pp_secret_of_another_account' });
      expect(rotated.statusCode).toBe(200);
      expect(webhookOf(rotated)).toBe('reconfigured');
      expect(await storedWebhookId()).toMatch(/^WH-stub-/);
    });

    it('leaves the webhook alone when nothing secret changed, or the edit names the webhook itself', async () => {
      await putCreds('paypal', OLD_ACCOUNT);
      const register = vi.spyOn(fakePaypal, 'registerWebhook');

      expect(webhookOf(await putCreds('paypal', { clientSecret: OLD_ACCOUNT.clientSecret }))).toBe('unchanged');
      const routing = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${applicationId}/billing-credentials/paypal`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { priority: 5, countries: ['US'] },
      });
      expect(webhookOf(routing)).toBe('unchanged');
      const pasted = await putCreds('paypal', { clientSecret: 'pp_new_secret', webhookId: 'WH-pasted-by-hand' });
      expect(webhookOf(pasted)).toBe('unchanged');

      expect(register).not.toHaveBeenCalled();
      expect(await storedWebhookId()).toBe('WH-pasted-by-hand');
    });

    it('saves the keys and reports `failed` when the provider refuses the registration', async () => {
      await putCreds('paypal', OLD_ACCOUNT);
      vi.spyOn(fakePaypal, 'registerWebhook').mockRejectedValue(new Error('invalid_client'));

      const rotated = await putCreds('paypal', { clientSecret: 'pp_wrong_secret' });
      expect(rotated.statusCode).toBe(200);
      expect(webhookOf(rotated)).toBe('failed');
      expect(await storedWebhookId()).toBe('WH-old-account');
      expect((await billingCredentialsService.loadDecrypted(applicationId, 'paypal'))?.clientSecret).toBe('pp_wrong_secret');
    });
  });
});
