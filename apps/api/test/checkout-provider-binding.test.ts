/**
 * A subscriber cannot be checked out through a second payment provider.
 *
 * `Subscription.provider` is immutable for the row's lifetime, so a buyer who
 * already pays through one processor and starts a checkout on another does not
 * get a changed subscription. They get a SECOND one, and two charges a month,
 * with nothing in either provider's dashboard hinting at the other.
 *
 * A guard for this existed and did not cover the case that happens. It was
 * keyed on (application, endUser, PLAN), so it only ever fired when someone
 * re-bought the identical plan. The ordinary path bills twice: subscribed to
 * `basic` through PayPal, upgrade to `pro`, get routed to Stripe. Different
 * planId, guard missed, two live subscriptions.
 *
 * These tests mostly seed the existing subscription directly rather than buying
 * one, because the refusal has to happen BEFORE any provider is dialled, so no
 * PayPal call is ever made.
 *
 * PayPal credentials are still configured wherever the SWITCH axis is the
 * claim. Without them the bound provider is also UNAVAILABLE, and since
 * availability is now answered first the test would read a refusal it did not
 * mean. See `boundProviderAlsoEnabled`.
 *
 * The exception is the positive case. Refusals alone are not evidence that the
 * pin works: a regression that silently stopped pinning would keep every
 * failure assertion green. So one test configures two providers with geo
 * routing and watches the pin STEER a checkout that succeeds.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { billingCredentialsService } from '../src/modules/billing/credentials.service.js';
import { CHECKOUT_SESSION_LIFETIME_MS } from '../src/modules/billing/checkout-sessions.js';
import { configureSandboxPaypal, configureSandboxStripe } from './fakes/billing-credentials.js';

const ADMIN_KEY = process.env.SUPER_ADMIN_KEY!;

describe('a subscription binds its buyer to one payment provider', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function post<T>(url: string, payload: unknown, key = ADMIN_KEY): Promise<T> {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${key}` },
      payload: payload as Record<string, unknown>,
    });
    return res.json().data as T;
  }

  beforeEach(async () => {
    const tenant = await post<{ id: string }>('/api/v1/admin/tenants', {
      name: 'BindT',
      ownerEmail: 'bind@example.com',
    });
    const application = await post<{ id: string }>('/api/v1/admin/applications', {
      tenantId: tenant.id,
      name: 'BindApp',
      slug: `bind-app-${Date.now()}`,
      enableBilling: true,
    });
    applicationId = application.id;
    const key = await post<{ rawKey: string }>(
      `/api/v1/admin/applications/${applicationId}/api-keys`,
      { name: 'k', mode: 'live' },
    );
    liveKey = key.rawKey;
    await configureSandboxStripe(applicationId);
  });

  /** Two plans, so the upgrade path is expressible. */
  async function twoPlans(): Promise<{ basic: string; pro: string }> {
    const basic = await post<{ slug: string }>(
      `/api/v1/admin/applications/${applicationId}/plans`,
      { slug: 'basic', name: 'Basic', amount: 900 },
    );
    const pro = await post<{ slug: string }>(
      `/api/v1/admin/applications/${applicationId}/plans`,
      { slug: 'pro', name: 'Pro', amount: 2900 },
    );
    return { basic: basic.slug, pro: pro.slug };
  }

  async function signUp(): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: `bind-${Date.now()}@example.com`, password: 'Bind-Passw0rd!42' },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { token: data.accessToken, id: data.endUser.id };
  }

  /** An existing subscription row, seeded in whatever state the case needs. */
  async function seedSub(input: {
    endUserId: string;
    planSlug: string;
    provider?: string | null;
    status?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'PENDING' | 'CANCELED';
    beneficiaryOrgId?: string;
    /**
     * Defaults to a PayPal-shaped id, EXCEPT on a PENDING row, where it
     * defaults to `null`.
     *
     * That split is what a real row looks like: checkout writes PENDING with
     * no provider subscription id, and a completion writes the id. Defaulting
     * one onto a PENDING fixture made two tests here assert the
     * unfinished-checkout wording against a row that carried a provider
     * subscription id, which is a state the wording is false of.
     *
     * Pass an explicit id with PENDING to build the other real case: Stripe's
     * `paused`, and every status this codebase does not recognise, map to
     * PENDING while KEEPING the id (providers/modules/stripe/index.ts:75).
     * `providerBacked` in `cancelCurrentSubscription` keys on the id, not the
     * status, so those rows are cancellable and paid.
     */
    providerSubId?: string | null;
    createdAt?: Date;
  }): Promise<{ id: string }> {
    const plan = await prisma.plan.findFirstOrThrow({
      where: { applicationId, slug: input.planSlug },
    });
    return prisma.subscription.create({
      data: {
        applicationId,
        endUserId: input.endUserId,
        planId: plan.id,
        provider: input.provider === undefined ? 'paypal' : input.provider,
        providerSubId:
          input.providerSubId !== undefined
            ? input.providerSubId
            : (input.status ?? 'ACTIVE') === 'PENDING'
              ? null
              : `I-PAYPALSUB-${Math.random().toString(36).slice(2)}`,
        status: input.status ?? 'ACTIVE',
        ...(input.beneficiaryOrgId !== undefined && { beneficiaryOrgId: input.beneficiaryOrgId }),
        ...(input.createdAt !== undefined && { createdAt: input.createdAt }),
      },
      select: { id: true },
    });
  }

  /** An existing, entitling subscription held at another processor. */
  async function seedPaypalSub(endUserId: string, planSlug: string): Promise<void> {
    await seedSub({ endUserId, planSlug, providerSubId: 'I-PAYPALSUB123' });
  }

  /**
   * PayPal configured and enabled, for the tests that mean to exercise the
   * SWITCH axis.
   *
   * `beforeEach` configures Stripe only, so seeding a PayPal subscription
   * also leaves PayPal unavailable. Availability is answered before the
   * caller's request, so without this the tests below would read the
   * availability guard rather than the switch guard, and their names would
   * stop describing what they measure. The two axes are told apart by the
   * error code; the tests that want the bound provider GONE say so by not
   * calling this.
   */
  async function boundProviderAlsoEnabled(): Promise<void> {
    await configureSandboxPaypal(applicationId);
  }

  /** An org the end-user OWNS, so they may check out on its behalf. */
  async function ownedOrg(ownerEndUserId: string, name = 'Acme'): Promise<string> {
    const org = await prisma.organization.create({
      data: {
        applicationId,
        name,
        slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, endUserId: ownerEndUserId, role: 'OWNER' },
    });
    return org.id;
  }

  /** A plan the admin route cannot express: it has no `kind` field. */
  async function rawPlan(data: {
    slug: string;
    kind: 'CREDIT' | 'LICENSE' | 'SUBSCRIPTION';
    licenseKind?: 'PERPETUAL' | 'TIMED' | 'SEATS';
  }): Promise<string> {
    const plan = await prisma.plan.create({
      data: {
        applicationId,
        slug: data.slug,
        name: data.slug,
        amount: 500,
        currency: 'USD',
        kind: data.kind,
        ...(data.kind === 'CREDIT' && { creditsAmount: 100 }),
        ...(data.licenseKind !== undefined && { licenseKind: data.licenseKind }),
        ...(data.licenseKind === 'TIMED' && { licenseDurationDays: 30 }),
        registrationStatus: 'NOT_REQUIRED',
      },
      select: { slug: true },
    });
    return plan.slug;
  }

  async function checkout(
    token: string,
    planSlug: string,
    provider?: string,
    extra?: { organizationId?: string; country?: string },
  ): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': token },
      payload: {
        planSlug,
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/no',
        ...(provider !== undefined && { provider }),
        ...extra,
      },
    });
  }

  /** The provider a 200 checkout was issued through. */
  function issuedProvider(res: LightMyRequestResponse): string {
    return (res.json().data as { provider: string }).provider;
  }

  function errorOf(res: LightMyRequestResponse): { code: string; message: string; fix?: string } {
    return res.json().error as { code: string; message: string; fix?: string };
  }

  it('refuses an upgrade routed to a different processor, which is the case that bills twice', async () => {
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedPaypalSub(user.id, basic);

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode).toBe(409);
    const err = res.json().error as { code: string; message: string };
    expect(err.code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    // The message has to say WHY, because the operator reading it is deciding
    // whether to tell the buyer to cancel.
    expect(err.message).toContain('paypal');
    expect(err.message).toContain('bill them twice');
  });

  it('pins to the bound processor when no provider was asked for, rather than letting the router drift', async () => {
    // Nobody asked, so refusing would be wrong: the buyer did nothing. But
    // letting the geo router pick freely is how this bug happens silently, on a
    // trip abroad or after a routing change. Stripe is the only provider
    // configured here, so pinning to PayPal must make the checkout fail to
    // reach Stripe rather than quietly succeeding on it.
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedPaypalSub(user.id, basic);

    const res = await checkout(user.token, pro);

    // Named exactly, not `>= 400`. The looser assertion passed on any 4xx at
    // all, so a checkout that failed for some unrelated reason counted as
    // evidence of pinning.
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    // It refused because PayPal is not configured, NOT because it fell through
    // to Stripe and created a second subscription.
    const subs = await prisma.subscription.findMany({
      where: { applicationId, endUserId: user.id },
    });
    expect(subs).toHaveLength(1);
    expect(subs[0]!.provider).toBe('paypal');
  });

  it('routes a pinned buyer to the bound processor while an unbound one follows the geo router', async () => {
    // The positive half of the claim, and the only test here that watches the
    // pin actually STEER a checkout rather than refuse one. Without it every
    // piece of evidence in this file is a failure, and a regression that
    // silently stopped pinning would leave the suite green.
    //
    // Two providers configured with PayPal winning DE on the country list, so
    // "pinned" and "routed" give visibly different answers for the same buyer.
    await billingCredentialsService.upsertRaw(
      applicationId,
      'paypal',
      { clientId: 'pp_bind', clientSecret: 'pp_secret', webhookId: 'WH-bind' },
      { mode: 'test', enabled: true, countries: ['DE'], priority: 10 },
    );
    const { basic, pro } = await twoPlans();

    const unbound = await signUp();
    const routed = await checkout(unbound.token, pro, undefined, { country: 'DE' });
    expect(routed.statusCode, JSON.stringify(routed.json())).toBe(200);
    expect(issuedProvider(routed)).toBe('paypal');

    const bound = await signUp();
    await seedSub({ endUserId: bound.id, planSlug: basic, provider: 'stripe' });
    const pinned = await checkout(bound.token, pro, undefined, { country: 'DE' });
    expect(pinned.statusCode, JSON.stringify(pinned.json())).toBe(200);
    expect(issuedProvider(pinned)).toBe('stripe');
    const row = await prisma.subscription.findFirstOrThrow({
      where: { applicationId, endUserId: bound.id, plan: { slug: pro } },
    });
    expect(row.provider).toBe('stripe');
  });

  it('refuses when the row the checkout would WRITE is bound elsewhere, even when the subject differs', async () => {
    // The upsert is keyed `(applicationId, endUserId, planId)` and does not
    // include `beneficiaryOrgId`, so a personal row and an org-billed checkout
    // for the same (user, plan) are the SAME row. Guarding only by subject
    // inspected one row and wrote another: 200 OK, `provider` flipped
    // paypal→stripe while `providerSubId` stayed the PayPal one. PayPal kept
    // charging and no local row pointed at it any more.
    await boundProviderAlsoEnabled();
    const { pro } = await twoPlans();
    const user = await signUp();
    await seedSub({
      endUserId: user.id,
      planSlug: pro,
      provider: 'paypal',
      providerSubId: 'I-PAYPALSUB123',
    });
    const orgId = await ownedOrg(user.id);

    const res = await checkout(user.token, pro, 'stripe', { organizationId: orgId });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    const rows = await prisma.subscription.findMany({ where: { applicationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('paypal');
    expect(rows[0]!.providerSubId).toBe('I-PAYPALSUB123');
  });

  it('refuses to move an entitling row onto a different billing subject, even when the processor agrees', async () => {
    // The provider comparison that used to sit at the upsert was doing two
    // jobs, and only one of them was about providers. `existing.provider !==
    // providerName` also refused any checkout about to REWRITE an entitling
    // row, whenever the router happened to disagree. Pinning makes the two
    // sides agree by construction, so that comparison can never fire again and
    // the rewrite became unconditional.
    //
    // Alice owns Acme and Beta. Acme holds `pro`. She opens a checkout for
    // `pro` on behalf of Beta, and because the upsert is keyed
    // `(applicationId, endUserId, planId)` with no `beneficiaryOrgId`, that is
    // Acme's row: 200 OK, `beneficiaryOrgId` rewritten acme→beta, still
    // ACTIVE, still carrying Acme's provider subscription id. Acme's
    // entitlement reads null, Beta has it for free, the processor keeps
    // charging Acme, and no payment was involved. Opening checkout did it.
    const { pro } = await twoPlans();
    const alice = await signUp();
    const acme = await ownedOrg(alice.id, 'Acme');
    const beta = await ownedOrg(alice.id, 'Beta');
    await seedSub({
      endUserId: alice.id,
      planSlug: pro,
      provider: 'stripe',
      providerSubId: 'sub_ACME',
      beneficiaryOrgId: acme,
    });

    const res = await checkout(alice.token, pro, undefined, { organizationId: beta });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_SUBSCRIPTION_SUBJECT_CONFLICT');
    const rows = await prisma.subscription.findMany({ where: { applicationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beneficiaryOrgId).toBe(acme);
    expect(rows[0]!.providerSubId).toBe('sub_ACME');
    // The measurement that made this a regression rather than a shape problem:
    // Acme's entitlement had to survive the attempt.
    const stillAcmes = await app.inject({
      method: 'GET',
      url: `/api/v1/billing/subscription?organizationId=${acme}`,
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': alice.token },
    });
    expect((stillAcmes.json().data as { id: string } | null)?.id).toBe(rows[0]!.id);
  });

  it('refuses the personal↔org direction of the same rewrite', async () => {
    // The mirror, and the one that does not need two orgs to reach: a personal
    // subscription and an org checkout for the same (user, plan) are the same
    // row too. Only the provider disagreeing used to stop this.
    const { pro } = await twoPlans();
    const user = await signUp();
    await seedSub({
      endUserId: user.id,
      planSlug: pro,
      provider: 'stripe',
      providerSubId: 'sub_PERSONAL',
    });
    const orgId = await ownedOrg(user.id);

    const res = await checkout(user.token, pro, 'stripe', { organizationId: orgId });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_SUBSCRIPTION_SUBJECT_CONFLICT');
    const rows = await prisma.subscription.findMany({ where: { applicationId } });
    expect(rows[0]!.beneficiaryOrgId).toBeNull();
    expect(rows[0]!.providerSubId).toBe('sub_PERSONAL');
  });

  it('still lets a PENDING row change subject, which is the part #431 has to close', async () => {
    // Recorded as a deliberate gap rather than left to be rediscovered. The
    // subject guard protects a LIVE subscription, because that is the one an
    // opened checkout was silently destroying. A PENDING row is a checkout
    // nobody completed, and refusing over it would tell the buyer to cancel
    // something that does not exist — the exact shape of refusal that had to
    // be removed once already for one-off purchases.
    //
    // What it leaves open is narrow and is not new: the earlier subject's
    // session can still be paid after the row has moved, so the payment lands
    // under the later subject. That is the same hole two open sessions on one
    // row already carry, and both close when `beneficiaryOrgId` joins the
    // uniqueness constraint (#431).
    const { pro } = await twoPlans();
    const user = await signUp();
    const orgId = await ownedOrg(user.id);
    await seedSub({
      endUserId: user.id,
      planSlug: pro,
      provider: 'stripe',
      status: 'PENDING',
      beneficiaryOrgId: orgId,
    });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });

  it('lets the same subject re-open a checkout on a plan it already holds', async () => {
    // The guard is about the subject CHANGING, not about an entitling row
    // being present. Upgrading, re-entering a coupon, or resubscribing on the
    // same subject all land on the row legitimately, and refusing those would
    // break the account page.
    const { pro } = await twoPlans();
    const user = await signUp();
    const orgId = await ownedOrg(user.id);
    await seedSub({
      endUserId: user.id,
      planSlug: pro,
      provider: 'stripe',
      beneficiaryOrgId: orgId,
    });

    const res = await checkout(user.token, pro, undefined, { organizationId: orgId });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(issuedProvider(res)).toBe('stripe');
  });

  it('does not let a past one-off purchase bind the buyer to its processor', async () => {
    // The exemption has to run both ways. A buyer who once bought a $5 credit
    // pack through Stripe was refused their FIRST PayPal subscription and told
    // to cancel a subscription that does not exist. One-time rows are also
    // written ACTIVE with no period, so they stay ACTIVE forever.
    await billingCredentialsService.upsertRaw(
      applicationId,
      'paypal',
      { clientId: 'pp_bind', clientSecret: 'pp_secret', webhookId: 'WH-bind' },
      { mode: 'test', enabled: true },
    );
    const { pro } = await twoPlans();
    const pack = await rawPlan({ slug: 'pack-bought', kind: 'CREDIT' });
    const perpetual = await rawPlan({
      slug: 'perpetual-bought',
      kind: 'LICENSE',
      licenseKind: 'PERPETUAL',
    });
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: pack, provider: 'stripe' });
    await seedSub({ endUserId: user.id, planSlug: perpetual, provider: 'stripe' });

    const res = await checkout(user.token, pro, 'paypal');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(issuedProvider(res)).toBe('paypal');
  });

  it('keeps a TIMED licence guarded, because it recurs', async () => {
    // The one-off carve-out is about purchases that create no second billing
    // relationship. A TIMED licence renews, so it is neither exempt as the
    // thing being bought nor exempt as the thing that binds.
    await boundProviderAlsoEnabled();
    const { pro } = await twoPlans();
    const timed = await rawPlan({ slug: 'timed-lic', kind: 'LICENSE', licenseKind: 'TIMED' });

    const buyer = await signUp();
    await seedPaypalSub(buyer.id, pro);
    const buyingTimed = await checkout(buyer.token, timed, 'stripe');
    expect(buyingTimed.statusCode, JSON.stringify(buyingTimed.json())).toBe(409);
    expect(errorOf(buyingTimed).code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');

    const holder = await signUp();
    await seedSub({ endUserId: holder.id, planSlug: timed, provider: 'paypal' });
    const boundByTimed = await checkout(holder.token, pro, 'stripe');
    expect(boundByTimed.statusCode, JSON.stringify(boundByTimed.json())).toBe(409);
    expect(errorOf(boundByTimed).code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
  });

  it.each(['TRIALING', 'PAST_DUE'] as const)('binds on a %s subscription too', async (status) => {
    // Both are entitling and both are live billing relationships: a trial
    // converts into a charge and a past-due one is still being retried.
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, status });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
  });

  it('lets a buyer change processor on a checkout they have not finished, which is one row either way', async () => {
    // The deliberately open case, recorded so it is not mistaken for an
    // oversight. Two open sessions on ONE plan are one row by design and both
    // stay completable, so refusing the second would block the ordinary
    // "picked PayPal, went back, chose Stripe" without closing anything.
    //
    // What makes that safe is the second-completion guard in the webhook
    // applier. This comment used to assert that guard as a fact while it did
    // not exist, and both completions landed. It is proven in
    // `checkout-double-completion.test.ts`; this case is only safe for as long
    // as that file is green.
    const { pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: pro, status: 'PENDING' });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(issuedProvider(res)).toBe('stripe');
  });

  it('binds on a checkout that is still open, so two tabs cannot complete on two processors', async () => {
    // PENDING was excluded, which left the reachable version of the bug: start
    // a PayPal checkout, abandon the tab, start a Stripe one on another plan,
    // pay both. Two webhooks land, two ACTIVE subscriptions on two processors.
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, status: 'PENDING' });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
  });

  it('stops binding on a PENDING checkout once its sessions can no longer be completed', async () => {
    // The other side of the same tradeoff: a checkout nobody finished must not
    // pin the buyer to that processor for life.
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    const stale = await seedSub({ endUserId: user.id, planSlug: basic, status: 'PENDING' });
    // `updatedAt` is maintained by Prisma, so age it in SQL rather than asking
    // for a value the client will overwrite.
    await prisma.$executeRaw`UPDATE subscriptions SET updated_at = ${new Date(
      Date.now() - CHECKOUT_SESSION_LIFETIME_MS - 60_000,
    )} WHERE id = ${stale.id}`;

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(issuedProvider(res)).toBe('stripe');
  });

  it('binds to the OLDEST provider when a buyer already holds two, so the answer is stable', async () => {
    // Buyers who were billed twice before this guard existed hold two entitling
    // subscriptions. Without an `orderBy` the binding provider was whatever
    // Postgres handed back first, so the same buyer could be told a different
    // answer on two consecutive requests.
    const { basic, pro } = await twoPlans();
    const extra = await rawPlan({ slug: 'extra', kind: 'SUBSCRIPTION' });
    const user = await signUp();
    await seedSub({
      endUserId: user.id,
      planSlug: basic,
      provider: 'paypal',
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    });
    await seedSub({
      endUserId: user.id,
      planSlug: extra,
      provider: 'stripe',
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    expect(errorOf(res).message).toContain('paypal');
  });

  it('says the bound provider is gone, not that the caller should omit one they never sent', async () => {
    // Disabling a provider that live subscribers are bound to locks them out of
    // every recurring purchase. Blocking is right; `BILLING_PROVIDER_NOT_AVAILABLE`
    // telling them to "omit `provider`" is not, because they did.
    await billingCredentialsService.upsertRaw(
      applicationId,
      'paypal',
      { clientId: 'pp_bind', clientSecret: 'pp_secret', webhookId: 'WH-bind' },
      { mode: 'test', enabled: true },
    );
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, provider: 'stripe' });
    await billingCredentialsService.setEnabled(applicationId, 'stripe', false);

    const res = await checkout(user.token, pro);

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(err.message).toContain('stripe');
    expect(err.fix).toMatch(/re-enable|cancel/i);
  });

  it('says the bound provider is gone even when the caller named a different one', async () => {
    // The availability question is settled before the caller's request is
    // judged, because it does not depend on what they asked for.
    //
    // It used to be judged after. The switch guard ran first and had never
    // looked at availability, so a subscriber bound to a DISABLED provider who
    // named another one was told to "check out through <bound>", the one
    // instruction that cannot be followed. Naming a provider and naming none
    // are the same situation from the operator's side, and the answer is the
    // same fact.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, provider: 'paypal' });
    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    // Specifically NOT the switch refusal, whose fix orders them to use PayPal.
    expect(err.fix).not.toMatch(/check out through "paypal"/i);
  });

  it('does not offer "cancel it" as the way out when the credentials are deleted rather than disabled', async () => {
    // Disabled and deleted are one state to the router and two to the operator.
    // `getProviderForApplication` decrypts whatever row exists and ignores
    // `enabled`, so cancellation still reaches a DISABLED provider. With the
    // credentials REMOVED it throws, so the buyer can neither buy nor cancel,
    // and the remedy the error offered was one nobody could take.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, provider: 'paypal' });
    await billingCredentialsService.remove(applicationId, 'paypal');

    const res = await checkout(user.token, pro);

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(err.message).toContain('no longer configured');
    expect(err.fix).toMatch(/re-add/i);
    // And it must not send them to a cancel that cannot run.
    expect(err.fix).not.toMatch(/cancel their "paypal" subscription/i);

    // NOT asserted here, because this suite cannot see it: that cancellation
    // fails in this state. `test/setup.ts` mocks `getProviderForApplication`
    // for every file, so the real one (`providers/index.ts`, which throws
    // `credentialsNotConfigured` when `loadDecryptedWithMode` returns null)
    // never runs, and an injected cancel returns 200 here whatever the
    // credentials say. The un-mocked suite that would see it,
    // `test-providers/`, needs real sandbox credentials and is not run in CI.
    //
    // So this test pins the WORDING and the reasoning behind it is recorded
    // rather than proved. If the mock seam ever moves, prove it here.
  });

  it('does not tell a buyer who has never paid to cancel a subscription', async () => {
    // A PENDING row binds (two payable sessions at two processors bill twice
    // just as two subscriptions do), but it is an unfinished checkout, not a
    // subscription. "already pays" and "cancel the existing subscription"
    // describe somebody who does not exist, and the portal repeats this text
    // to the buyer verbatim.
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, status: 'PENDING' });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    expect(err.message).not.toMatch(/already pays/i);
    expect(err.message).toMatch(/unfinished checkout/i);
    // It may SAY there is nothing for Rekey to cancel; it must not order one,
    // and it must not assert that nothing was charged.
    expect(err.fix).not.toMatch(/cancel the existing subscription/i);
    expect(err.fix).not.toMatch(/nothing has been charged/i);
    // And it says what the buyer can actually do instead.
    expect(err.fix).toMatch(/finish the checkout/i);
  });

  it('does not say a trialist "already pays"', async () => {
    // Third binder state where the paid wording is untrue. A trial is a live
    // billing relationship that converts into a charge, so unlike a PENDING
    // checkout it IS cancellable and the remedy stands; what is false is
    // "already pays for X". PAST_DUE keeps the paid wording, because it has
    // paid before and the card is being retried.
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, status: 'TRIALING' });

    const res = await checkout(user.token, pro, 'stripe');

    const err = errorOf(res);
    expect(err.code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    expect(err.message).not.toMatch(/already pays/i);
    expect(err.message).toMatch(/on a trial/i);
    // The remedy is still cancellation, because a trial can be cancelled.
    expect(err.fix).toMatch(/cancel the existing subscription/i);
  });

  it('still says "already pays" when the binder is a real subscription', async () => {
    // The other half of the split. Without this, wording the PENDING case
    // could quietly reword the paid one and nothing would notice.
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedPaypalSub(user.id, basic);

    const res = await checkout(user.token, pro, 'stripe');

    const err = errorOf(res);
    expect(err.code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    expect(err.message).toMatch(/already pays/i);
    expect(err.fix).toMatch(/cancel the existing subscription/i);
  });

  it('does not tell an unfinished checkout to cancel a subscription on the OTHER refusal either', async () => {
    // Availability is answered before the caller's provider, so a PENDING
    // binder at a disabled processor lands here rather than on
    // BILLING_PROVIDER_SWITCH_BLOCKED. Both refusals therefore need the
    // unpaid wording; wording only one of them leaves this path telling a
    // buyer who has never paid to cancel a subscription.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, provider: 'paypal', status: 'PENDING' });
    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(err.message).not.toMatch(/pays through/i);
    expect(err.message).toMatch(/unfinished checkout/i);
    expect(err.fix).not.toMatch(/cancel their/i);
    expect(err.fix).toMatch(/nothing for Rekey to cancel/i);
    // Specifically not "nothing has been charged". PENDING means no completion
    // was applied, and a buyer whose payment succeeded while the webhook was
    // lost is in this state (billing-reconciliation.md, F-A and F-D).
    expect(err.fix).not.toMatch(/nothing has been charged/i);
  });

  it('does not claim an unfinished checkout cannot be cancelled when the credentials are deleted', async () => {
    // Stronger than wording. `providerBacked` is
    // `Boolean(sub.provider && sub.providerSubId)`, and a PENDING row has no
    // `providerSubId`, so cancelling it never dials the processor and works
    // whatever the credentials say. The deleted-credentials text asserts the
    // opposite, which would be a false statement about the product.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();

    // The binder is created by a REAL checkout rather than seeded. Seeding
    // `providerSubId: null` and asserting it is null measures the fixture, and
    // would stay green on the day checkout starts stamping an id on PENDING
    // rows, which is the fact the message rests on.
    const opened = await checkout(user.token, basic, 'paypal');
    expect(opened.statusCode, JSON.stringify(opened.json())).toBe(200);
    const binder = await prisma.subscription.findFirstOrThrow({
      where: { applicationId, endUserId: user.id },
    });
    expect(binder.status).toBe('PENDING');
    // Not provider-backed, so `cancelCurrentSubscription` dials nobody and
    // cancelling works whatever the credentials say.
    expect(binder.providerSubId).toBeNull();

    await billingCredentialsService.remove(applicationId, 'paypal');

    const res = await checkout(user.token, pro, 'stripe');

    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(err.fix).not.toMatch(/neither buy nor cancel/i);
    // And it must not claim nothing was charged: PENDING means no completion
    // was applied, which a lost webhook also produces.
    expect(err.fix).not.toMatch(/nothing has been charged/i);

    // The remedy the text offers, performed literally: re-adding the
    // credentials the way the panel does restores checkout on its own, with
    // no separate enable step, because `upsertRaw`'s create branch defaults
    // `enabled: true`.
    //
    // It checks out `pro`, not `basic`. `basic` is the binder's own plan and
    // the PENDING clause excludes it, so with no provider named that checkout
    // routes to the still-enabled Stripe and returns 200 whether or not the
    // remedy was performed. Asserting the ISSUED PROVIDER is what makes this
    // measure the remedy rather than the fallback.
    await configureSandboxPaypal(applicationId);
    const afterReAdd = await checkout(user.token, pro);
    expect(afterReAdd.statusCode, JSON.stringify(afterReAdd.json())).toBe(200);
    expect(issuedProvider(afterReAdd)).toBe('paypal');
  });

  it('does not tell a trialist they "pay through" a provider on the availability refusal either', async () => {
    // The TRIALING split has to be on BOTH refusals. Putting it on one is the
    // mistake this change already made with PENDING, and this is the more
    // reachable of the two: it fires whether or not a provider was named.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, status: 'TRIALING' });
    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);

    for (const named of ['stripe', undefined] as const) {
      const res = await checkout(user.token, pro, named);
      const err = errorOf(res);
      expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
      expect(err.message).not.toMatch(/pays through/i);
      expect(err.message).toMatch(/on a trial/i);
    }
  });

  it('does not call a PAUSED subscription an unfinished checkout', async () => {
    // PENDING alone does not mean "unfinished checkout". Stripe's `paused`
    // maps to PENDING (providers/modules/stripe/index.ts:75), as does every
    // status this codebase does not recognise, and those rows KEEP their
    // `providerSubId`. Such a row is a real provider-side subscription, so
    // every sentence the unpaid wording asserts is false of it: there IS
    // something to cancel, a payment HAS been recorded, and cancelling dials
    // the processor like any other provider-backed row.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({
      endUserId: user.id,
      planSlug: basic,
      provider: 'paypal',
      status: 'PENDING',
      providerSubId: 'I-PAUSED-SUB',
    });

    const switched = errorOf(await checkout(user.token, pro, 'stripe'));
    expect(switched.code).toBe('BILLING_PROVIDER_SWITCH_BLOCKED');
    expect(switched.message).not.toMatch(/unfinished checkout/i);
    expect(switched.fix).not.toMatch(/nothing for Rekey to cancel/i);

    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);
    const unavailable = errorOf(await checkout(user.token, pro, 'stripe'));
    expect(unavailable.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(unavailable.message).not.toMatch(/unfinished checkout/i);
    expect(unavailable.fix).not.toMatch(/nothing for Rekey to cancel/i);
  });

  it('does not claim a disabled provider stops the checkout already started being paid', async () => {
    // Completions resolve credentials through `loadDecryptedWithMode`, which
    // never consults `enabled`. So a checkout opened at a provider that is
    // later DISABLED still completes; only DELETED credentials refuse it. The
    // remedy text said re-enabling was what let the started checkout be paid,
    // which is false in the disabled case and true only in the deleted one.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({
      endUserId: user.id,
      planSlug: basic,
      provider: 'paypal',
      status: 'PENDING',
      providerSubId: null,
    });
    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);

    const disabled = errorOf(await checkout(user.token, pro, 'stripe'));
    expect(disabled.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(disabled.fix).toMatch(/completions do not consult whether a provider is enabled/i);

    await billingCredentialsService.remove(applicationId, 'paypal');
    const deleted = errorOf(await checkout(user.token, pro, 'stripe'));
    expect(deleted.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(deleted.fix).toMatch(/so a payment completed there can still be recorded/i);
    // And the two must not share the claim that only one of them supports.
    expect(deleted.fix).not.toMatch(/completions do not consult/i);
  });

  it('names the buyer’s own provider when an Application has no enabled providers at all', async () => {
    // A status change worth pinning: this used to answer 400
    // BILLING_CREDENTIALS_NOT_CONFIGURED, which names
    // `billingConfig.provider ?? 'stripe'` and so could name a processor this
    // buyer has no relationship with. The binding is the more specific fact.
    await configureSandboxPaypal(applicationId);
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    await seedSub({ endUserId: user.id, planSlug: basic, provider: 'paypal' });
    await billingCredentialsService.setEnabled(applicationId, 'paypal', false);
    await billingCredentialsService.setEnabled(applicationId, 'stripe', false);

    const res = await checkout(user.token, pro);

    expect(res.statusCode, JSON.stringify(res.json())).toBe(409);
    const err = errorOf(res);
    expect(err.code).toBe('BILLING_BOUND_PROVIDER_UNAVAILABLE');
    expect(err.message).toContain('paypal');
  });

  it('does not bind on a subscription whose scheduled cancellation has already passed', async () => {
    // Same database state answered checkout two different ways depending on
    // whether an unrelated read had run first. `expireIfDue` is lazy: it flips
    // a due row to CANCELED the first time anybody READS it, and the binding
    // query is not such a read. So a buyer got 409 until someone happened to
    // load GET /billing/subscription, and 200 afterwards, with nothing about
    // the subscription having changed in between (#439).
    await boundProviderAlsoEnabled();
    const { basic, pro } = await twoPlans();
    const user = await signUp();
    const seeded = await seedSub({ endUserId: user.id, planSlug: basic, provider: 'paypal' });
    // Scheduled to cancel, and that moment has passed. Nothing has swept it.
    await prisma.subscription.update({
      where: { id: seeded.id },
      data: { cancelAt: new Date(Date.now() - 60_000) },
    });

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    // And the row really was still ACTIVE when the checkout was answered, so
    // the test is measuring the filter and not a sweep that beat it there.
    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(row.status).toBe('ACTIVE');
  });

  it('leaves a buyer with no subscription free to pick any configured processor', async () => {
    const { pro } = await twoPlans();
    const user = await signUp();

    const res = await checkout(user.token, pro, 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });

  it('does not block a one-off purchase, which creates no second billing relationship', async () => {
    // A credit pack bought through Stripe while subscribed through PayPal is a
    // single charge. Refusing it would block a legitimate sale to defend
    // against a problem it cannot cause.
    const { basic } = await twoPlans();
    // Written directly: the admin plan route has no `kind` field and always
    // creates a SUBSCRIPTION, which silently made the first version of this
    // test assert the opposite of what it claimed.
    await prisma.plan.create({
      data: {
        applicationId,
        slug: 'pack',
        name: 'Credit pack',
        amount: 500,
        currency: 'USD',
        kind: 'CREDIT',
        creditsAmount: 100,
        registrationStatus: 'NOT_REQUIRED',
      },
    });
    const user = await signUp();
    await seedPaypalSub(user.id, basic);

    const res = await checkout(user.token, 'pack', 'stripe');

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
  });
});
