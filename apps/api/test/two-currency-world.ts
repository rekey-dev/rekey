/**
 * An Application that sells in two currencies through two providers: Stripe
 * charges USD only and Razorpay INR only, so the provider a checkout reaches
 * says which currency it was routed on. One plan, `pro`, costs USD 20.00 by
 * default and INR 1,499.00 as an additional price.
 */

import { createHmac } from 'node:crypto';
import { expect } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { CheckoutSession } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';

const PASSWORD = 'pw-one-two-three';
const RETURN = 'https://app.example/account';
const RZP_WEBHOOK_SECRET = 'rzp_whsec_two_currency';
const EXTERNAL_SECRET = 'external-billing-signing-secret-for-tests-0123456789';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Buyer {
  id: string;
  token: string;
}

export interface TwoCurrencyWorld {
  applicationId: string;
  slug: string;
  operatorAccess: string;
  secretKey: string;
  publishableKey: string;
  /** The `pro` plan and its INR price. */
  planId: string;
  inrPriceId: string;
  buyer: Buyer;
  operator: (method: Method, url: string, payload?: Record<string, unknown>) => Promise<LightMyRequestResponse>;
  createPlan: (body: Record<string, unknown>) => Promise<string>;
  putPrice: (plan: string, currency: string, amount: number) => Promise<void>;
  newBuyer: () => Promise<Buyer>;
  /** A billing route called as an end-user, with the secret key unless `key` says otherwise. */
  asBuyer: (
    method: Method,
    url: string,
    payload?: Record<string, unknown>,
    opts?: { key?: string; buyer?: Buyer },
  ) => Promise<LightMyRequestResponse>;
  checkout: (extra?: Record<string, unknown>, opts?: { key?: string; buyer?: Buyer }) => Promise<LightMyRequestResponse>;
  /** The session a successful checkout opened. */
  sessionOf: (res: LightMyRequestResponse) => Promise<{ provider: string; row: CheckoutSession }>;
  razorpayWebhook: (body: object) => Promise<LightMyRequestResponse>;
  /** Enable the external provider and post one signed event to it. */
  externalEvent: (type: string, data: unknown) => Promise<{ res: LightMyRequestResponse; eventId: string }>;
}

let externalSeq = 0;

/**
 * @example
 *   const w = await twoCurrencyWorld(app);
 *   const { row } = await w.sessionOf(await w.checkout({ country: 'IN' })); // row.currency === 'INR'
 */
export async function twoCurrencyWorld(app: FastifyInstance): Promise<TwoCurrencyWorld> {
  const slug = `tc-${Math.random().toString(36).slice(2, 8)}`;
  const operatorAccess = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `op-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
    })
    .then((r) => (r.json().data as { accessToken: string }).accessToken);
  const applicationId = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${operatorAccess}` },
      payload: { name: `App ${slug}`, slug, enableBilling: true },
    })
    .then((r) => (r.json().data as { id: string }).id);

  const operator: TwoCurrencyWorld['operator'] = (method, url, payload) =>
    app.inject({
      method,
      url: `/api/v1/tenant/applications/${applicationId}${url}`,
      headers: { authorization: `Bearer ${operatorAccess}` },
      ...(payload !== undefined && { payload }),
    });
  const secretKey = await operator('POST', '/api-keys', { name: 'k', mode: 'live' }).then(
    (r) => (r.json().data as { rawKey: string }).rawKey,
  );
  const publishableKey = (await prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).publicKey;

  await billingCredentialsService.upsertRaw(
    applicationId,
    'stripe',
    { apiKey: 'sk_test_ci_only', webhookSecret: 'whsec_ci_only' },
    { mode: 'test', enabled: true, currencies: ['USD'], priority: 1 },
  );
  await billingCredentialsService.upsertRaw(
    applicationId,
    'razorpay',
    { keyId: 'rzp_test_ci', keySecret: 'secret_ci_only', webhookSecret: RZP_WEBHOOK_SECRET },
    { mode: 'test', enabled: true, currencies: ['INR'], countries: ['IN'], priority: 50 },
  );

  const createPlan: TwoCurrencyWorld['createPlan'] = async (body) => {
    const res = await operator('POST', '/plans', body);
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { id: string }).id;
  };
  const putPrice: TwoCurrencyWorld['putPrice'] = async (plan, currency, amount) => {
    const res = await operator('PUT', `/plans/${plan}/prices/${currency}`, { amount });
    expect(res.statusCode, res.body).toBe(200);
  };
  const newBuyer: TwoCurrencyWorld['newBuyer'] = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${secretKey}` },
      payload: { email: `eu-${Math.random().toString(36).slice(2, 10)}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { id: data.endUser.id, token: data.accessToken };
  };

  const planId = await createPlan({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 2000 } });
  await putPrice('pro', 'INR', 149900);
  const inrPriceId = (await prisma.planPrice.findFirstOrThrow({ where: { planId, currency: 'INR' } })).id;
  const buyer = await newBuyer();

  const asBuyer: TwoCurrencyWorld['asBuyer'] = (method, url, payload, opts = {}) =>
    app.inject({
      method,
      url: `/api/v1/billing${url}`,
      headers: {
        authorization: `Bearer ${opts.key ?? secretKey}`,
        'x-rekey-user-token': (opts.buyer ?? buyer).token,
      },
      ...(payload !== undefined && { payload }),
    });

  return {
    applicationId,
    slug,
    operatorAccess,
    secretKey,
    publishableKey,
    planId,
    inrPriceId,
    buyer,
    operator,
    createPlan,
    putPrice,
    newBuyer,
    asBuyer,
    checkout: (extra = {}, opts = {}) =>
      asBuyer('POST', '/checkout', { planSlug: 'pro', successUrl: `${RETURN}?paid=1`, cancelUrl: RETURN, ...extra }, opts),
    sessionOf: async (res) => {
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json().data as { checkoutSessionId: string; provider: string };
      const row = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: data.checkoutSessionId } });
      return { provider: data.provider, row };
    },
    razorpayWebhook: (body) => {
      const payload = JSON.stringify(body);
      return app.inject({
        method: 'POST',
        url: `/api/v1/billing/webhook/razorpay/${slug}`,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': createHmac('sha256', RZP_WEBHOOK_SECRET).update(payload).digest('hex'),
        },
        payload,
      });
    },
    externalEvent: async (type, data) => {
      await billingCredentialsService.upsertCredentials(
        applicationId,
        'external',
        { webhookSecret: EXTERNAL_SECRET },
        { mode: 'test' },
      );
      externalSeq += 1;
      const eventId = `evt_tc_${externalSeq}_${type}`;
      const payload = JSON.stringify({ eventId, type, occurredAt: new Date().toISOString(), data });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac('sha256', EXTERNAL_SECRET).update(`${t}.${payload}`).digest('hex');
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/webhooks/billing/external/${slug}`,
        headers: { 'content-type': 'application/json', 'x-rekey-signature': `t=${t},v1=${v1}` },
        payload,
      });
      return { res, eventId };
    },
  };
}
