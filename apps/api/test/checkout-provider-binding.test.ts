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
 * one, because the refusal has to happen BEFORE any provider is dialled, which
 * is also why proving it needs no PayPal credentials.
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
import { configureSandboxStripe } from './fakes/billing-credentials.js';

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
    providerSubId?: string;
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
        providerSubId: input.providerSubId ?? `I-PAYPALSUB-${Math.random().toString(36).slice(2)}`,
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
