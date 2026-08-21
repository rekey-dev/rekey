/**
 * The write path for `Subscription.entitlementOverrides`.
 * Spec: docs/specs/entitlement-overrides.md
 *
 * The property these tests defend, stated once:
 *
 *   The API must refuse anything the RESOLVER would silently ignore.
 *
 * `applyOverrides` drops a non-finite quantity, never matches a malformed key,
 * and only ADDs rows for `FEATURE:`. Every one of those is a value an operator
 * can store, believe they sold, and never deliver — with nothing reporting a
 * problem. So the interesting assertions here are not the happy paths; they are
 * the refusals, each standing in for a support ticket that reads "I set it and
 * nothing happened".
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

const PASSWORD = 'pw-one-two-three';

interface Resolved {
  kind: string;
  key: string | null;
  value: string | null;
  quantity: number | null;
}

describe('Per-subscription entitlement overrides', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    n += 1;
    const slug = `ovr${n}-${Math.random().toString(36).slice(2, 7)}`;
    const su = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: `${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
    });
    token = (su.json().data as { accessToken: string }).accessToken;
    const ac = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'OvrApp', slug },
    });
    appId = (ac.json().data as { id: string }).id;
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  /** A plan with an optional entitlement, an end-user, and a live subscription. */
  async function subscribe(planEntitlement?: Record<string, unknown>): Promise<string> {
    const planSlug = `plan-${Math.random().toString(36).slice(2, 7)}`;
    const pr = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: planSlug, name: planSlug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    const planId = (pr.json().data as { id: string }).id;

    if (planEntitlement) {
      const er = await app.inject({
        method: 'PUT',
        url: `/api/v1/tenant/applications/${appId}/plans/${planSlug}/entitlements`,
        headers: auth(),
        payload: planEntitlement,
      });
      if (er.statusCode !== 200 && er.statusCode !== 201) {
        throw new Error(`putEntitlement ${er.statusCode}: ${er.body}`);
      }
    }

    const eu = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email: `sub-${Math.random().toString(36).slice(2, 7)}@example.com`, password: PASSWORD },
    });
    const euId = (eu.json().data as { id: string }).id;

    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: euId, planId, status: 'ACTIVE', provider: 'stripe' },
    });
    return sub.id;
  }

  const patch = (subId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${subId}/entitlement-overrides`,
      headers: auth(),
      payload: body,
    });

  const resolvedOf = (res: { json: () => unknown }): Resolved[] =>
    (res.json() as { data: { entitlements: Resolved[] } }).data.entitlements;

  const find = (ents: Resolved[], kind: string, key: string): Resolved | undefined =>
    ents.find((e) => e.kind === kind && e.key === key);

  /**
   * A quantity an operator can store today, believe they sold, and never
   * deliver — the exact property this file's header says it defends, on the
   * three kinds that carry money.
   *
   * The plan-level validator already refuses every shape below
   * (`entitlementsService.validate`): CREDIT needs a positive quantity, a SEATS
   * licence needs at least one seat, and a USAGE row with no included units
   * must carry a price, "because an entitlement granting no units and costing
   * nothing is indistinguishable from not having one". The override path
   * reaches the same column and applied none of it.
   */
  describe('quantity bounds', () => {
    it('refuses a USAGE quota of 0 on an unpriced meter, which would UNCAP it', async () => {
      // The severe one. `includedQuotaFor` only sets `capped` when quantity > 0
      // or the row carries a price. Override an unpriced hard cap to 0 — which
      // reads as "no free units" — and it has neither, so the function returns
      // null, which every caller reads as UNMETERED. The operator tightens the
      // plan and removes the limit.
      const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });
      const res = await patch(subId, { 'USAGE:api_calls': 0 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ENTITLEMENT_OVERRIDE_INVALID');
      expect(await stored(subId)).toBeNull();
    });

    it('refuses a negative quantity', async () => {
      const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });
      expect((await patch(subId, { 'USAGE:api_calls': -5 })).statusCode).toBe(400);
    });

    it('refuses a fractional quantity that the Int column cannot hold', async () => {
      // Stored happily, then thrown by Prisma inside `provision` at the NEXT
      // renewal — so the failure surfaces as a retrying 500 on the renewal
      // webhook, weeks later, nowhere near the operator who typed it.
      const subId = await subscribe({ kind: 'CREDIT', quantity: 500 });
      expect((await patch(subId, { 'CREDIT:': 1.5 })).statusCode).toBe(400);
    });

    it('refuses a quantity beyond the Int column', async () => {
      const subId = await subscribe({ kind: 'CREDIT', quantity: 500 });
      expect((await patch(subId, { 'CREDIT:': 1e12 })).statusCode).toBe(400);
    });

    it('refuses a CREDIT quantity of 0, which silently removes the grant', async () => {
      // `provision` grants only when `quantity > 0`, so 0 does not mean "no
      // credits this period" — it means the grant never runs and nothing says so.
      const subId = await subscribe({ kind: 'CREDIT', quantity: 500 });
      expect((await patch(subId, { 'CREDIT:': 0 })).statusCode).toBe(400);
    });

    it('refuses a SEATS licence with no seats', async () => {
      const subId = await subscribe({ kind: 'LICENSE', licenseKind: 'SEATS', quantity: 5 });
      expect((await patch(subId, { 'LICENSE:': 0 })).statusCode).toBe(400);
    });

    it('still accepts a legitimate raise', async () => {
      // The guard must not close the door it exists to keep open.
      const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });
      const res = await patch(subId, { 'USAGE:api_calls': 50_000 });
      expect(res.statusCode).toBe(200);
      expect(find(resolvedOf(res), 'USAGE', 'api_calls')?.quantity).toBe(50_000);
    });

    it('accepts 0 on a PRICED USAGE row, where it does mean "charge from unit one"', async () => {
      const subId = await subscribe({
        kind: 'USAGE',
        key: 'api_calls',
        quantity: 1000,
        creditsPerUnit: 2,
      });
      expect((await patch(subId, { 'USAGE:api_calls': 0 })).statusCode).toBe(200);
    });
  });

  const stored = async (subId: string): Promise<Record<string, unknown> | null> =>
    (await prisma.subscription.findUniqueOrThrow({ where: { id: subId } }))
      .entitlementOverrides as Record<string, unknown> | null;

  /**
   * Subscribe an endpoint to the new event, asserting the create SUCCEEDED.
   *
   * Not a convenience. The first version of these tests called inject and
   * ignored the status, and the negative test ("emits nothing") passed
   * vacuously because the endpoint had never been created at all — the event
   * name was missing from `KNOWN_WEBHOOK_EVENTS`, so the `events` enum refused
   * it with a 400 nobody read. A negative assertion is only worth anything if
   * the positive setup is known to have worked.
   */
  async function subscribeEndpoint(): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/webhooks`,
      headers: auth(),
      payload: {
        url: 'https://example.com/hook',
        events: ['subscription.entitlements_updated'],
      },
    });
    if (res.statusCode !== 201 && res.statusCode !== 200) {
      throw new Error(`webhook endpoint create failed ${res.statusCode}: ${res.body}`);
    }
  }

  const deliveriesFor = (subId: string) =>
    prisma.webhookDelivery.findMany({
      where: { applicationId: appId, eventType: 'subscription.entitlements_updated' },
    }).then((rows) => rows.filter((r) => JSON.stringify(r.payload).includes(subId)));

  // ------------------------------------------------------------- happy paths

  it('ADDS a FEATURE the plan does not carry — the documented bespoke-deal case', async () => {
    const subId = await subscribe();

    const res = await patch(subId, { 'FEATURE:max_production_apps': 5 });
    expect(res.statusCode).toBe(200);

    const row = find(resolvedOf(res), 'FEATURE', 'max_production_apps');
    expect(row?.value).toBe('5');
  });

  it('overrides a quantity on an entitlement the plan does carry', async () => {
    const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });

    const res = await patch(subId, { 'USAGE:api_calls': 1_000_000 });
    expect(res.statusCode).toBe(200);
    expect(find(resolvedOf(res), 'USAGE', 'api_calls')?.quantity).toBe(1_000_000);
  });

  it('is SPARSE — an untouched key survives a later write', async () => {
    const subId = await subscribe();
    await patch(subId, { 'FEATURE:a': 'one' });
    const res = await patch(subId, { 'FEATURE:b': 'two' });

    // The whole point of PATCH here: raising one allowance must not require
    // restating a deal the caller did not come to change.
    const ents = resolvedOf(res);
    expect(find(ents, 'FEATURE', 'a')?.value).toBe('one');
    expect(find(ents, 'FEATURE', 'b')?.value).toBe('two');
  });

  it('returns the RESOLVED entitlements, not the stored blob', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });
    const res = await patch(subId, { 'FEATURE:seats': 10 });

    // The operator asked what the customer now gets. The blob would make them
    // do the merge themselves, using rules they cannot see.
    const ents = resolvedOf(res);
    expect(find(ents, 'FEATURE', 'seats')?.value).toBe('10');
    expect(res.json()).not.toHaveProperty('data.entitlementOverrides');
  });

  // ------------------------------------------------------------------ removal

  it('null REMOVES an override and reverts to the plan value', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });
    await patch(subId, { 'FEATURE:seats': 99 });

    const res = await patch(subId, { 'FEATURE:seats': null });
    expect(res.statusCode).toBe(200);
    expect(find(resolvedOf(res), 'FEATURE', 'seats')?.value).toBe('3');
  });

  it('never STORES a null — the resolver would turn it into the string "null"', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });
    await patch(subId, { 'FEATURE:seats': null });

    // `applyOverrides` skips only `undefined`. A stored null reaches String(o)
    // and materialises the literal "null" as the entitlement value. Making the
    // write path delete instead of store puts that out of reach entirely.
    const blob = await stored(subId);
    expect(blob === null || !('FEATURE:seats' in blob)).toBe(true);
  });

  it('removing the LAST override returns the row to null, not an empty object', async () => {
    const subId = await subscribe();
    await patch(subId, { 'FEATURE:x': 1 });
    await patch(subId, { 'FEATURE:x': null });

    // A `{}` tombstone reads as "someone configured something here" to the next
    // person looking at the row. Nobody did.
    expect(await stored(subId)).toBeNull();
  });

  it('removing an override that was never set is a no-op, not an error', async () => {
    const subId = await subscribe();
    const res = await patch(subId, { 'FEATURE:never_set': null });
    expect(res.statusCode).toBe(200);
  });

  // ----------------------------------------------------------- the refusals

  it('REFUSES a quantity-kind key the plan does not carry', async () => {
    const subId = await subscribe();

    // applyOverrides only ADDs FEATURE rows, so this would be stored and then
    // ignored forever: the operator believes they sold a million API calls.
    const res = await patch(subId, { 'USAGE:api_calls': 1_000_000 });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { code: string }).code).toBe('ENTITLEMENT_OVERRIDE_INVALID');
    expect((res.json().error as { fix: string }).fix).toContain('add it to the plan first');

    expect(await stored(subId)).toBeNull();
  });

  it('REFUSES a non-numeric quantity', async () => {
    const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });

    // Number('lots') is NaN, which applyOverrides discards — leaving the plan
    // quantity in force with nothing reporting that the override did nothing.
    const res = await patch(subId, { 'USAGE:api_calls': 'lots' });
    expect(res.statusCode).toBe(400);
    expect(await stored(subId)).toBeNull();
  });

  it('REFUSES a boolean quantity, which would silently become 0 or 1', async () => {
    const subId = await subscribe({ kind: 'USAGE', key: 'api_calls', quantity: 1000 });
    const res = await patch(subId, { 'USAGE:api_calls': true });
    expect(res.statusCode).toBe(400);
  });

  it('REFUSES a malformed key', async () => {
    const subId = await subscribe();
    // `FEATURE:` is in this list even though an empty key half is legal for a
    // LEGACY plan's synthesized row: the resolver's ADD path skips an empty
    // feature key, so on a plan that does not already carry one it is exactly
    // the silent no-op these rules exist to refuse.
    for (const key of ['max_production_apps', 'FEATURES:x', 'FEATURE:', 'FEATURE:has space']) {
      const res = await patch(subId, { [key]: 1 });
      expect(res.statusCode, `key ${key} should be refused`).toBe(400);
    }
    expect(await stored(subId)).toBeNull();
  });

  it('REFUSES an empty body rather than answering 200 to a caller bug', async () => {
    const subId = await subscribe();
    expect((await patch(subId, {})).statusCode).toBe(400);
  });

  it('refuses the whole patch when ONE key is bad — no partial application', async () => {
    const subId = await subscribe();

    const res = await patch(subId, { 'FEATURE:good': 1, 'USAGE:not_on_plan': 5 });
    expect(res.statusCode).toBe(400);

    // The valid half must not have landed. A partially-applied deal is worse
    // than a refused one: the operator sees an error and reasonably assumes
    // nothing changed.
    expect(await stored(subId)).toBeNull();
  });

  // ------------------------- refusals that protect the READER's assumptions

  it('REFUSES a value the plan row\'s valueType cannot carry (BOOL)', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'beta', valueType: 'BOOL', value: 'false' });

    // `applyOverrides` replaces only `value` and keeps the plan's valueType, and
    // `parseFeatureValue` treats ONLY the exact string "true" as true. So "yes"
    // would be stored, announced, and read back as FALSE — the operator turns a
    // flag on and turns it off.
    const res = await patch(subId, { 'FEATURE:beta': 'yes' });
    expect(res.statusCode).toBe(400);
    expect((res.json().error as { message: string }).message).toContain('BOOL');
    expect(await stored(subId)).toBeNull();

    // A real boolean is fine.
    expect((await patch(subId, { 'FEATURE:beta': true })).statusCode).toBe(200);
  });

  it('REFUSES a value the plan row\'s valueType cannot carry (INT)', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });

    // Number(true) is 1 rather than an error, so a boolean would silently cap
    // the customer at one seat.
    expect((await patch(subId, { 'FEATURE:seats': true })).statusCode).toBe(400);
    // A fractional value survives here but is typed STRING when the same key is
    // ADDED, which downstream reports as an ABSENT allowance rather than a bad one.
    expect((await patch(subId, { 'FEATURE:seats': 2.5 })).statusCode).toBe(400);
    expect((await patch(subId, { 'FEATURE:seats': 10 })).statusCode).toBe(200);
  });

  it('REFUSES an override on a subscription that grants nothing', async () => {
    const subId = await subscribe();
    await prisma.subscription.update({ where: { id: subId }, data: { status: 'CANCELED' } });

    // The worst case this closes: `resolveForSubscription` does not gate on
    // status, so a canceled subscription resolves its full paid entitlement set
    // and would announce it. A consumer projecting entitlements has no status to
    // check, and would write the paid ceiling back onto a churned customer with
    // nothing ever emitting again to remove it.
    const res = await patch(subId, { 'FEATURE:max_production_apps': 7 });
    expect(res.statusCode).toBe(409);
    expect((res.json().error as { code: string }).code).toBe('SUBSCRIPTION_NOT_ENTITLING');
    expect(await deliveriesFor(subId)).toHaveLength(0);
  });

  it('REFUSES a blob that would grow past the stored ceiling', async () => {
    const subId = await subscribe();

    // Measured post-merge, because the merge is additive: a stream of small
    // patches is how you would grow this without any one request looking large.
    const res = await patch(subId, { 'FEATURE:huge': 'x'.repeat(9000) });
    expect(res.statusCode).toBe(400);
    expect(await stored(subId)).toBeNull();
  });

  it('can override a LEGACY plan whose synthesized entitlement has an empty key', async () => {
    // A plan with `kind: CREDIT` and no explicit rows resolves through
    // `synthesizeLegacy`, which emits `key: ''` — so `"CREDIT:"` is the ONLY key
    // that can reach it. Requiring a non-empty key refused exactly the form that
    // works, and said it "never matches an entitlement", which was backwards.
    const planSlug = `legacy-${Math.random().toString(36).slice(2, 7)}`;
    const pr = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug: planSlug, name: planSlug, amount: 0, kind: 'CREDIT', creditsAmount: 100 },
    });
    const planId = (pr.json().data as { id: string }).id;
    const eu = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users`,
      headers: auth(),
      payload: { email: `leg-${Math.random().toString(36).slice(2, 7)}@example.com`, password: PASSWORD },
    });
    const sub = await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: (eu.json().data as { id: string }).id,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
      },
    });

    const res = await patch(sub.id, { 'CREDIT:': 500 });
    expect(res.statusCode).toBe(200);
    expect(resolvedOf(res).find((e) => e.kind === 'CREDIT')?.quantity).toBe(500);
  });

  // ------------------------------------------------------------ announcement

  it('emits subscription.entitlements_updated with the MERGED entitlements', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });
    await subscribeEndpoint();

    const res = await patch(subId, { 'FEATURE:seats': 10 });
    expect((res.json() as { data: { changed: boolean } }).data.changed).toBe(true);

    const rows = await deliveriesFor(subId);
    expect(rows).toHaveLength(1);

    // The payload must carry the MERGED value. A consumer projecting
    // entitlements onto its own state reads this and nothing else; shipping the
    // plan's raw 3 here would have it enforce the deal we just replaced.
    const payload = JSON.stringify(rows[0]!.payload);
    expect(payload).toContain('"seats"');
    expect(payload).toContain('"10"');
  });

  it('emits NOTHING when the write changes no entitlement', async () => {
    const subId = await subscribe({ kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '3' });
    await subscribeEndpoint();

    // Overriding a key to the value the plan already grants resolves to the
    // same entitlements. Announcing it would bill every consumer for work with
    // no news in it, and "entitlements_updated" would stop meaning that they did.
    const res = await patch(subId, { 'FEATURE:seats': 3 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { changed: boolean } }).data.changed).toBe(false);
    expect(await deliveriesFor(subId)).toHaveLength(0);
  });

  // ------------------------------------------------------------------ access

  it('404s a subscription that belongs to a different application', async () => {
    const subId = await subscribe();
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: auth(),
      payload: { name: 'Other', slug: `other-${Math.random().toString(36).slice(2, 7)}` },
    });
    const otherAppId = (other.json().data as { id: string }).id;

    // Same workspace, wrong application. The scope lives in the query, not in
    // a check after the fact, because a subscription id is a cuid an operator
    // could hold from elsewhere.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${otherAppId}/subscriptions/${subId}/entitlement-overrides`,
      headers: auth(),
      payload: { 'FEATURE:x': 1 },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json().error as { code: string }).code).toBe('SUBSCRIPTION_NOT_FOUND');
  });
});
