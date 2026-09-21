/**
 * A seat count that was SOLD must reach the licence (#488).
 *
 * `PATCH .../entitlement-overrides` with `{"LICENSE:<key>": 50}` returned 200,
 * echoed `quantity: 50` and emitted `subscription.entitlements_updated`, and
 * the licence went on refusing activations past the number it was issued with.
 * The buyer paid for fifty seats and had five, and nothing reported it.
 *
 * Three separate problems had to be held at once, and each has a test here:
 * the write path never provisions, one org-pooled licence is funded by several
 * subscriptions, and two LICENSE rows on one plan used to resolve to one
 * licence.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';

const PASSWORD = 'pw-one-two-three';

describe('a seat override reaches the licence', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await prisma.endUser.deleteMany({ where: { email: { contains: '@example.com' } } });
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `so-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'SO', slug: `so-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    // Minted for its side effect; the value itself is not read here.
    await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['billing:write'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  const makeEndUser = (email: string): Promise<string> =>
    app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email, password: PASSWORD },
      })
      .then((r) => (r.json().data as { id: string }).id);

  async function makeSeatsPlan(slug: string, seats: number, key?: string): Promise<string> {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: auth(),
      payload: { slug, name: slug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`,
      headers: auth(),
      payload: { kind: 'LICENSE', licenseKind: 'SEATS', quantity: seats, ...(key !== undefined && { key }) },
    });
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  const makeOrg = (ownerEndUserId: string, slug: string): Promise<string> =>
    app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: slug, slug, ownerEndUserId },
      })
      .then((r) => (r.json().data as { id: string }).id);

  const override = (subId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/subscriptions/${subId}/entitlement-overrides`,
      headers: auth(),
      payload: body,
    });

  // ------------------------------------------------------- the reported bug

  it('raising the seat count on a live subscription raises the licence ceiling', async () => {
    const planId = await makeSeatsPlan('team', 5);
    const ownerId = await makeEndUser(`owner-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, `acme-${Math.random().toString(36).slice(2, 7)}`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: ownerId, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    await entitlementsService.provision({ subscription: sub });

    const before = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, planId } });
    expect(before.seatsAllowed).toBe(5);

    const res = await override(sub.id, { 'LICENSE:': 50 });
    expect(res.statusCode).toBe(200);

    // THE assertion. This stayed at 5 while the response said 50.
    const after = await prisma.license.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.seatsAllowed).toBe(50);
    // Same licence, not a second one issued alongside it.
    expect(await prisma.license.count({ where: { applicationId: appId, planId } })).toBe(1);
  });

  it('a lowered ceiling does not revoke seats already in use', async () => {
    const planId = await makeSeatsPlan('team', 5);
    const ownerId = await makeEndUser(`own2-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(ownerId, `beta-${Math.random().toString(36).slice(2, 7)}`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: ownerId, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    await entitlementsService.provision({ subscription: sub });
    const licence = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, planId } });

    for (const fp of ['m1', 'm2', 'm3']) {
      await prisma.licenseActivation.create({
        data: { licenseId: licence.id, applicationId: appId, machineFingerprint: fp },
      });
    }

    expect((await override(sub.id, { 'LICENSE:': 2 })).statusCode).toBe(200);

    // Ceiling follows the sale...
    expect((await prisma.license.findUniqueOrThrow({ where: { id: licence.id } })).seatsAllowed).toBe(2);
    // ...but pulling a running machine's seat mid-period is not something a
    // quantity edit does silently. The NEXT activation is refused instead.
    expect(await prisma.licenseActivation.count({ where: { licenseId: licence.id } })).toBe(3);
  });

  // ----------------------------------------------- one pool, many subscriptions

  it("another owner's subscription cannot lower a ceiling negotiated on the first", async () => {
    // `Subscription` is unique on (application, end-user, plan), so two owners
    // can each hold a subscription on the same plan with the same beneficiary
    // org. Both fund ONE pooled licence. Writing "this subscription's quantity"
    // would let Bob's renewal reset Alice's negotiated 50 to the plan's 5.
    const planId = await makeSeatsPlan('team', 5);
    const alice = await makeEndUser(`alice-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const bob = await makeEndUser(`bob-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(alice, `gamma-${Math.random().toString(36).slice(2, 7)}`);

    const aliceSub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: alice, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    const bobSub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: bob, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    await entitlementsService.provision({ subscription: aliceSub });

    expect((await override(aliceSub.id, { 'LICENSE:': 50 })).statusCode).toBe(200);
    const licence = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, planId } });
    expect(licence.seatsAllowed).toBe(50);

    // Bob touches his own subscription. The pool is reconciled toward the MAX
    // across everything funding it, so Alice's 50 survives.
    expect((await override(bobSub.id, { 'LICENSE:': 10 })).statusCode).toBe(200);
    expect((await prisma.license.findUniqueOrThrow({ where: { id: licence.id } })).seatsAllowed).toBe(50);
  });

  it('a subscription that has ended stops funding the pool', async () => {
    const planId = await makeSeatsPlan('team', 5);
    const alice = await makeEndUser(`al2-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const bob = await makeEndUser(`bo2-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const orgId = await makeOrg(alice, `delta-${Math.random().toString(36).slice(2, 7)}`);

    const aliceSub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: alice, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    const bobSub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: bob, planId, beneficiaryOrgId: orgId, status: 'ACTIVE' },
    });
    await entitlementsService.provision({ subscription: aliceSub });
    await override(aliceSub.id, { 'LICENSE:': 50 });

    // Alice churns. Only entitling subscriptions fund a pool, so the ceiling
    // falls back to what Bob is actually paying for.
    await prisma.subscription.update({ where: { id: aliceSub.id }, data: { status: 'CANCELED' } });
    expect((await override(bobSub.id, { 'LICENSE:': 10 })).statusCode).toBe(200);

    const licence = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, planId } });
    expect(licence.seatsAllowed).toBe(10);
  });

  // ------------------------------------------- two LICENSE rows on one plan

  it('two LICENSE entitlements on one plan get their own licences and their own seats', async () => {
    // `@@unique([planId, kind, key])` permits LICENSE:a and LICENSE:b, and the
    // PUT route accepts a key. Both used to resolve to the same licence row:
    // provision hit each in turn and the second overwrote the first.
    const planId = await makeSeatsPlan('dual', 5, 'a');
    await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/dual/entitlements`,
      headers: auth(),
      payload: { kind: 'LICENSE', licenseKind: 'SEATS', quantity: 7, key: 'b' },
    });

    const ownerId = await makeEndUser(`dual-${Math.random().toString(36).slice(2, 7)}@example.com`);
    const sub = await prisma.subscription.create({
      data: { applicationId: appId, endUserId: ownerId, planId, status: 'ACTIVE' },
    });
    await entitlementsService.provision({ subscription: sub });

    const licences = await prisma.license.findMany({
      where: { applicationId: appId, planId },
      orderBy: { entitlementKey: 'asc' },
    });
    expect(licences.map((l) => [l.entitlementKey, l.seatsAllowed])).toEqual([
      ['a', 5],
      ['b', 7],
    ]);

    // An override on one does not touch the other.
    expect((await override(sub.id, { 'LICENSE:a': 40 })).statusCode).toBe(200);
    const after = await prisma.license.findMany({
      where: { applicationId: appId, planId },
      orderBy: { entitlementKey: 'asc' },
    });
    expect(after.map((l) => [l.entitlementKey, l.seatsAllowed])).toEqual([
      ['a', 40],
      ['b', 7],
    ]);
  });
});
