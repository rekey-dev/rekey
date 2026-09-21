/**
 * Operator subscription grant and cancel,
 * `POST /tenant/applications/:id/end-users/:euid/subscriptions[/:subId/cancel]`.
 *
 * The same service the super-admin route uses, reached by the workspace's own
 * OWNER/ADMIN. `subscription-grant.test.ts` already pins what a grant DOES
 * (entitlements materialised, `subscription.activated` emitted once, the period
 * anchored), and none of that is re-tested here, reusing the service unchanged
 * is the whole design. What is new, and what this file covers, is the door:
 *
 *   - who may open it (OWNER and ADMIN, and nobody below regardless of grant);
 *   - that idempotency survives the trip through the route, including the audit
 *     trail, which must not gain an entry per double-click;
 *   - that a subscription id is scoped to the end-user in the path, not merely
 *     to the Application;
 *   - and that a deployment can switch the whole thing off.
 *
 * The last one is the safety argument for opening this below the super-admin
 * key at all, so it is tested rather than asserted, see
 * `operator-subscription-grants-disabled.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

describe('operator subscription grants', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  let currentIp = '10.97.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function signUp(email: string, workspaceName: string): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { accessToken: string }).accessToken;
  }

  interface World {
    ownerToken: string;
    applicationId: string;
    planSlug: string;
    endUserId: string;
    tag: string;
  }

  async function world(): Promise<World> {
    currentIp = `10.97.${++n}.1`;
    const tag = `opgrant-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerToken = await signUp(`owner-${tag}@example.com`, 'Grant Co');

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Grant app', slug: tag },
    });
    expect(appRes.statusCode).toBe(201);
    const applicationId = (appRes.json().data as { id: string }).id;

    const planSlug = `${tag}-pro`;
    const plan = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/plans`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: {
        slug: planSlug,
        name: 'Pro',
        amount: 2900,
        kind: 'SUBSCRIPTION',
        interval: 'MONTH',
      },
    });
    expect(plan.statusCode).toBe(201);

    const eu = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: `buyer-${tag}@example.com`, password: 'pw-one-two-three' },
    });
    expect(eu.statusCode).toBe(201);

    return {
      ownerToken,
      applicationId,
      planSlug,
      endUserId: (eu.json().data as { id: string }).id,
      tag,
    };
  }

  /** A second operator in the same workspace at `role`, optionally granted on the app. */
  async function coworker(
    w: World,
    role: 'ADMIN' | 'MEMBER',
    grant?: 'APP_ADMIN' | 'APP_BILLING',
  ): Promise<string> {
    // Lowercased: end-user and operator emails are stored lowercased, so an
    // address carrying the uppercase role name never matches on the way back.
    const email = `mate-${w.tag}-${role.toLowerCase()}@example.com`;
    const theirToken = await signUp(email, 'Their Own Co');
    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${w.ownerToken}` },
      payload: { email, role },
    });
    expect(inv.statusCode).toBe(201);
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${theirToken}` },
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const token = (accept.json().data as { accessToken: string }).accessToken;

    if (grant) {
      const members = await inject({
        method: 'GET',
        url: '/api/v1/tenant/workspace/members',
        headers: { authorization: `Bearer ${w.ownerToken}` },
      });
      const membershipId = (
        members.json().data as { items: Array<{ membershipId: string; email: string }> }
      ).items.find((m) => m.email === email)!.membershipId;
      const g = await inject({
        method: 'PUT',
        url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
        headers: { authorization: `Bearer ${w.ownerToken}` },
        payload: { applicationId: w.applicationId, role: grant },
      });
      expect(g.statusCode).toBe(200);
    }
    return token;
  }

  function grant(w: World, token: string, payload: Record<string, unknown> = {}) {
    return inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.applicationId}/end-users/${w.endUserId}/subscriptions`,
      headers: { authorization: `Bearer ${token}` },
      payload: { planSlug: w.planSlug, ...payload },
    });
  }

  function cancel(
    w: World,
    token: string,
    subId: string,
    payload: Record<string, unknown> = {},
    euid = w.endUserId,
  ) {
    return inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.applicationId}/end-users/${euid}/subscriptions/${subId}/cancel`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
  }

  // ---------- the door ----------

  it('the OWNER can grant, and the subscription comes out ACTIVE', async () => {
    const w = await world();
    const res = await grant(w, w.ownerToken, { note: 'paid by bank transfer, INV-4012' });

    // 201 for a grant that activated, 200 for the idempotent no-op, the same
    // split the super-admin grant route uses. Two grant routes disagreeing
    // about which code means which would make both useless to a retrying
    // caller.
    expect(res.statusCode).toBe(201);
    const data = res.json().data as {
      subscription: { id: string; status: string; provider: string | null };
      activated: boolean;
    };
    expect(data.activated).toBe(true);
    expect(data.subscription.status).toBe('ACTIVE');
    // Provider-less on purpose: it is what lets the cancel paths end it locally.
    expect(data.subscription.provider).toBeNull();
  });

  it('an ADMIN can grant', async () => {
    const w = await world();
    const adminToken = await coworker(w, 'ADMIN');
    const res = await grant(w, adminToken);
    expect(res.statusCode).toBe(201);
    expect(res.json().data.activated).toBe(true);
  });

  it('a MEMBER cannot, even holding the strongest billing grant on the Application', async () => {
    // APP_BILLING is enough for every other billing write on this Application,
    // plans, coupons, manual credit grants. It is deliberately not enough to
    // mint entitlement out of nothing.
    const w = await world();
    const memberToken = await coworker(w, 'MEMBER', 'APP_BILLING');
    const res = await grant(w, memberToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- idempotency, including the audit trail ----------

  it('a second grant changes nothing and does not re-audit', async () => {
    const w = await world();
    const first = await grant(w, w.ownerToken);
    expect(first.statusCode).toBe(201);
    expect(first.json().data.activated).toBe(true);

    const second = await grant(w, w.ownerToken);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.activated).toBe(false);
    expect(second.json().data.subscription.id).toBe(first.json().data.subscription.id);

    const rows = await prisma.subscription.count({
      where: { applicationId: w.applicationId, endUserId: w.endUserId },
    });
    expect(rows).toBe(1);

    // The audit entry says "a sale happened". A no-op is not a second sale, and
    // an entry per double-click makes the trail unreadable exactly when
    // somebody is trying to reconstruct who granted what.
    const audits = await prisma.securityEvent.count({
      where: { applicationId: w.applicationId, type: 'app.subscription_granted' },
    });
    expect(audits).toBe(1);
  });

  it('records the note and the operator on the audit entry', async () => {
    const w = await world();
    await grant(w, w.ownerToken, { note: 'comped for the pilot' });

    // recordSecurityEvent is fire-and-forget (`void`), so the row is not
    // guaranteed to exist the instant the grant returns. Reading it with an
    // immediate findFirstOrThrow failed roughly one run in ten.
    const [audit] = await waitForSecurityEvents({ applicationId: w.applicationId, type: 'app.subscription_granted' });
    expect(audit).toBeDefined();
    expect(audit!.actorType).toBe('operator');
    expect(audit!.actorId).not.toBeNull();
    expect(audit!.metadata).toMatchObject({
      endUserId: w.endUserId,
      planSlug: w.planSlug,
      note: 'comped for the pilot',
      via: 'operator',
    });
  });

  // ---------- cancel ----------

  it('cancelling an OPEN-ENDED grant takes effect immediately, whatever was asked for', async () => {
    // A grant is open-ended unless a term is named, `resolvePeriodEnd` returns
    // null, deliberately, because nothing renews a grant and "comp this
    // account" must not quietly mean "for one month". The consequence is that
    // `cancelEffect` has no period to schedule against, so `atPeriodEnd: true`
    // is a request the row cannot honour.
    //
    // This is pinned because the panel has to SAY which of the two will happen
    // before the operator confirms, and an earlier draft of that copy promised
    // "keeps entitling until the end of the paid period" over a subscription
    // that lost access on the spot.
    const w = await world();
    const subId = (await grant(w, w.ownerToken)).json().data.subscription.id as string;

    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(before.currentPeriodEnd).toBeNull();

    const res = await cancel(w, w.ownerToken, subId);
    expect(res.statusCode).toBe(200);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(row.status).toBe('CANCELED');
    // Not scheduled: `cancelAt` is now-ish rather than a future date.
    expect(row.cancelAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('cancelling a TIME-BOXED grant schedules for the end of the term', async () => {
    const w = await world();
    const termEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const subId = (
      await grant(w, w.ownerToken, { currentPeriodEnd: termEnd.toISOString() })
    ).json().data.subscription.id as string;

    const res = await cancel(w, w.ownerToken, subId);
    expect(res.statusCode).toBe(200);

    const row = await prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    // Still entitling, and ending on the date the operator paid for.
    expect(row.cancelAt).not.toBeNull();
    expect(row.cancelAt!.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
    expect(row.status).not.toBe('EXPIRED');
  });

  it('cancelling is idempotent', async () => {
    const w = await world();
    const subId = (await grant(w, w.ownerToken)).json().data.subscription.id as string;
    expect((await cancel(w, w.ownerToken, subId)).statusCode).toBe(200);
    expect((await cancel(w, w.ownerToken, subId)).statusCode).toBe(200);
  });

  it('a subscription id belonging to a different end-user is not found', async () => {
    // Scoped in the query rather than checked afterwards: reading by id and
    // comparing later is how a route becomes an existence oracle.
    const w = await world();
    const subId = (await grant(w, w.ownerToken)).json().data.subscription.id as string;

    const other = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${w.applicationId}/end-users`,
      headers: { authorization: `Bearer ${w.ownerToken}` },
      payload: { email: `bystander-${w.tag}@example.com` },
    });
    expect(other.statusCode).toBe(201);
    const otherId = (other.json().data as { id: string }).id;

    const res = await cancel(w, w.ownerToken, subId, {}, otherId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SUBSCRIPTION_NOT_FOUND');
  });

  it('nothing can be granted to a GDPR tombstone', async () => {
    // The lever and the Erase button are now on the same end-user, one tab
    // apart. `subscriber.service.ts` has refused this since the external
    // provider landed; the grant path did not, so an erasure could be followed
    // by a grant that writes a fresh, un-scrubbed financial row, carrying the
    // operator's note, typically a name or an invoice reference, for a subject
    // the workspace has legally committed to scrubbing, and announces
    // `subscription.activated` for an id that just announced `user.erased`.
    const w = await world();

    const erase = await inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${w.applicationId}/end-users/${w.endUserId}?erasure=true`,
      headers: { authorization: `Bearer ${w.ownerToken}` },
    });
    expect(erase.statusCode).toBe(200);

    const res = await grant(w, w.ownerToken, { note: 'should not be possible' });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('END_USER_ERASED');

    // And nothing was written on the way to refusing.
    expect(
      await prisma.subscription.count({ where: { applicationId: w.applicationId } }),
    ).toBe(0);
  });

  it('a MEMBER cannot cancel either', async () => {
    const w = await world();
    const subId = (await grant(w, w.ownerToken)).json().data.subscription.id as string;
    const memberToken = await coworker(w, 'MEMBER', 'APP_BILLING');

    const res = await cancel(w, memberToken, subId);
    expect(res.statusCode).toBe(403);
  });
});
