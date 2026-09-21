/**
 * Importing a book of business a billing system already sold.
 *
 * The event feed covers everything after a system connects. It cannot cover
 * what was sold before, which on migration day is everything, hence an import.
 * And an import is the most dangerous shape a button can have: a bulk write
 * against somebody else's data, matching strangers to local accounts by email.
 *
 * So the cases here are mostly about the REFUSALS, because the happy path is
 * the easy half:
 *
 *   - a preview writes no subscriptions at all;
 *   - an existing ACTIVE subscriber is never overwritten;
 *   - an erased end-user is never matched, and never re-created;
 *   - a row whose plan maps to nothing is skipped with a reason, not guessed at;
 *   - applying twice does not import twice.
 *
 * The provider is stubbed at the module seam rather than over HTTP: what is
 * under test is the decision table, not `fetch`. The real pull implementation
 * and its signing are exercised separately.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ExternalSubscription } from '../src/modules/billing/providers/types.js';

/** Rows the stubbed provider will return for the next dry run. */
const feed: { items: ExternalSubscription[] } = { items: [] };

vi.mock('../src/modules/billing/providers/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/billing/providers/index.js')>();
  return {
    ...actual,
    getProviderForApplication: async (application: unknown, provider: string) => {
      if (provider !== 'external') {
        return actual.getProviderForApplication(application as never, provider as never);
      }
      return {
        name: 'external',
        async listSubscriptions() {
          return { items: feed.items };
        },
      };
    },
  };
});

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');

interface World {
  ownerToken: string;
  applicationId: string;
  slug: string;
}

function row(over: Partial<ExternalSubscription> & { email: string }): ExternalSubscription {
  const { email, ...rest } = over;
  return {
    externalId: `sub_${Math.random().toString(36).slice(2, 10)}`,
    status: 'active',
    planRef: 'pro',
    customer: { email },
    ...rest,
  } as ExternalSubscription;
}

describe('subscription import', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.94.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function world(): Promise<World> {
    currentIp = `10.94.${++n}.1`;
    const slug = `imp-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `owner-${slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Import Co',
      },
    });
    expect(su.statusCode).toBe(201);
    const ownerToken = (su.json().data as { accessToken: string }).accessToken;

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Import app', slug },
    });
    expect(appRes.statusCode).toBe(201);
    const applicationId = (appRes.json().data as { id: string }).id;

    // A plan whose SLUG is the provider's planRef, which is the mapping an
    // operator gets for free when the two already agree.
    const plan = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { slug: 'pro', name: 'Pro', amount: 2900, kind: 'SUBSCRIPTION', interval: 'MONTH' },
    });
    expect(plan.statusCode).toBe(201);

    return { ownerToken, applicationId, slug };
  }

  const auth = (w: World) => ({ authorization: `Bearer ${w.ownerToken}` });
  const base = (w: World) => `/api/v1/tenant/applications/${w.applicationId}`;

  async function dryRun(w: World, matchStrategy = 'email_or_create') {
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports`,
      headers: auth(w),
      payload: { provider: 'external', matchStrategy },
    });
    expect(res.statusCode).toBe(201);
    const runId = (res.json().data as { runId: string }).runId;
    const read = await inject({
      method: 'GET',
      url: `${base(w)}/subscription-imports/${runId}?limit=100`,
      headers: auth(w),
    });
    expect(read.statusCode, read.body).toBe(200);
    return {
      runId,
      run: read.json().data.run as { status: string; counts: Record<string, number> },
      items: read.json().data.items.items as Array<{
        externalId: string;
        outcome: string;
        email: string | null;
        detail: { reason?: string };
      }>,
    };
  }

  async function makeEndUser(w: World, email: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: `${base(w)}/end-users`,
      headers: auth(w),
      payload: { email },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  // ---------- the preview writes nothing ----------

  it('a dry run decides every row and writes no subscriptions', async () => {
    const w = await world();
    await makeEndUser(w, 'known@example.com');
    feed.items = [
      row({ email: 'known@example.com' }),
      row({ email: 'stranger@example.com' }),
      row({ email: 'nomatch@example.com', planRef: 'plan-we-do-not-have' }),
      row({ email: 'gone@example.com', status: 'canceled' }),
      { ...row({ email: 'x@example.com' }), customer: { email: '' } } as ExternalSubscription,
    ];

    const { run, items } = await dryRun(w);
    expect(run.status).toBe('ready');

    const byEmail = new Map(items.map((i) => [i.email, i.outcome]));
    expect(byEmail.get('known@example.com')).toBe('match');
    expect(byEmail.get('stranger@example.com')).toBe('create');
    expect(byEmail.get('nomatch@example.com')).toBe('skip_no_plan');
    expect(byEmail.get('gone@example.com')).toBe('skip_invalid');

    // Every refusal explains itself. A preview reading "5 rows, 2 importable"
    // with no reasons is a black box the operator has to trust.
    for (const i of items) {
      if (i.outcome.startsWith('skip')) expect(i.detail.reason).toEqual(expect.any(String));
    }

    // The whole point of the step.
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  it('without email_or_create, an unknown address is skipped rather than created', async () => {
    const w = await world();
    feed.items = [row({ email: 'stranger@example.com' })];
    const { items } = await dryRun(w, 'email');
    expect(items[0]!.outcome).toBe('skip_invalid');
    expect(items[0]!.detail.reason).toMatch(/No end-user/i);
  });

  // ---------- never overwrite ----------

  it('an end-user who is already subscribed is skipped, not updated', async () => {
    const w = await world();
    const euid = await makeEndUser(w, 'subscribed@example.com');
    const granted = await inject({
      method: 'POST',
      url: `${base(w)}/end-users/${euid}/subscriptions`,
      headers: auth(w),
      payload: { planSlug: 'pro', note: 'existing' },
    });
    expect(granted.statusCode).toBe(201);

    feed.items = [row({ email: 'subscribed@example.com' })];
    const { items } = await dryRun(w);
    expect(items[0]!.outcome).toBe('skip_active');
    expect(items[0]!.detail.reason).toMatch(/already/i);
  });

  // ---------- never resurrect ----------

  it('an erased end-user is never matched and never re-created', async () => {
    const w = await world();
    const euid = await makeEndUser(w, 'erased@example.com');
    const erase = await inject({
      method: 'DELETE',
      url: `${base(w)}/end-users/${euid}?erasure=true`,
      headers: auth(w),
    });
    expect(erase.statusCode).toBe(200);

    // The address is anonymised by the erasure, so the row will not match it,
    // but the case that matters is that it is not RE-CREATED either, which
    // would rebuild the person a GDPR request removed.
    feed.items = [row({ email: 'erased@example.com' })];
    const { runId, items } = await dryRun(w);
    expect(items[0]!.outcome).toBe('create');

    await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    // A fresh account under that address is correct: the tombstone keeps the
    // anonymised one, and this is a new person as far as Rekey is concerned.
    const rebuilt = await prisma.endUser.findFirst({
      where: { applicationId: w.applicationId, email: 'erased@example.com' },
    });
    expect(rebuilt?.erasedAt ?? null).toBeNull();
  });

  // ---------- applying ----------

  it('apply imports the decided rows, creates unlinked users, and is not repeatable', async () => {
    const w = await world();
    await makeEndUser(w, 'known@example.com');
    feed.items = [row({ email: 'known@example.com' }), row({ email: 'stranger@example.com' })];

    const { runId } = await dryRun(w);
    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ imported: 2, failed: 0 });

    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);

    // The created one is unlinked: no password, unverified, and marked with the
    // run that made it so the end-user page can explain the half-finished look.
    const created = await prisma.endUser.findFirstOrThrow({
      where: { applicationId: w.applicationId, email: 'stranger@example.com' },
    });
    expect(created.passwordHash).toBeNull();
    expect(created.emailVerified).toBe(false);
    expect(created.metadata).toMatchObject({ importRunId: runId });

    // A double-click must not import twice.
    const again = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('IMPORT_RUN_NOT_READY');
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);
  });

  it('the apply is refused without the typed confirmation', async () => {
    const w = await world();
    feed.items = [row({ email: 'a@example.com' })];
    const { runId } = await dryRun(w);

    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: 'not-the-slug' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IMPORT_CONFIRM_MISMATCH');
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(0);
  });

  // ---------- idempotency of the source ----------

  it('a provider returning the same subscription twice imports it once', async () => {
    const w = await world();
    const dup = row({ email: 'dup@example.com' });
    feed.items = [dup, dup];

    const { items } = await dryRun(w);
    expect(items.length).toBe(1);
  });

  // ---------- access control ----------

  it('a MEMBER cannot start or apply an import', async () => {
    const w = await world();
    const outsider = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `outsider-${w.slug}@example.com`,
        password: 'pw-one-two-three',
        workspaceName: 'Outsider Co',
      },
    });
    const token = (outsider.json().data as { accessToken: string }).accessToken;
    const res = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports`,
      headers: { authorization: `Bearer ${token}` },
      payload: { provider: 'external' },
    });
    expect(res.statusCode).toBe(404);
  });

  // ---------- what the review found the apply path was dropping ----------

  it('honours the term the provider reported instead of importing it open-ended', async () => {
    const w = await world();
    // The whole reason this matters is at the OTHER end of the lifecycle: with
    // no period, `cancelEffect` has nothing to schedule against, so cancelling
    // an imported subscription stops access on the spot rather than at period
    // end, and `docs/external-billing-pull.md` promises the opposite.
    const periodEnd = new Date(Date.now() + 90 * 24 * 3600 * 1000);
    const cancelAt = new Date(Date.now() + 60 * 24 * 3600 * 1000);
    feed.items = [
      row({
        email: 'termed@example.com',
        currentPeriodEnd: periodEnd.toISOString(),
        cancelAt: cancelAt.toISOString(),
        startedAt: '2026-01-14T09:00:00.000Z',
        metadata: { tier: 'enterprise' },
      }),
    ];
    const { runId } = await dryRun(w);
    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(applied.statusCode).toBe(200);

    const sub = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: w.applicationId },
    });
    expect(sub.currentPeriodEnd).not.toBeNull();
    expect(sub.currentPeriodEnd!.toISOString()).toBe(periodEnd.toISOString());
    expect(sub.cancelAt!.toISOString()).toBe(cancelAt.toISOString());
    expect(sub.metadata).toMatchObject({
      import: {
        providerStartedAt: '2026-01-14T09:00:00.000Z',
        providerMetadata: { tier: 'enterprise' },
      },
    });
  });

  it('drops a period end that is already in the past rather than importing an expired subscription', async () => {
    const w = await world();
    feed.items = [
      row({ email: 'stale@example.com', currentPeriodEnd: '2020-01-01T00:00:00.000Z' }),
    ];
    const { runId } = await dryRun(w);
    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    // One bad date must not fail a row that has a perfectly good subscriber:
    // open-ended is the safe reading of "we could not tell".
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ imported: 1, failed: 0 });
    const sub = await prisma.subscription.findFirstOrThrow({
      where: { applicationId: w.applicationId },
    });
    expect(sub.currentPeriodEnd).toBeNull();
  });

  it('maps a provider plan ref off the NESTED metadata a plan registration writes', async () => {
    const w = await world();
    // `ensurePlanRegistered` writes `metadata.stripe = { priceId }`, and
    // stripe-real.ts reads it back that way. A fallback that looked for a flat
    // top-level key matched nothing anybody writes, so only exact slug
    // equality ever mapped and every other row was `skip_no_plan`.
    await prisma.plan.updateMany({
      where: { applicationId: w.applicationId, slug: 'pro' },
      data: { metadata: { stripe: { priceId: 'price_1QabcdEFGH' } } },
    });
    feed.items = [row({ email: 'mapped@example.com', planRef: 'price_1QabcdEFGH' })];
    const { items } = await dryRun(w);
    expect(items[0]!.outcome).toBe('create');
  });

  it('two rows for one address create ONE end-user, not a failed row', async () => {
    const w = await world();
    // A customer with two provider subscriptions is ordinary. The preview
    // resolved both against an end-user that did not exist yet, so both are
    // `create`, and the second `endUser.create` hits the unique index.
    feed.items = [
      row({ email: 'twice@example.com' }),
      row({ email: 'twice@example.com', planRef: 'pro' }),
    ];
    const { runId, items } = await dryRun(w);
    expect(items.every((i) => i.outcome === 'create')).toBe(true);

    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data.failed).toBe(0);
    expect(
      await prisma.endUser.count({
        where: { applicationId: w.applicationId, email: 'twice@example.com' },
      }),
    ).toBe(1);
    // The second grant is idempotent on (application, end-user, plan), so one
    // subscription, not two, and not an error.
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(1);
  });

  it('two operators applying the same preview at once import it once', async () => {
    const w = await world();
    feed.items = [
      row({ email: 'race-a@example.com' }),
      row({ email: 'race-b@example.com' }),
    ];
    const { runId } = await dryRun(w);
    const apply = () =>
      inject({
        method: 'POST',
        url: `${base(w)}/subscription-imports/${runId}/apply`,
        headers: auth(w),
        payload: { confirm: w.slug },
      });
    // What this pins is the OUTCOME: one caller wins, nothing is imported
    // twice, and `subscription.activated` is announced once per row.
    //
    // It does not isolate the conditional claim on its own. In-process
    // `inject` almost always lets the first caller finish its status write
    // before the second reads, so the sequential `status !== 'ready'` check
    // catches this ordering by itself, neutering the claim leaves this test
    // green. The claim exists for the interleaving that check cannot cover
    // (both callers reading `ready` before either writes), which is real
    // against a shared database and not reproducible here.
    const [a, b] = await Promise.all([apply(), apply()]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);
  });

  it('a trialing row goes through the trial ledger: TRIALING once, ACTIVE for a buyer who already had one', async () => {
    const w = await world();
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: w.applicationId, slug: 'pro' } });
    // A buyer who trialled here before, as the checkout ledger records it.
    const used = await makeEndUser(w, 'used@example.com');
    await prisma.trialRedemption.create({
      data: {
        applicationId: w.applicationId,
        subjectKey: `user:${used}`,
        endUserId: used,
        planId: plan.id,
        status: 'CONSUMED',
        checkoutSessionId: 'cs_earlier',
        trialDays: 14,
        startedAt: new Date(Date.now() - 40 * 86_400_000),
        endsAt: new Date(Date.now() - 26 * 86_400_000),
      },
    });

    const trialEnd = new Date(Date.now() + 10 * 86_400_000);
    feed.items = [
      row({ externalId: 'sub_fresh', email: 'fresh@example.com', status: 'trialing', trialEndsAt: trialEnd.toISOString() }),
      row({ externalId: 'sub_used', email: 'used@example.com', status: 'trialing', trialEndsAt: trialEnd.toISOString() }),
      // A trialing row with no clock to run is imported live: nothing would
      // ever convert it otherwise.
      row({ externalId: 'sub_undated', email: 'undated@example.com', status: 'trialing' }),
    ];
    const { runId } = await dryRun(w);
    const applied = await inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().data).toMatchObject({ imported: 3, failed: 0 });

    const bySub = async (providerSubId: string) =>
      prisma.subscription.findUniqueOrThrow({
        where: { applicationId_providerSubId: { applicationId: w.applicationId, providerSubId } },
      });

    const fresh = await bySub('sub_fresh');
    expect(fresh.status).toBe('TRIALING');
    expect(fresh.trialEndsAt?.toISOString()).toBe(trialEnd.toISOString());
    const freshLedger = await prisma.trialRedemption.findMany({
      where: { applicationId: w.applicationId, endUserId: fresh.endUserId },
    });
    expect(freshLedger).toHaveLength(1);
    expect(freshLedger[0]).toMatchObject({
      status: 'CONSUMED',
      subscriptionId: fresh.id,
      checkoutSessionId: `external:sub_fresh:${runId}`,
    });

    const reused = await bySub('sub_used');
    expect(reused.status).toBe('ACTIVE');
    expect(reused.trialEndsAt).toBeNull();
    expect((reused.metadata as { refusedTrials?: Array<{ reason: string }> }).refusedTrials).toEqual([
      expect.objectContaining({ reason: 'already_used' }),
    ]);
    // The earlier redemption is the only one this buyer has.
    expect(await prisma.trialRedemption.count({ where: { applicationId: w.applicationId, endUserId: used } })).toBe(1);

    expect((await bySub('sub_undated')).status).toBe('ACTIVE');

    // The operator is told which row lost its trial, where the seat
    // warnings already go.
    const run = await prisma.subscriptionImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.error).toContain('sub_used');
    expect(run.error).not.toContain('sub_fresh');
  });

  // ---------- an apply the process died in the middle of ----------
  //
  // An apply runs inside one HTTP request, so a deploy, crash or OOM mid-run
  // leaves the run `applying` with nothing behind it. These put a run into the
  // state such a crash leaves (the DB is all a dead process leaves behind) and
  // check what a later apply does with it.

  const applyRun = (w: World, runId: string) =>
    inject({
      method: 'POST',
      url: `${base(w)}/subscription-imports/${runId}/apply`,
      headers: auth(w),
      payload: { confirm: w.slug },
    });

  /** Leave the run as a process that claimed it `ageMs` ago and then died. */
  async function abandon(runId: string, ageMs: number): Promise<void> {
    await prisma.subscriptionImportRun.update({
      where: { id: runId },
      data: {
        status: 'applying',
        mode: 'dry_run',
        completedAt: null,
        heartbeatAt: new Date(Date.now() - ageMs),
        applyLease: 'the-process-that-died',
      },
    });
  }

  it('an interrupted apply is reclaimed and resumes without granting anything twice', async () => {
    const w = await world();
    const trialEndsAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const cancelAt = new Date(Date.now() + 60 * 86_400_000);
    const trialing = (externalId: string) =>
      row({
        externalId,
        email: `${externalId}@example.com`,
        status: 'trialing',
        trialEndsAt,
        cancelAt: cancelAt.toISOString(),
      });
    feed.items = [trialing('sub_a'), trialing('sub_b'), trialing('sub_c')];
    const { runId } = await dryRun(w);

    // The first apply gets through A and B and never reaches C.
    await prisma.subscriptionImportItem.updateMany({
      where: { runId, externalId: 'sub_c' },
      data: { outcome: 'skip_invalid' },
    });
    const first = await applyRun(w, runId);
    expect(first.statusCode).toBe(200);

    // What the crash leaves: A granted and marked, B granted but the process
    // died before marking it, C untouched, and the run still `applying`.
    await prisma.subscriptionImportItem.updateMany({
      where: { runId, externalId: 'sub_b' },
      data: { subscriptionId: null },
    });
    await prisma.subscriptionImportItem.updateMany({
      where: { runId, externalId: 'sub_c' },
      data: { outcome: 'create' },
    });
    await abandon(runId, 10 * 60_000);
    const before = await prisma.subscription.findMany({
      where: { applicationId: w.applicationId },
      select: { id: true, providerSubId: true },
    });
    expect(before).toHaveLength(2);

    // The run reads as interrupted, which is what puts Resume in the panel.
    const read = await inject({ method: 'GET', url: `${base(w)}/subscription-imports/${runId}`, headers: auth(w) });
    expect(read.json().data.run).toMatchObject({ status: 'applying', stale: true });
    const list = await inject({ method: 'GET', url: `${base(w)}/subscription-imports`, headers: auth(w) });
    expect(list.json().data.items[0]).toMatchObject({ id: runId, stale: true });

    const resumed = await applyRun(w, runId);
    expect(resumed.statusCode).toBe(200);
    // The whole run, not only the row this pass happened to finish.
    expect(resumed.json().data).toMatchObject({ imported: 3, failed: 0 });

    const subs = await prisma.subscription.findMany({ where: { applicationId: w.applicationId } });
    expect(subs).toHaveLength(3);
    // A and B are the same rows as before, not replacements.
    for (const b of before) {
      expect(subs.find((s) => s.providerSubId === b.providerSubId)?.id).toBe(b.id);
    }
    for (const s of subs) {
      expect(s.status).toBe('TRIALING');
      expect(s.cancelAt?.toISOString()).toBe(cancelAt.toISOString());
      // One trial per buyer: the resumed grant spent no second ledger slot.
      const ledger = await prisma.trialRedemption.findMany({
        where: { applicationId: w.applicationId, endUserId: s.endUserId },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        subscriptionId: s.id,
        checkoutSessionId: `external:${s.providerSubId}:${runId}`,
      });
    }

    const items = await prisma.subscriptionImportItem.findMany({ where: { runId } });
    for (const i of items) {
      expect(i.subscriptionId).toBe(subs.find((s) => s.providerSubId === i.externalId)!.id);
    }
    const run = await prisma.subscriptionImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('applied');
    expect(run.applyLease).not.toBe('the-process-that-died');
  });

  it('a run still applying with a fresh heartbeat refuses a second apply', async () => {
    const w = await world();
    feed.items = [row({ email: 'live@example.com' })];
    const { runId } = await dryRun(w);
    await abandon(runId, 30_000);

    const res = await applyRun(w, runId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('IMPORT_RUN_NOT_READY');

    const read = await inject({ method: 'GET', url: `${base(w)}/subscription-imports/${runId}`, headers: auth(w) });
    expect(read.json().data.run).toMatchObject({ status: 'applying', stale: false });
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(0);
    const run = await prisma.subscriptionImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'applying', applyLease: 'the-process-that-died' });
  });

  it('eight applies reclaiming one interrupted run at once: exactly one proceeds', async () => {
    const w = await world();
    feed.items = [
      row({ email: 'reclaim-a@example.com' }),
      row({ email: 'reclaim-b@example.com' }),
    ];
    const { runId } = await dryRun(w);
    await abandon(runId, 10 * 60_000);

    // Eight, not two: two in-process requests rarely overlap in Postgres, and
    // a guard that was never contended proves nothing.
    //
    // Even eight do not overlap on their own: the first winner writes a fresh
    // heartbeat before the others read the run, so the status pre-check turns
    // them away and the conditional claim is never contended. So the run row
    // is held FOR UPDATE while they start. Their reads are not blocked (they
    // all see the run as abandoned); their claims are, and the lock is only
    // released once Postgres shows all eight waiting on it. From there the
    // claim is the ONLY thing deciding who proceeds.
    const RACERS = 8;
    let racing!: Promise<Awaited<ReturnType<typeof applyRun>>[]>;
    let waiting = 0;
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "subscription_import_runs" WHERE "id" = ${runId} FOR UPDATE`;
        racing = Promise.all(Array.from({ length: RACERS }, () => applyRun(w, runId)));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`
            SELECT count(*)::bigint AS "n" FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock'
               AND query LIKE '%UPDATE "subscription_import_runs"%'`;
          waiting = Number(row!.n);
          if (waiting >= RACERS) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      { timeout: 20_000 },
    );
    const results = await racing;
    expect(waiting).toBe(RACERS);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    // Refused AT THE CLAIM, so none of them touched a row. The lease fence on
    // the terminal write would also leave a single 200, but only after every
    // claimer had worked through the run, which is the thing this prevents.
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.message).toBe('That run was already being applied.');
    }
    expect(await prisma.subscription.count({ where: { applicationId: w.applicationId } })).toBe(2);
  });

  it('cancelAt commits with the grant: a grant whose cancelAt cannot be written does not land', async () => {
    const w = await world();
    const cancelAt = new Date(Date.now() + 60 * 86_400_000);
    feed.items = [
      row({ externalId: 'sub_ok', email: 'ok@example.com', cancelAt: cancelAt.toISOString() }),
      row({ externalId: 'sub_boom', email: 'boom@example.com', cancelAt: cancelAt.toISOString() }),
    ];
    const { runId } = await dryRun(w);

    // Make the cancelAt write for one row fail in the database. If the grant
    // and its cancelAt were separate commits, that row would be left entitled
    // with no scheduled end.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_import_cancel_at() RETURNS trigger AS $$
      BEGIN
        IF NEW.cancel_at IS NOT NULL AND NEW.provider_sub_id = 'sub_boom' THEN
          RAISE EXCEPTION 'cancel_at refused by test trigger';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_refuse_import_cancel_at BEFORE INSERT OR UPDATE ON subscriptions ' +
        'FOR EACH ROW EXECUTE FUNCTION test_refuse_import_cancel_at()',
    );
    try {
      const applied = await applyRun(w, runId);
      expect(applied.statusCode, applied.body).toBe(200);
      expect(applied.json().data).toMatchObject({ imported: 1, failed: 1 });
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_refuse_import_cancel_at ON subscriptions');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_refuse_import_cancel_at()');
    }

    const subs = await prisma.subscription.findMany({ where: { applicationId: w.applicationId } });
    expect(subs.map((s) => s.providerSubId)).toEqual(['sub_ok']);
    // Wherever a grant landed, its cancelAt landed with it.
    for (const s of subs) expect(s.cancelAt?.toISOString()).toBe(cancelAt.toISOString());
    const boom = await prisma.subscriptionImportItem.findFirstOrThrow({
      where: { runId, externalId: 'sub_boom' },
    });
    expect(boom.outcome).toBe('error');
  });

});
