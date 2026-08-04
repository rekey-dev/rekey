/**
 * A plan the payment provider refused must never end up on sale.
 *
 * The proven sequence, from an external functional audit driving a real Stripe
 * key the account rejected:
 *
 *   POST /tenant/applications/:id/plans {"slug":"brokenplan",...}
 *     → 401 "Invalid API Key provided: sk_test_****0001"
 *   GET  /billing/plans (secret key)
 *     → 200, brokenplan listed, active:true, nothing marking it broken
 *   POST /billing/checkout {"planSlug":"brokenplan"}
 *     → 500 INTERNAL_ERROR, real cause only in the server log
 *
 * The caller was told the create failed. The row was committed anyway, and it
 * was committed ACTIVE, so the operator's pricing page kept selling a plan
 * whose checkout could only 500. It could not be repaired either: re-POSTing
 * the slug answered 409, and PATCH accepted exactly one field, `{active}`.
 *
 * Each `it` below pins one half of that: the state a refused create leaves
 * behind, the repair path out of it, and the answer a buyer gets if a plan with
 * no provider price is somehow reached anyway.
 *
 * ## Why the provider is mocked and this is still a real test
 *
 * The audit drove Stripe over the network. Here the refusal is injected at the
 * registry seam `test/setup.ts` already mocks (`getProviderForApplication`), so
 * `plansService` runs its real code against a provider that throws exactly what
 * Stripe threw. The one place that would be vacuous — "checkout must not 500
 * when the price id is missing" — deliberately uses the REAL
 * `RealStripeProvider`, whose refusal happens before any socket is opened.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { RekeyError } from '../src/lib/error.js';
import { getProviderForApplication } from '../src/modules/billing/providers/index.js';
import { RealStripeProvider } from '../src/modules/billing/providers/stripe-real.js';
import { fakeStripe } from './fakes/billing-providers.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

const PASSWORD = 'correct-horse-battery';

/** Byte-for-byte what the audit's Stripe account answered for a bad key. */
const STRIPE_BAD_KEY = (): RekeyError =>
  new RekeyError({
    statusCode: 401,
    code: 'BAD_REQUEST',
    message: 'Invalid API Key provided: sk_test_****0001',
  });

interface Ctx {
  operator: string;
  appId: string;
  liveKey: string;
}

describe('plan provider registration is atomic and repairable', () => {
  let app: FastifyInstance;
  let ctx: Ctx;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    vi.mocked(getProviderForApplication).mockClear();
    const operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: 'atomic-op@example.com', password: PASSWORD, workspaceName: 'Atomic WS' },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: 'atomic', slug: 'atomic', enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: { authorization: `Bearer ${operator}` },
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    // The Application has Stripe credentials, so plan creation registers
    // eagerly — which is the code path the whole file is about.
    await configureSandboxStripe(appId);
    ctx = { operator, appId, liveKey };
  });

  // ---------- helpers ----------

  const createPlan = (
    body: Record<string, unknown>,
  ): ReturnType<FastifyInstance['inject']> =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { name: 'Broken', amount: 4900, currency: 'usd', interval: 'MONTH', ...body },
    });

  /** Make the NEXT provider construction hand back one that refuses to register. */
  function rejectNextRegistration(): void {
    vi.mocked(getProviderForApplication).mockImplementationOnce(async () => ({
      ...fakeStripe,
      name: 'stripe' as const,
      getWebhookSecret: () => null,
      ensurePlanRegistered: async () => {
        throw STRIPE_BAD_KEY();
      },
      createCheckoutSession: fakeStripe.createCheckoutSession.bind(fakeStripe),
      createOneTimeCheckout: fakeStripe.createOneTimeCheckout.bind(fakeStripe),
      cancelSubscription: fakeStripe.cancelSubscription.bind(fakeStripe),
    }));
  }

  /** Create `brokenplan` against a provider that rejects it. Returns the reply. */
  async function createRefusedPlan(): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
    rejectNextRegistration();
    const res = await createPlan({ slug: 'brokenplan' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    return res;
  }

  const listPublicPlans = (): ReturnType<FastifyInstance['inject']> =>
    app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: { authorization: `Bearer ${ctx.liveKey}` },
    });

  const listOperatorPlans = (): ReturnType<FastifyInstance['inject']> =>
    app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans`,
      headers: { authorization: `Bearer ${ctx.operator}` },
    });

  async function signUpBuyer(email = 'buyer@example.com'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${ctx.liveKey}` },
      payload: { email, password: 'pw-one-two-three' },
    });
    return (res.json().data as { accessToken: string }).accessToken;
  }

  const checkout = (planSlug: string, userToken: string): ReturnType<FastifyInstance['inject']> =>
    app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${ctx.liveKey}`, 'x-rekey-user-token': userToken },
      payload: {
        planSlug,
        successUrl: 'https://app.example/ok',
        cancelUrl: 'https://app.example/cancel',
      },
    });

  // ---------- 1. atomicity ----------

  it('a plan whose provider registration is refused is never committed on sale', async () => {
    const created = await createRefusedPlan();
    // The caller is told it failed — unchanged, and the point of the bug is
    // that this answer used to be a lie about the database.
    expect(created.statusCode).toBe(401);

    // The row survives (the slug is not burned — see the repair test), but it
    // is inactive and explicitly marked as unregistered.
    const row = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId: ctx.appId, slug: 'brokenplan' } },
    });
    expect(row.active).toBe(false);
    expect(row.registrationStatus).toBe('FAILED');
    expect(row.registrationError).toContain('Invalid API Key provided');
    expect(row.metadata).not.toHaveProperty('stripe');

    // The audit's actual complaint: it was publicly on sale, and nothing on the
    // row distinguished it from a working plan.
    const publicList = await listPublicPlans();
    expect(publicList.statusCode).toBe(200);
    expect(
      (publicList.json().data as { items: { slug: string }[] }).items.map((p) => p.slug),
    ).not.toContain('brokenplan');

    // ...and the list is not empty by accident: a healthy plan still shows.
    const ok = await createPlan({ slug: 'goodplan', name: 'Good' });
    expect(ok.statusCode).toBe(201);
    const publicAfter = await listPublicPlans();
    const publicPage = publicAfter.json().data as {
      items: { slug: string }[];
      page: { total: number };
    };
    expect(publicPage.items.map((p) => p.slug)).toEqual(['goodplan']);
    // The refused plan is absent from the count too, so the catalogue does not
    // advertise a row a buyer can never reach.
    expect(publicPage.page.total).toBe(1);

    // The operator list DOES show it, visibly broken rather than missing —
    // a plan that silently vanished would be its own support ticket.
    const operatorList = await listOperatorPlans();
    const broken = (
      operatorList.json().data as { items: Record<string, unknown>[] }
    ).items.find((p) => p.slug === 'brokenplan');
    expect(broken).toBeDefined();
    expect(broken!.active).toBe(false);
    expect(broken!.registrationStatus).toBe('FAILED');
    expect(broken!.registrationError).toContain('Invalid API Key provided');
  });

  it('a refused plan cannot be put back on sale by flipping `active`', async () => {
    await createRefusedPlan();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/brokenplan`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { active: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PLAN_NOT_REGISTERED_WITH_PROVIDER');
    expect(res.json().error.fix).toContain('/register');

    const row = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId: ctx.appId, slug: 'brokenplan' } },
    });
    expect(row.active).toBe(false);
  });

  // ---------- 2. repairability ----------

  it('the operator repairs a refused plan in place, keeping the slug, and it sells', async () => {
    await createRefusedPlan();

    // Re-creating is still refused — which is exactly why the repair path has
    // to exist — but the refusal now names it instead of saying "pick a
    // different slug", which is not advice for a slug already on a price page.
    const dup = await createPlan({ slug: 'brokenplan' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('PLAN_SLUG_TAKEN');
    expect(dup.json().error.fix).toContain('/register');

    // The operator corrects the plan. `amount` is editable precisely because no
    // provider price exists to contradict it.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/brokenplan`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { name: 'Fixed', amount: 5900, currency: 'EUR', metadata: { tier: 'pro' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({
      slug: 'brokenplan',
      name: 'Fixed',
      amount: 5900,
      currency: 'EUR',
      active: false,
      registrationStatus: 'FAILED',
    });

    // The operator fixes the credentials; registration is retried. (The suite's
    // default fake registers successfully, which is the "good key" half.)
    const registered = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/brokenplan/register`,
      headers: { authorization: `Bearer ${ctx.operator}` },
    });
    expect(registered.statusCode).toBe(200);
    const repaired = registered.json().data as Record<string, unknown>;
    expect(repaired.registrationStatus).toBe('REGISTERED');
    expect(repaired.active).toBe(true);
    expect(repaired.registrationError).toBeNull();
    expect((repaired.metadata as { stripe?: { priceId?: string } }).stripe?.priceId).toMatch(
      /^price_/,
    );

    // Back on the public catalogue, same slug the pricing page always used.
    const publicList = await listPublicPlans();
    expect(
      (publicList.json().data as { items: { slug: string }[] }).items.map((p) => p.slug),
    ).toContain('brokenplan');

    // And a buyer can now actually check out — the end of the audit's sequence.
    const buyer = await signUpBuyer();
    const bought = await checkout('brokenplan', buyer);
    expect(bought.statusCode).toBe(200);
    expect((bought.json().data as { url: string }).url).toMatch(/^https:\/\/checkout\.stripe/);
  });

  it('re-registering is idempotent, and the price locks once a provider holds it', async () => {
    const created = await createPlan({ slug: 'lockedplan', name: 'Locked' });
    expect(created.statusCode).toBe(201);
    const priceId = (created.json().data as { metadata: { stripe: { priceId: string } } }).metadata
      .stripe.priceId;

    // Already registered → answered from the row, no provider construction.
    vi.mocked(getProviderForApplication).mockClear();
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/lockedplan/register`,
      headers: { authorization: `Bearer ${ctx.operator}` },
    });
    expect(again.statusCode).toBe(200);
    expect(
      (again.json().data as { metadata: { stripe: { priceId: string } } }).metadata.stripe.priceId,
    ).toBe(priceId);

    // The old immutability rule still holds where it was always right: a live
    // provider Price cannot be re-priced, so neither can our row.
    const repriced = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/lockedplan`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { amount: 100 },
    });
    expect(repriced.statusCode).toBe(409);
    expect(repriced.json().error.code).toBe('PLAN_PRICE_IMMUTABLE');

    // Non-price edits are still fine on a registered plan.
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${ctx.appId}/plans/lockedplan`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().data.name).toBe('Renamed');
    // ...and the stored provider id is untouched by a metadata patch.
    expect(
      (renamed.json().data as { metadata: { stripe: { priceId: string } } }).metadata.stripe
        .priceId,
    ).toBe(priceId);
  });

  // ---------- 3. checkout must not 500 ----------

  it('checkout on a plan with no provider price answers 409, not 500', async () => {
    // A legacy row: created before the write-ahead fix, so it is active and on
    // the catalogue with no `metadata.stripe`. Exactly the state the audit's
    // buyer clicked.
    const created = await createPlan({ slug: 'legacyplan', name: 'Legacy' });
    expect(created.statusCode).toBe(201);
    await prisma.plan.update({
      where: { applicationId_slug: { applicationId: ctx.appId, slug: 'legacyplan' } },
      data: { metadata: {}, active: true, registrationStatus: 'NOT_REQUIRED' },
    });

    // The REAL Stripe provider, not the fake: the fake would happily mint a
    // session and the assertion would be vacuous. No socket is opened — the
    // refusal happens before the first API call.
    vi.mocked(getProviderForApplication).mockImplementationOnce(
      async () => new RealStripeProvider({ apiKey: 'sk_test_ci_only', webhookSecret: 'whsec_x' }),
    );

    const buyer = await signUpBuyer('legacy-buyer@example.com');
    const res = await checkout('legacyplan', buyer);

    expect(res.statusCode).toBe(409);
    const err = res.json().error as { code: string; message: string; fix: string };
    expect(err.code).toBe('PLAN_NOT_REGISTERED_WITH_PROVIDER');
    expect(err.code).not.toBe('INTERNAL_ERROR');
    expect(err.message).not.toBe('An unexpected error occurred.');
    // The `fix` is aimed at the operator, who is the only party who can act.
    expect(err.fix).toContain(`/api/v1/tenant/applications/${ctx.appId}/plans/legacyplan/register`);
  });

  // ---------- 4. the same shape elsewhere ----------

  it('coupon creation never registers with a provider, so it cannot commit-then-fail', async () => {
    // The commit-then-register hazard only exists where a create crosses to the
    // provider. Coupons do not: the provider-side discount is minted per
    // CHECKOUT (stripe-real.createDiscount) and discarded if the session fails,
    // so there is no coupon row that can be committed against a refusal. This
    // asserts that property rather than describing it — a future eager
    // registration here would fail this test and get the same treatment plans
    // just got.
    vi.mocked(getProviderForApplication).mockClear();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${ctx.appId}/coupons`,
      headers: { authorization: `Bearer ${ctx.operator}` },
      payload: { code: 'LAUNCH50', discountType: 'PERCENT', amountOff: 5000 },
    });
    expect(res.statusCode).toBe(201);
    expect(vi.mocked(getProviderForApplication)).not.toHaveBeenCalled();

    const row = await prisma.coupon.findFirstOrThrow({ where: { applicationId: ctx.appId } });
    expect(row.active).toBe(true);
    expect(row.metadata).toEqual({});
  });
});
