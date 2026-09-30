/**
 * Billing refusals name the right thing for the caller.
 *
 * From a live e2e run:
 *  - On an Application whose only enabled provider is the inbound-only
 *    `external` one, `GET /billing/trial-eligibility` and a checkout that
 *    names no provider answered BILLING_CREDENTIALS_NOT_CONFIGURED ("external
 *    has no credentials configured"). It has credentials; it cannot host a
 *    checkout. A checkout naming `provider: "external"` answered the same code
 *    about stripe, a provider the caller never asked for.
 *  - PLAN_NOT_FOUND and PLAN_INACTIVE told end-users and operators to call
 *    `/api/v1/admin/...` routes, which need the deployment's super-admin key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const PASSWORD = 'pw-one-two-three';

describe('billing refusals name the right thing', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let pubKey: string;
  let userToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const self = (): Record<string, string> => ({ authorization: `Bearer ${pubKey}`, 'x-rekey-user-token': userToken });

  beforeEach(async () => {
    const slug = `rw${Math.random().toString(36).slice(2, 7)}`;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'RW', slug, enableBilling: true },
    });
    appId = (created.json().data as { id: string }).id;
    pubKey = (await prisma.application.findUniqueOrThrow({ where: { id: appId } })).publicKey;
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: 'pro', name: 'Pro', amount: 2000, kind: 'SUBSCRIPTION' },
    });
    if (r.statusCode !== 201) throw new Error(`plan ${r.statusCode}: ${r.body}`);
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${pubKey}` },
      payload: { email: `buyer-${slug}@example.com`, password: PASSWORD },
    });
    userToken = (su.json().data as { accessToken: string }).accessToken;
  });

  const externalOnly = () =>
    billingCredentialsService.upsertCredentials(
      appId,
      'external',
      { webhookSecret: 'external-billing-signing-secret-for-tests-0123456789' },
      { mode: 'test' },
    );

  const checkout = (body: Record<string, unknown> = {}): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: self(),
      payload: {
        planSlug: 'pro',
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
        ...body,
      },
    });

  describe('an Application whose only provider is inbound-only', () => {
    it('trial-eligibility says the provider cannot start a trial, in trial terms', async () => {
      await externalOnly();
      const res = await app.inject({ method: 'GET', url: '/api/v1/billing/trial-eligibility', headers: self() });
      expect(res.statusCode).toBe(400);
      const { code, message, fix } = res.json().error as { code: string; message: string; fix: string };
      expect(code).toBe('BILLING_PROVIDER_INBOUND_ONLY');
      expect(message).toContain('"external"');
      expect(message).toMatch(/trial/);
      expect(message).not.toContain('host a checkout');
      expect(message).not.toContain('no credentials');
      expect(fix).toContain('trialEndsAt');
      expect(fix).toContain(`Billing → Setup → Providers (/applications/${appId}/billing/providers)`);
    });

    it('a checkout naming no provider answers the same', async () => {
      await externalOnly();
      const res = await checkout();
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BILLING_PROVIDER_INBOUND_ONLY');
    });

    it('a checkout naming external is refused about external, not the default provider', async () => {
      await externalOnly();
      const res = await checkout({ provider: 'external' });
      expect(res.statusCode).toBe(400);
      const { code, message, fix } = res.json().error as { code: string; message: string; fix: string };
      expect(code).toBe('BILLING_PROVIDER_INBOUND_ONLY');
      expect(message).toContain('"external"');
      expect(`${message} ${fix}`).not.toMatch(/stripe/i);
      // No hosted provider is enabled, so "omit `provider`" would not help.
      expect(fix).not.toContain('Omit `provider`');
    });

    it('a checkout naming an unconfigured hosted provider is refused about that provider', async () => {
      await externalOnly();
      const res = await checkout({ provider: 'paypal' });
      expect(res.statusCode).toBe(400);
      const { code, message } = res.json().error as { code: string; message: string };
      expect(code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
      expect(message).toContain('"paypal"');
    });
  });

  it('with nothing configured at all, the refusal is unchanged', async () => {
    const res = await checkout();
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_CREDENTIALS_NOT_CONFIGURED');
  });

  describe('plan refusals point at routes the caller can use', () => {
    it('PLAN_NOT_FOUND on the end-user checkout', async () => {
      const res = await checkout({ planSlug: 'nope' });
      expect(res.statusCode).toBe(404);
      const { code, fix } = res.json().error as { code: string; fix: string };
      expect(code).toBe('PLAN_NOT_FOUND');
      expect(fix).not.toContain('/api/v1/admin/');
      expect(fix).toContain('GET /api/v1/billing/plans');
      expect(fix).toContain(`/api/v1/tenant/applications/${appId}/plans`);
    });

    it('PLAN_NOT_FOUND on a tenant route', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/plans/nope`,
        headers: auth(),
        payload: { name: 'x' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.fix).not.toContain('/api/v1/admin/');
    });

    it('PLAN_INACTIVE on the end-user checkout', async () => {
      await prisma.plan.update({
        where: { applicationId_slug: { applicationId: appId, slug: 'pro' } },
        data: { active: false },
      });
      const res = await checkout();
      expect(res.statusCode).toBe(400);
      const { code, fix } = res.json().error as { code: string; fix: string };
      expect(code).toBe('PLAN_INACTIVE');
      expect(fix).not.toContain('/api/v1/admin/');
      expect(fix).toContain(`PATCH /api/v1/tenant/applications/${appId}/plans/pro`);
    });

    it('PLAN_INACTIVE on a plan whose registration failed says to register it, not to flip `active`', async () => {
      await prisma.plan.update({
        where: { applicationId_slug: { applicationId: appId, slug: 'pro' } },
        data: { active: false, registrationStatus: 'FAILED' },
      });
      const res = await checkout();
      expect(res.statusCode).toBe(400);
      const { code, message, fix } = res.json().error as { code: string; message: string; fix: string };
      expect(code).toBe('PLAN_INACTIVE');
      expect(message).toMatch(/not registered/);
      expect(fix).toContain(`POST /api/v1/tenant/applications/${appId}/plans/pro/register`);
      expect(fix).not.toContain('"active": true');

      const flip = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/plans/pro`,
        headers: auth(),
        payload: { active: true },
      });
      expect(flip.json().error.code).toBe('PLAN_NOT_REGISTERED_WITH_PROVIDER');
    });
  });
});
