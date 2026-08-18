/**
 * An Application bills individuals OR organizations, never both (#431).
 *
 * `billingConfig.billingSubject` already says which, and checkout already
 * refuses an org-subject Application that is handed no organization. The
 * reverse was never checked: a USER-subject Application accepted an
 * `organizationId` and happily created an org-billed subscription beside the
 * personal ones.
 *
 * That is what makes the uniqueness bug in #431 reachable. `Subscription` is
 * unique on `(applicationId, endUserId, planId)` with no beneficiary in the
 * key, so a buyer's personal subscription to a plan and an org-billed
 * subscription to the SAME plan are one row and one silently overwrites the
 * other. Widening the constraint is one way out; making the two states
 * impossible to hold at once is the other, and it matches what the product
 * already claims: the subject is a property of the Application.
 *
 * The toggle is the other half. Flipping `billingSubject` under live
 * subscriptions would strand every one of them on the wrong side of the
 * setting, so it is refused while any exist rather than silently reassigning
 * who is paying — nobody can decide that but the operator.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { configureSandboxStripe } from './fakes/billing-credentials.js';

describe('billing subject is exclusive per Application (#431)', () => {
  let app: FastifyInstance;
  let applicationId: string;
  let liveKey: string;
  let tenantToken: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function adminPost<T>(url: string, payload: unknown): Promise<T> {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${process.env.SUPER_ADMIN_KEY ?? 'test-super-admin-key'}` },
      payload: payload as Record<string, unknown>,
    });
    return res.json().data as T;
  }

  beforeEach(async () => {
    const slug = `subj-${Date.now()}`;
    tenantToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-${slug}@example.com`,
          password: 'Subj-Passw0rd!42',
          workspaceName: `WS ${slug}`,
        },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    await prisma.application.update({
      where: { id: applicationId },
      data: {
        billingConfig: {
          enabled: true,
          billingSubject: 'user',
          // Required with no default; omitting it makes BillingConfigSchema
          // reject the whole config and every checkout 400s on `provider`.
          provider: 'stripe',
          currency: 'USD',
        },
      },
    });
    const key = await adminPost<{ rawKey: string }>(
      `/api/v1/admin/applications/${applicationId}/api-keys`,
      { name: 'k', mode: 'live' },
    );
    liveKey = key.rawKey;
    await configureSandboxStripe(applicationId);
    await adminPost(`/api/v1/admin/applications/${applicationId}/plans`, {
      slug: 'pro',
      name: 'Pro',
      amount: 2900,
    });
  });

  async function signUp(): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: `eu-${Date.now()}@example.com`, password: 'Subj-Passw0rd!42' },
    });
    const data = res.json().data as { accessToken: string; endUser: { id: string } };
    return { token: data.accessToken, id: data.endUser.id };
  }

  /** An org this end-user owns, so they are entitled to check out for it. */
  async function ownedOrg(endUserId: string): Promise<string> {
    const org = await prisma.organization.create({
      data: { applicationId, name: 'Acme', slug: `acme-${Date.now()}` },
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, endUserId, role: 'OWNER' },
    });
    return org.id;
  }

  function checkout(token: string, organizationId?: string): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${liveKey}`, 'x-rekey-user-token': token },
      payload: {
        planSlug: 'pro',
        successUrl: 'https://example.com/ok',
        cancelUrl: 'https://example.com/no',
        ...(organizationId !== undefined && { organizationId }),
      },
    });
  }

  function setSubject(subject: 'user' | 'org'): Promise<LightMyRequestResponse> {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${applicationId}/billing-config`,
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { billingSubject: subject },
    });
  }

  it('refuses an organization on a user-subject Application', async () => {
    const user = await signUp();
    const orgId = await ownedOrg(user.id);

    const res = await checkout(user.token, orgId);

    // Before this guard the checkout answered 200 and wrote an org-billed row.
    // Because `(applicationId, endUserId, planId)` has no beneficiary in it,
    // that row IS the buyer's personal row: whichever came second silently
    // took the other's place, and the subscription that was overwritten kept
    // billing at its processor with nothing local naming it.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BILLING_ORGANIZATION_NOT_ACCEPTED');

    expect(await prisma.subscription.count({ where: { applicationId } })).toBe(0);
  });

  it('still accepts a personal checkout on a user-subject Application', async () => {
    // The guard must refuse the org, not the mode. This is the ordinary path
    // and a regression here would break every user-subject application.
    const user = await signUp();
    const res = await checkout(user.token);
    expect(res.statusCode).toBe(200);
  });

  it('lets the subject be changed while nothing is subscribed yet', async () => {
    // Setup has to stay fluid. The setting is only load-bearing once somebody
    // is paying under it.
    const res = await setSubject('org');
    expect(res.statusCode).toBe(200);
  });

  it('refuses to change the subject once subscriptions exist under it', async () => {
    const user = await signUp();
    expect((await checkout(user.token)).statusCode).toBe(200);

    const res = await setSubject('org');

    // Flipping now would strand a live personal subscription in an
    // org-subject application: it cannot be cancelled through the org path,
    // it does not appear in the org's portal, and the buyer keeps being
    // charged. Rekey cannot decide who should own it instead, so it refuses
    // and says how many rows are in the way.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('BILLING_SUBJECT_CHANGE_BLOCKED');
    expect(res.json().error.message).toMatch(/1/);
  });

  it('allows a no-op write of the same subject even with subscriptions', async () => {
    // Patching the billing config for an unrelated reason must not be blocked
    // by a subject that is not actually changing.
    const user = await signUp();
    expect((await checkout(user.token)).statusCode).toBe(200);

    const res = await setSubject('user');
    expect(res.statusCode).toBe(200);
  });
});
