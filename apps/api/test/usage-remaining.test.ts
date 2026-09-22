/**
 * Usage remaining and the meter catalogue.
 *
 *   GET /api/v1/usage/remaining            end-user token (+ publishable or secret key)
 *   GET /api/v1/usage/remaining/for-user   secret key, a named end-user or organization
 *   GET /api/v1/usage/meters               secret key
 *
 * The property the remaining read exists for: it reports what `POST
 * /usage/record` will enforce. The central test records up to the quota one
 * unit at a time and checks, at every step, that `remaining` reaches 0 exactly
 * when the next record is refused with 402 USAGE_QUOTA_EXCEEDED.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UsageRemainingDto } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { usageService } from '../src/modules/usage/usage.service.js';
import { countQueries } from './query-counter.js';

describe('Usage remaining + meter catalogue', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let secretKey: string;
  let publicKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (): { authorization: string } => ({ authorization: `Bearer ${operator}` });
  const sk = (): { authorization: string } => ({ authorization: `Bearer ${secretKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ur-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: op(),
        payload: { name: 'UR', slug: `ur-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = application.id;
    publicKey = application.publicKey;
    secretKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: op(),
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: op(),
      payload: { slug: 'api_calls', name: 'API calls', unit: 'calls' },
    });
  });

  interface Session {
    accessToken: string;
    endUser: { id: string };
  }

  async function signUp(): Promise<Session> {
    return app
      .inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up',
        headers: sk(),
        payload: { email: `eu-${Math.random().toString(36).slice(2, 8)}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as Session);
  }

  /** A plan with one USAGE entitlement on `api_calls`, and an ACTIVE subscription to it. */
  async function subscribe(
    subject: { endUserId: string; beneficiaryOrgId?: string },
    included: number,
    creditsPerUnit?: number,
  ): Promise<void> {
    const planSlug = `capped-${Math.random().toString(36).slice(2, 6)}`;
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/plans`,
      headers: op(),
      payload: { slug: planSlug, name: planSlug, amount: 0, kind: 'SUBSCRIPTION' },
    });
    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appId}/plans/${planSlug}/entitlements`,
      headers: op(),
      payload: {
        kind: 'USAGE',
        key: 'api_calls',
        quantity: included,
        ...(creditsPerUnit !== undefined && { creditsPerUnit }),
      },
    });
    expect(put.statusCode).toBeLessThan(300);
    const plan = await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug: planSlug } });
    await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId: subject.endUserId,
        planId: plan.id,
        status: 'ACTIVE',
        provider: 'stripe',
        ...(subject.beneficiaryOrgId !== undefined && { beneficiaryOrgId: subject.beneficiaryOrgId }),
      },
    });
  }

  const record = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/usage/record', headers: sk(), payload });

  const selfRemaining = async (
    accessToken: string,
    query = '?meter=api_calls',
    key: string = publicKey,
  ): Promise<{ status: number; body: UsageRemainingDto; code?: string }> => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/usage/remaining${query}`,
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': accessToken },
    });
    const json = res.json();
    return { status: res.statusCode, body: json.data as UsageRemainingDto, code: json.error?.code };
  };

  it('remaining hits 0 exactly when the next record is refused with 402 USAGE_QUOTA_EXCEEDED', async () => {
    const user = await signUp();
    await subscribe({ endUserId: user.endUser.id }, 5);

    for (let recorded = 0; recorded <= 5; recorded += 1) {
      const { status, body } = await selfRemaining(user.accessToken);
      expect(status).toBe(200);
      const meter = body.meters[0]!;
      expect(meter).toMatchObject({ meterSlug: 'api_calls', included: 5, used: recorded, creditsPerUnit: null });
      expect(meter.remaining).toBe(5 - recorded);

      const next = await record({ meterSlug: 'api_calls', quantity: 1, endUserId: user.endUser.id });
      if (meter.remaining! > 0) {
        expect(next.statusCode).toBe(201);
      } else {
        expect(next.statusCode).toBe(402);
        expect(next.json().error.code).toBe('USAGE_QUOTA_EXCEEDED');
      }
    }
    // The refused record changed nothing.
    const after = await selfRemaining(user.accessToken);
    expect(after.body.meters[0]).toMatchObject({ used: 5, remaining: 0 });
  });

  it('a record of exactly `remaining` units is accepted and one more is refused', async () => {
    const user = await signUp();
    await subscribe({ endUserId: user.endUser.id }, 10);
    expect((await record({ meterSlug: 'api_calls', quantity: 4, endUserId: user.endUser.id })).statusCode).toBe(201);

    const { remaining } = (await selfRemaining(user.accessToken)).body.meters[0]!;
    expect(remaining).toBe(6);
    expect((await record({ meterSlug: 'api_calls', quantity: remaining! + 1, endUserId: user.endUser.id })).statusCode).toBe(402);
    expect((await record({ meterSlug: 'api_calls', quantity: remaining!, endUserId: user.endUser.id })).statusCode).toBe(201);
    expect((await selfRemaining(user.accessToken)).body.meters[0]!.remaining).toBe(0);
  });

  it('reports the calendar month in UTC and ignores usage recorded in an earlier month', async () => {
    const user = await signUp();
    await subscribe({ endUserId: user.endUser.id }, 10);
    const meter = await prisma.usageMeter.findFirstOrThrow({ where: { applicationId: appId, slug: 'api_calls' } });
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await prisma.usageRecord.create({
      data: { meterId: meter.id, endUserId: user.endUser.id, subjectKey: `u:${user.endUser.id}`, quantity: 9, occurredAt: lastMonth },
    });

    const { body } = await selfRemaining(user.accessToken);
    expect(body.periodStart).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
    expect(body.periodEnd).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString());
    expect(body.meters[0]).toMatchObject({ used: 0, remaining: 10 });
    expect(body.meters[0]!.periodStart).toBe(body.periodStart);
  });

  it('no quota is reported as null (uncapped), and records are not refused', async () => {
    const user = await signUp();
    expect((await record({ meterSlug: 'api_calls', quantity: 50, endUserId: user.endUser.id })).statusCode).toBe(201);
    const { body } = await selfRemaining(user.accessToken);
    expect(body.meters[0]).toMatchObject({ included: null, used: 50, remaining: null, creditsPerUnit: null });
  });

  it('a priced meter reports the credit rate record would charge past the quota', async () => {
    const user = await signUp();
    await subscribe({ endUserId: user.endUser.id }, 2, 3);
    const { body } = await selfRemaining(user.accessToken);
    expect(body.meters[0]).toMatchObject({ included: 2, remaining: 2, creditsPerUnit: 3 });
  });

  it('without ?meter= every meter is listed, and an unknown meter is 404', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/usage-meters`,
      headers: op(),
      payload: { slug: 'exports', name: 'Exports', unit: 'files' },
    });
    const user = await signUp();
    const all = await selfRemaining(user.accessToken, '');
    expect(all.status).toBe(200);
    expect(all.body.meters.map((m) => m.meterSlug)).toEqual(['api_calls', 'exports']);
    expect(all.body).toMatchObject({ endUserId: user.endUser.id, organizationId: null });

    const missing = await selfRemaining(user.accessToken, '?meter=nope');
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('USAGE_METER_NOT_FOUND');
  });

  it('costs the same number of queries for 2 meters as for 12', async () => {
    const user = await signUp();
    await subscribe({ endUserId: user.endUser.id }, 5);
    const subject = { endUserId: user.endUser.id };
    const read = () => usageService.remaining({ applicationId: appId, subject });
    await prisma.usageMeter.create({ data: { applicationId: appId, slug: 'm2', name: 'm2', unit: 'u' } });
    const small = await countQueries(read);
    await prisma.usageMeter.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ applicationId: appId, slug: `more-${i}`, name: `m${i}`, unit: 'u' })),
    });
    const large = await countQueries(read);
    expect((await read()).meters).toHaveLength(12);
    expect(large.count).toBe(small.count);
  });

  it('says when an unfiltered read stops short of the catalogue', async () => {
    const user = await signUp();
    await prisma.usageMeter.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ applicationId: appId, slug: `bulk-${i}`, name: `b${i}`, unit: 'u' })),
    });
    const all = await selfRemaining(user.accessToken, '');
    expect(all.body.meters).toHaveLength(200);
    expect(all.body).toMatchObject({ totalMeters: 201, truncated: true });

    const one = await selfRemaining(user.accessToken, '?meter=bulk-199');
    expect(one.body).toMatchObject({ totalMeters: 1, truncated: false });
  });

  it('works with the secret key and a user token too, and needs the token', async () => {
    const user = await signUp();
    expect((await selfRemaining(user.accessToken, '?meter=api_calls', secretKey)).status).toBe(200);
    const noToken = await app.inject({
      method: 'GET',
      url: '/api/v1/usage/remaining',
      headers: { authorization: `Bearer ${publicKey}` },
    });
    expect(noToken.statusCode).toBe(401);
    expect(noToken.json().error.code).toBe('USER_TOKEN_MISSING');
  });

  describe('organizations', () => {
    async function makeOrg(ownerEndUserId: string): Promise<string> {
      return app
        .inject({
          method: 'POST',
          url: `/api/v1/tenant/applications/${appId}/organizations`,
          headers: op(),
          payload: { name: 'Acme', slug: `acme-${Math.random().toString(36).slice(2, 6)}`, ownerEndUserId },
        })
        .then((r) => (r.json().data as { id: string }).id);
    }

    const switchTo = (accessToken: string, orgId: string): Promise<Session> =>
      app
        .inject({
          method: 'POST',
          url: `/api/v1/users/me/organizations/${orgId}/switch`,
          headers: { authorization: `Bearer ${secretKey}`, 'x-rekey-user-token': accessToken },
        })
        .then((r) => r.json().data as Session);

    it('an org-billed application reads the active organization, and its quota is the one record enforces', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/tenant/applications/${appId}/billing-config`,
        headers: op(),
        payload: { billingSubject: 'org' },
      });
      const owner = await signUp();
      const orgId = await makeOrg(owner.endUser.id);
      await subscribe({ endUserId: owner.endUser.id, beneficiaryOrgId: orgId }, 3);
      const switched = await switchTo(owner.accessToken, orgId);

      const before = await selfRemaining(switched.accessToken);
      expect(before.body).toMatchObject({ organizationId: orgId, endUserId: null });
      expect(before.body.meters[0]).toMatchObject({ included: 3, remaining: 3 });

      expect((await record({ meterSlug: 'api_calls', quantity: 3, organizationId: orgId })).statusCode).toBe(201);
      expect((await selfRemaining(switched.accessToken)).body.meters[0]!.remaining).toBe(0);
      expect((await record({ meterSlug: 'api_calls', quantity: 1, organizationId: orgId })).statusCode).toBe(402);

      // The personal token (no active org) reads the personal pool, which has no quota.
      const personal = await selfRemaining(owner.accessToken);
      expect(personal.body).toMatchObject({ endUserId: owner.endUser.id, organizationId: null });
      expect(personal.body.meters[0]!.included).toBeNull();
    });

    it('a user-billed application stays on the personal pool after switching into a team', async () => {
      const owner = await signUp();
      await subscribe({ endUserId: owner.endUser.id }, 7);
      const orgId = await makeOrg(owner.endUser.id);
      const switched = await switchTo(owner.accessToken, orgId);
      const { body } = await selfRemaining(switched.accessToken);
      expect(body).toMatchObject({ endUserId: owner.endUser.id, organizationId: null });
      expect(body.meters[0]!.included).toBe(7);
    });

    it('?organizationId= is member-only', async () => {
      const owner = await signUp();
      const orgId = await makeOrg(owner.endUser.id);
      const stranger = await signUp();
      const res = await selfRemaining(stranger.accessToken, `?organizationId=${orgId}`);
      expect(res.status).toBe(403);
      expect(res.code).toBe('ORGANIZATION_NOT_MEMBER');
      expect((await selfRemaining(owner.accessToken, `?organizationId=${orgId}`)).body.organizationId).toBe(orgId);
    });

    it('for-user reads a named organization, and refuses a non-member end-user for it', async () => {
      const owner = await signUp();
      const orgId = await makeOrg(owner.endUser.id);
      await subscribe({ endUserId: owner.endUser.id, beneficiaryOrgId: orgId }, 4);
      const read = (q: string) =>
        app.inject({ method: 'GET', url: `/api/v1/usage/remaining/for-user${q}`, headers: sk() });

      const org = await read(`?organizationId=${orgId}&meter=api_calls`);
      expect(org.statusCode).toBe(200);
      expect((org.json().data as UsageRemainingDto).meters[0]).toMatchObject({ included: 4, remaining: 4 });

      const asMember = await read(`?organizationId=${orgId}&endUserId=${owner.endUser.id}`);
      expect(asMember.statusCode).toBe(200);

      const stranger = await signUp();
      const refused = await read(`?organizationId=${orgId}&endUserId=${stranger.endUser.id}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
    });
  });

  describe('for-user (secret key)', () => {
    const forUser = (q: string, key = secretKey) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/usage/remaining/for-user${q}`,
        headers: { authorization: `Bearer ${key}` },
      });

    it('matches the self read for the same end-user', async () => {
      const user = await signUp();
      await subscribe({ endUserId: user.endUser.id }, 8);
      await record({ meterSlug: 'api_calls', quantity: 3, endUserId: user.endUser.id });
      const named = await forUser(`?endUserId=${user.endUser.id}&meter=api_calls`);
      expect(named.statusCode).toBe(200);
      expect(named.json().data).toEqual((await selfRemaining(user.accessToken)).body);
    });

    it('refuses the publishable key, an unknown end-user, and a missing subject', async () => {
      const user = await signUp();
      expect((await forUser(`?endUserId=${user.endUser.id}`, publicKey)).statusCode).toBe(401);
      const unknown = await forUser('?endUserId=nobody');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('END_USER_NOT_FOUND');
      expect((await forUser('')).statusCode).toBe(400);
    });

    it('accepts a narrow billing:read key and refuses a key without it', async () => {
      const user = await signUp();
      const mint = (scopes: string[]) =>
        app
          .inject({
            method: 'POST',
            url: `/api/v1/tenant/applications/${appId}/api-keys`,
            headers: op(),
            payload: { name: 'narrow', mode: 'live', scopes },
          })
          .then((r) => (r.json().data as { rawKey: string }).rawKey);
      expect((await forUser(`?endUserId=${user.endUser.id}`, await mint(['billing:read']))).statusCode).toBe(200);
      const denied = await forUser(`?endUserId=${user.endUser.id}`, await mint(['auth:read']));
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
    });
  });

  describe('GET /usage/meters', () => {
    it('lists the catalogue with slugs, units, activity and price, paged', async () => {
      await app.inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/usage-meters`,
        headers: op(),
        payload: { slug: 'exports', name: 'Exports', unit: 'files', creditsPerUnit: 2 },
      });
      const res = await app.inject({ method: 'GET', url: '/api/v1/usage/meters', headers: sk() });
      expect(res.statusCode).toBe(200);
      const { items, page } = res.json().data as {
        items: Array<Record<string, unknown>>;
        page: { total: number };
      };
      expect(page.total).toBe(2);
      expect(items[0]).toMatchObject({ slug: 'api_calls', name: 'API calls', unit: 'calls', active: true, creditsPerUnit: null });
      expect(items[1]).toMatchObject({ slug: 'exports', creditsPerUnit: 2 });
      expect(Object.keys(items[0]!).sort()).toEqual(['active', 'createdAt', 'creditsPerUnit', 'id', 'name', 'slug', 'unit']);

      const second = await app.inject({ method: 'GET', url: '/api/v1/usage/meters?limit=1&offset=1', headers: sk() });
      expect((second.json().data as { items: Array<{ slug: string }> }).items.map((m) => m.slug)).toEqual(['exports']);
    });

    it('is secret-key only', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/usage/meters',
        headers: { authorization: `Bearer ${publicKey}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
