/**
 * Operator personal access tokens on the tenant routes for profile fields and
 * lists: a write token sets an app up without a browser, a read token cannot
 * write even when its holder is the workspace owner, the membership still
 * bounds what a token reaches, and the list CSV export stays session-only.
 * On billing a read token reads, an applications:write token changes the
 * catalogue, and money-moving and credential writes stay session-only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { generateOperatorToken } from '../src/lib/operator-token.js';
import { prisma } from '../src/lib/prisma.js';
import { contactsHarness, type ContactsWorld } from './contacts-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const FIELDS = [{ key: 'company', label: 'Company', type: 'text', requiredForOnboarding: true }];

describe('operator personal access tokens on profile and list routes', () => {
  let app: FastifyInstance;
  const { inject, auth, world, base, createList, memberWith } = contactsHarness(() => app, '87');

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function mintPat(sessionToken: string, scopes: string[]): Promise<{ raw: string; id: string }> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(sessionToken),
      payload: { name: 'agent', scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    const data = res.json().data as { rawToken: string; apiToken: { id: string } };
    return { raw: data.rawToken, id: data.apiToken.id };
  }

  const putSchema = (w: ContactsWorld, token: string) =>
    inject({ method: 'PUT', url: `${base(w)}/profile-schema`, headers: auth(token), payload: { fields: FIELDS, version: 0 } });
  const postList = (w: ContactsWorld, token: string) =>
    inject({ method: 'POST', url: `${base(w)}/lists`, headers: auth(token), payload: { key: 'waitlist', name: 'Waitlist' } });

  it('an applications:write token sets the onboarding questions and creates a list', async () => {
    const w = await world();
    const { raw } = await mintPat(w.ownerToken, ['applications:write']);

    const schema = await putSchema(w, raw);
    expect(schema.statusCode, schema.body).toBe(200);
    expect(schema.json().data).toMatchObject({ fields: [{ key: 'company' }], version: 1 });

    const created = await postList(w, raw);
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().data).toMatchObject({ key: 'waitlist', name: 'Waitlist' });

    const read = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) });
    expect(read.statusCode, read.body).toBe(200);
  });

  it('a read token held by the owner reads but cannot write', async () => {
    const w = await world();
    const { raw } = await mintPat(w.ownerToken, ['read']);

    expect((await inject({ method: 'GET', url: `${base(w)}/profile-schema`, headers: auth(raw) })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) })).statusCode).toBe(200);

    for (const res of [await putSchema(w, raw), await postList(w, raw)]) {
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.code).toBe('OPERATOR_SCOPE_INSUFFICIENT');
    }
  });

  it('a session still reaches the same routes', async () => {
    const w = await world();
    expect((await putSchema(w, w.ownerToken)).statusCode).toBe(200);
    expect((await postList(w, w.ownerToken)).statusCode).toBe(201);
  });

  it("a token cannot reach past its holder's grant", async () => {
    const w = await world();
    await memberWith(w, 'APP_VIEWER');
    // A MEMBER cannot mint a token today; this one stands for a token minted
    // while its holder was an ADMIN, before a demotion.
    const member = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: w.tenantId, role: 'MEMBER' } });
    const { raw, hash, prefix } = generateOperatorToken();
    await prisma.tenantApiToken.create({
      data: { tenantUserId: member.tenantUserId, tenantId: w.tenantId, name: 'old', tokenPrefix: prefix, tokenHash: hash, scopes: ['read', 'applications:write'] },
    });

    const write = await postList(w, raw);
    expect(write.statusCode, write.body).toBe(403);
    expect(write.json().error.code).toBe('APP_ACCESS_DENIED');

    expect((await inject({ method: 'GET', url: `${base(w)}/profile-schema`, headers: auth(raw) })).statusCode).toBe(200);
    const lists = await inject({ method: 'GET', url: `${base(w)}/lists`, headers: auth(raw) });
    expect(lists.statusCode, lists.body).toBe(403);
    expect(lists.json().error.code).toBe('SCOPE_INSUFFICIENT');
  });

  it('a revoked token is refused', async () => {
    const w = await world();
    const { raw, id } = await mintPat(w.ownerToken, ['applications:write']);
    const revoked = await inject({ method: 'DELETE', url: `/api/v1/tenant/auth/api-tokens/${id}`, headers: auth(w.ownerToken) });
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);

    const res = await postList(w, raw);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('OPERATOR_TOKEN_INVALID');
  });

  it('the list CSV export refuses a token and serves a session', async () => {
    const w = await world();
    const listId = (((await createList(w)).json().data) as { id: string }).id;
    const { raw } = await mintPat(w.ownerToken, ['applications:write']);
    const url = `${base(w)}/lists/${listId}/export.csv`;

    const byToken = await inject({ method: 'GET', url, headers: auth(raw) });
    expect(byToken.statusCode, byToken.body).toBe(403);
    expect(byToken.json().error.code).toBe('OPERATOR_TOKEN_NOT_ACCEPTED');

    expect((await inject({ method: 'GET', url, headers: auth(w.ownerToken) })).statusCode).toBe(200);
  });
});

interface Call {
  method: string;
  url: string;
  payload?: unknown;
}

describe('operator personal access tokens on billing and analytics routes', () => {
  let app: FastifyInstance;
  const { inject, auth, world, base, memberWith } = contactsHarness(() => app, '88');

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function mintPat(sessionToken: string, scopes: string[]): Promise<string> {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/api-tokens',
      headers: auth(sessionToken),
      payload: { name: 'script', scopes },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data as { rawToken: string }).rawToken;
  }

  /** A token for the workspace's MEMBER, who cannot mint one: it stands for one minted before a demotion. */
  async function memberToken(tenantId: string): Promise<string> {
    const member = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId, role: 'MEMBER' } });
    const { raw, hash, prefix } = generateOperatorToken();
    await prisma.tenantApiToken.create({
      data: { tenantUserId: member.tenantUserId, tenantId, name: 'old', tokenPrefix: prefix, tokenHash: hash, scopes: ['read', 'applications:write'] },
    });
    return raw;
  }

  async function seeded(w: ContactsWorld): Promise<string> {
    const plan = await inject({ method: 'POST', url: `${base(w)}/plans`, headers: auth(w.ownerToken), payload: { slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } } });
    expect(plan.statusCode, plan.body).toBe(201);
    const coupon = await inject({
      method: 'POST',
      url: `${base(w)}/coupons`,
      headers: auth(w.ownerToken),
      payload: { code: 'welcome', discountType: 'PERCENT', basisPoints: 1500 },
    });
    expect(coupon.statusCode, coupon.body).toBe(201);
    const payment = await prisma.payment.create({ data: { applicationId: w.appId, amount: 1900, currency: 'USD', status: 'SUCCEEDED' } });
    return payment.id;
  }

  const appReads = (w: ContactsWorld, paymentId: string): Call[] => [
    { method: 'GET', url: base(w) },
    { method: 'GET', url: `${base(w)}/plans` },
    { method: 'GET', url: `${base(w)}/coupons` },
    { method: 'GET', url: `${base(w)}/coupons/welcome` },
    { method: 'GET', url: `${base(w)}/billing/providers` },
    { method: 'GET', url: `${base(w)}/billing-credentials` },
    { method: 'GET', url: `${base(w)}/billing/stats` },
    { method: 'GET', url: `${base(w)}/payments` },
    { method: 'GET', url: `${base(w)}/payments/${paymentId}` },
    { method: 'GET', url: `${base(w)}/payments/${paymentId}/refunds` },
    { method: 'GET', url: `${base(w)}/unapplied-payments` },
    { method: 'GET', url: `${base(w)}/billing/reporting-currency` },
    { method: 'POST', url: `${base(w)}/billing/checkout/preview`, payload: { country: 'US' } },
    { method: 'GET', url: `${base(w)}/billing/events` },
    { method: 'GET', url: `${base(w)}/billing/payments/${paymentId}/events` },
    { method: 'GET', url: `${base(w)}/billing/subscriptions/sub_none/events` },
    { method: 'GET', url: `${base(w)}/end-users/eu_none/billing-events` },
    { method: 'GET', url: `${base(w)}/billing/reconciliation` },
    { method: 'GET', url: `${base(w)}/billing/price-fallbacks` },
    { method: 'GET', url: `${base(w)}/analytics/users?sections=kpis` },
  ];

  const catalogueWrites = (w: ContactsWorld): Call[] => [
    { method: 'POST', url: `${base(w)}/plans`, payload: { slug: 'team', name: 'Team' } },
    { method: 'PATCH', url: `${base(w)}/plans/pro`, payload: { name: 'Pro plus' } },
    { method: 'PUT', url: `${base(w)}/plans/pro/prices/EUR`, payload: { amount: 900 } },
    { method: 'DELETE', url: `${base(w)}/plans/pro/prices/EUR` },
    { method: 'POST', url: `${base(w)}/coupons`, payload: { code: 'spring', discountType: 'PERCENT', basisPoints: 1000 } },
    { method: 'PATCH', url: `${base(w)}/coupons/welcome`, payload: { maxRedemptions: 10 } },
    { method: 'PUT', url: `${base(w)}/billing/reporting-currency`, payload: { reportingCurrency: 'EUR' } },
  ];

  const label = (call: Call, body: string) => `${call.method} ${call.url}: ${body}`;

  it('a read token reaches every billing and analytics read', async () => {
    const w = await world();
    const paymentId = await seeded(w);
    const raw = await mintPat(w.ownerToken, ['read']);

    for (const call of [{ method: 'GET', url: '/api/v1/tenant/applications' }, ...appReads(w, paymentId)]) {
      const res = await inject({ ...call, headers: auth(raw) });
      expect(res.statusCode, label(call, res.body)).toBe(200);
    }
  });

  it('a read token cannot change the catalogue, and an applications:write token can', async () => {
    const w = await world();
    await seeded(w);
    const reader = await mintPat(w.ownerToken, ['read']);
    const writer = await mintPat(w.ownerToken, ['applications:write']);

    for (const call of catalogueWrites(w)) {
      const refused = await inject({ ...call, headers: auth(reader) });
      expect(refused.statusCode, label(call, refused.body)).toBe(403);
      expect(refused.json().error.code).toBe('OPERATOR_SCOPE_INSUFFICIENT');

      const done = await inject({ ...call, headers: auth(writer) });
      expect(done.statusCode, label(call, done.body)).toBeLessThan(300);
    }
  });

  it('refunds, cancellations, provider credentials and billing settings stay session-only', async () => {
    const w = await world();
    const paymentId = await seeded(w);
    const raw = await mintPat(w.ownerToken, ['read', 'applications:write', 'keys:mint']);

    const refund = await inject({ method: 'POST', url: `${base(w)}/payments/${paymentId}/refunds`, headers: auth(raw), payload: {} });
    expect(refund.statusCode, refund.body).toBe(403);
    expect(refund.json().error.code).toBe('OPERATOR_TOKEN_NOT_ACCEPTED');

    const sessionOnly: Call[] = [
      { method: 'PUT', url: `${base(w)}/billing-credentials/stripe`, payload: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' } },
      { method: 'PATCH', url: `${base(w)}/billing-credentials/stripe`, payload: { enabled: false } },
      { method: 'DELETE', url: `${base(w)}/billing-credentials/stripe` },
      { method: 'PATCH', url: `${base(w)}/billing-config`, payload: { onUnavailableCurrency: 'refuse' } },
      { method: 'POST', url: `${base(w)}/end-users/eu_none/subscriptions/sub_none/cancel`, payload: {} },
      { method: 'POST', url: `${base(w)}/unapplied-payments/case_none/refund`, payload: {} },
      { method: 'POST', url: `${base(w)}/unapplied-payments/case_none/extend`, payload: {} },
      { method: 'POST', url: `${base(w)}/unapplied-payments/case_none/dismiss`, payload: {} },
    ];
    for (const call of sessionOnly) {
      const res = await inject({ ...call, headers: auth(raw) });
      expect(res.statusCode, label(call, res.body)).toBe(403);
      expect(res.json().error.code, label(call, res.body)).toBe('OPERATOR_TOKEN_NOT_ACCEPTED');
    }
  });

  it('a read token is told refunds need a session, not a wider scope', async () => {
    const w = await world();
    const paymentId = await seeded(w);
    const raw = await mintPat(w.ownerToken, ['read']);

    const refund = await inject({ method: 'POST', url: `${base(w)}/payments/${paymentId}/refunds`, headers: auth(raw), payload: {} });
    expect(refund.statusCode, refund.body).toBe(403);
    expect(refund.json().error.code).toBe('OPERATOR_TOKEN_NOT_ACCEPTED');
  });

  it("a token from another workspace does not reach this workspace's billing", async () => {
    const w = await world();
    const paymentId = await seeded(w);
    const other = await world();
    const raw = await mintPat(other.ownerToken, ['read', 'applications:write']);

    for (const call of [...appReads(w, paymentId), ...catalogueWrites(w)]) {
      const res = await inject({ ...call, headers: auth(raw) });
      expect(res.statusCode, label(call, res.body)).toBe(404);
    }
    const list = await inject({ method: 'GET', url: '/api/v1/tenant/applications', headers: auth(raw) });
    expect((list.json().data as { items: Array<{ id: string }> }).items.map((a) => a.id)).not.toContain(w.appId);
  });

  it('a member with no grant on the Application gets nothing from it through a token', async () => {
    const w = await world();
    const paymentId = await seeded(w);
    const second = await inject({ method: 'POST', url: '/api/v1/tenant/applications', headers: auth(w.ownerToken), payload: { name: 'Other', slug: `${w.tag}-b` } });
    expect(second.statusCode, second.body).toBe(201);
    await memberWith({ ...w, appId: (second.json().data as { id: string }).id }, 'APP_ADMIN');
    const raw = await memberToken(w.tenantId);

    for (const call of [...appReads(w, paymentId), ...catalogueWrites(w)]) {
      const res = await inject({ ...call, headers: auth(raw) });
      expect(res.statusCode, label(call, res.body)).toBe(404);
    }
  });

  it('a viewer grant reads billing through a token and cannot change the catalogue', async () => {
    const w = await world();
    const paymentId = await seeded(w);
    await memberWith(w, 'APP_VIEWER');
    const raw = await memberToken(w.tenantId);

    const stats = await inject({ method: 'GET', url: `${base(w)}/billing/stats`, headers: auth(raw) });
    expect(stats.statusCode, stats.body).toBe(200);
    const payment = await inject({ method: 'GET', url: `${base(w)}/payments/${paymentId}`, headers: auth(raw) });
    expect(payment.statusCode, payment.body).toBe(200);
    for (const call of catalogueWrites(w)) {
      const res = await inject({ ...call, headers: auth(raw) });
      expect(res.statusCode, label(call, res.body)).toBe(403);
    }
  });
});
