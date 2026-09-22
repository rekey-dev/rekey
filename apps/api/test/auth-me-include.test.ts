/**
 * `?include=` on GET /api/v1/auth/me and GET /api/v1/users/me (rekey#41).
 *
 * One call that answers who the caller is, what they are entitled to, which
 * device the session is bound to, what they are subscribed to and which
 * organization they act for. What these tests pin:
 *
 *   - absent or empty `include` is byte-for-byte the previous response, with
 *     the same number of queries;
 *   - every value equals the dedicated route's answer for the same session
 *     (deep equality, not a field spot-check), including an org-billed app;
 *   - the parameter is parsed strictly: unknown values 400, order and
 *     duplicates do not matter;
 *   - every session check still runs first and still wins;
 *   - the device is scoped to the token's own end-user and Application;
 *   - the OpenAPI document declares all of it and a real response validates.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { issueUserAccessToken } from '../src/lib/jwt.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { resolveMeIncludes } from '../src/modules/auth/me-include.js';
import { countQueries } from './query-counter.js';

const PASSWORD = 'pw-one-two-three';

/** The keys GET /auth/me and GET /users/me returned before `include` existed, in order. */
const BASELINE_KEYS = [
  'id',
  'applicationId',
  'email',
  'emailVerified',
  'role',
  'metadata',
  'erasedAt',
  'erasedBy',
  'createdAt',
  'updatedAt',
  'activeOrganizationId',
  'activeOrganizationRole',
  'activeOrganizationBaseRole',
];

interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string | null;
  endUser: { id: string };
}

describe('GET /auth/me and /users/me ?include=', () => {
  let app: FastifyInstance;
  let operator: string;
  let appId: string;
  let publicKey: string;
  let secretKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const op = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${operator}` },
      ...(payload !== undefined && { payload: payload as never }),
    });

  async function makeApplication(opts: { billing: boolean }): Promise<{ id: string; publicKey: string; key: string }> {
    const slug = Math.random().toString(36).slice(2, 8);
    const created = await op('POST', '/api/v1/tenant/applications/', {
      name: 'AM',
      slug: `am-${slug}`,
      enableBilling: opts.billing,
    });
    expect(created.statusCode).toBe(201);
    const { id, publicKey: pub } = created.json().data as { id: string; publicKey: string };
    const orgs = await op('PATCH', `/api/v1/tenant/applications/${id}/auth-config`, { organizationsEnabled: true });
    expect(orgs.statusCode).toBe(200);
    const key = await op('POST', `/api/v1/tenant/applications/${id}/api-keys`, {
      name: 'k',
      mode: 'live',
      scopes: ['*'],
    });
    return { id, publicKey: pub, key: (key.json().data as { rawKey: string }).rawKey };
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `am-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const made = await makeApplication({ billing: true });
    appId = made.id;
    publicKey = made.publicKey;
    secretKey = made.key;
  });

  const secret = () => ({ authorization: `Bearer ${secretKey}` });

  async function signUp(email: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: secret(),
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as Session;
  }

  async function signIn(email: string, fingerprint?: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: secret(),
      payload: { email, password: PASSWORD, ...(fingerprint && { device: { fingerprint, label: 'Laptop' } }) },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  const authMe = (token: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/auth/me${query}`, headers: { 'x-rekey-user-token': token } });

  const usersMe = (token: string, query = '', key = secretKey) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/users/me/${query}`,
      headers: { authorization: `Bearer ${key}`, 'x-rekey-user-token': token },
    });

  /** A plan carrying one entitlement of every kind. */
  async function richPlan(slug = 'pro'): Promise<string> {
    const plan = await op('POST', `/api/v1/tenant/applications/${appId}/plans`, {
      slug,
      name: slug,
      amount: 0,
      kind: 'SUBSCRIPTION',
    });
    expect(plan.statusCode).toBe(201);
    const url = `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`;
    for (const payload of [
      { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' },
      { kind: 'FEATURE', key: 'projects', valueType: 'INT', value: '5' },
      { kind: 'CREDIT', quantity: 500 },
      { kind: 'USAGE', key: 'api_calls', quantity: 1000 },
      { kind: 'LICENSE', licenseKind: 'PERPETUAL' },
    ]) {
      const put = await op('PUT', url, payload);
      expect(put.statusCode, put.body).toBe(200);
    }
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  async function subscribe(endUserId: string, planId: string, beneficiaryOrgId?: string): Promise<void> {
    const sub = await prisma.subscription.create({
      data: {
        applicationId: appId,
        endUserId,
        planId,
        status: 'ACTIVE',
        provider: 'stripe',
        ...(beneficiaryOrgId && { beneficiaryOrgId }),
      },
    });
    await entitlementsService.provision({ subscription: sub });
  }

  async function makeOrg(ownerEndUserId: string, slug: string): Promise<string> {
    const r = await op('POST', `/api/v1/tenant/applications/${appId}/organizations`, {
      name: slug,
      slug,
      ownerEndUserId,
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  async function switchTo(token: string, orgId: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${orgId}/switch`,
      headers: { ...secret(), 'x-rekey-user-token': token },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data as Session;
  }

  const dataOf = (res: { statusCode: number; body: string; json: () => unknown }) => {
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { data: Record<string, unknown> }).data;
  };

  // -------------------------------------------------------------------------
  // Absent include: unchanged
  // -------------------------------------------------------------------------

  describe('without include', () => {
    it('returns exactly the previous keys, and `include=` / `include=,` return the same bytes', async () => {
      await signUp('plain@example.com');
      const s = await signIn('plain@example.com', 'fp-plain-000001');
      for (const call of [
        (q: string) => authMe(s.accessToken, q),
        (q: string) => usersMe(s.accessToken, q),
      ]) {
        const absent = await call('');
        expect(Object.keys(dataOf(absent))).toEqual(BASELINE_KEYS);
        for (const key of ['entitlements', 'device', 'subscription', 'organization', 'licenses']) {
          expect(dataOf(absent)).not.toHaveProperty(key);
        }
        expect((await call('?include=')).body).toBe(absent.body);
        expect((await call('?include=,')).body).toBe(absent.body);
      }
    });

    it('runs the same queries as before: 4 on /auth/me, 5 on /users/me for a device-bound session', async () => {
      // Counts measured on origin/main before this change, same fixture.
      await signUp('q@example.com');
      const s = await signIn('q@example.com', 'fp-query-000001');
      await authMe(s.accessToken);
      for (const [call, expected] of [
        [(q: string) => authMe(s.accessToken, q), 4],
        [(q: string) => usersMe(s.accessToken, q), 5],
      ] as const) {
        for (const q of ['', '?include=']) {
          const counted = await countQueries(() => call(q));
          expect(counted.count, counted.queries.join('\n')).toBe(expected);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  describe('the include parameter', () => {
    it('refuses an unknown value with the standard 400, naming the supported values', async () => {
      const s = await signUp('bad@example.com');
      for (const res of [
        await authMe(s.accessToken, '?include=entitlements,devices'),
        await usersMe(s.accessToken, '?include=Device'),
      ]) {
        expect(res.statusCode).toBe(400);
        const error = res.json().error as { code: string; message: string; issues: Array<{ path: string }> };
        expect(error.code).toBe('VALIDATION_ERROR');
        expect(error.message).toContain(
          'Supported values: entitlements, device, subscription, organization, licenses.',
        );
        expect(error.issues[0]!.path).toBe('include');
      }
    });

    it('ignores order, duplicates and whitespace; properties come out in one fixed order', async () => {
      await signUp('order@example.com');
      const s = await signIn('order@example.com', 'fp-order-000001');
      const a = await authMe(s.accessToken, '?include=device,entitlements');
      const b = await authMe(s.accessToken, '?include=entitlements,%20device,device,,entitlements');
      expect(b.body).toBe(a.body);
      expect(Object.keys(dataOf(a))).toEqual([...BASELINE_KEYS, 'entitlements', 'device']);
    });

    it('accepts the repeated form, include=a&include=b, as URLSearchParams.append builds it', async () => {
      await signUp('rep@example.com');
      const s = await signIn('rep@example.com', 'fp-repeat-000001');
      const q = new URLSearchParams();
      q.append('include', 'device');
      q.append('include', 'organization,device');
      for (const call of [authMe, usersMe]) {
        const repeated = await call(s.accessToken, `?${q.toString()}`);
        const joined = await call(s.accessToken, '?include=device,organization');
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.body).toBe(joined.body);
      }
      const bad = await authMe(s.accessToken, '?include=device&include=nope');
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('adds only what was asked for', async () => {
      const s = await signUp('one@example.com');
      const data = dataOf(await authMe(s.accessToken, '?include=device'));
      expect(Object.keys(data)).toEqual([...BASELINE_KEYS, 'device']);
    });
  });

  // -------------------------------------------------------------------------
  // Values equal the dedicated routes
  // -------------------------------------------------------------------------

  describe('entitlements', () => {
    it('equals GET /billing/entitlements/for-user and GET /billing/entitlements, every kind', async () => {
      const planId = await richPlan();
      const s = await signUp('ent@example.com');
      await subscribe(s.endUser.id, planId);

      const forUser = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/entitlements/for-user?endUserId=${s.endUser.id}`,
          headers: secret(),
        }),
      );
      const session = dataOf(
        await app.inject({
          method: 'GET',
          url: '/api/v1/billing/entitlements',
          headers: { ...secret(), 'x-rekey-user-token': s.accessToken },
        }),
      );
      const viaAuthMe = dataOf(await authMe(s.accessToken, '?include=entitlements')).entitlements;
      const viaUsersMe = dataOf(await usersMe(s.accessToken, '?include=entitlements')).entitlements;

      expect(viaAuthMe).toEqual(forUser);
      expect(viaUsersMe).toEqual(forUser);
      expect(viaAuthMe).toEqual(session);
      const typed = viaAuthMe as { entitlements: Array<{ kind: string }>; creditBalance: number; features: object };
      expect(new Set(typed.entitlements.map((e) => e.kind))).toEqual(new Set(['FEATURE', 'CREDIT', 'USAGE', 'LICENSE']));
      expect(typed.creditBalance).toBe(500);
      expect(typed.features).toEqual({ reports: true, projects: 5 });
    });

    it('for an end-user with no subscription, still equals for-user (free tier and all)', async () => {
      await richPlan('free');
      const app0 = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      await prisma.application.update({
        where: { id: appId },
        data: { billingConfig: { ...(app0.billingConfig as object), defaultPlanSlug: 'free' } as never },
      });
      const s = await signUp('nosub@example.com');
      const forUser = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/entitlements/for-user?endUserId=${s.endUser.id}`,
          headers: secret(),
        }),
      );
      const data = dataOf(await authMe(s.accessToken, '?include=entitlements,subscription'));
      expect(data.entitlements).toEqual(forUser);
      expect((data.entitlements as { features: object }).features).toEqual({ reports: true, projects: 5 });
      expect(data.subscription).toBeNull();
    });
  });

  describe('subscription', () => {
    it('equals GET /billing/subscription, providerCapabilities included', async () => {
      const planId = await richPlan();
      const s = await signUp('sub@example.com');
      await subscribe(s.endUser.id, planId);
      const direct = dataOf(
        await app.inject({
          method: 'GET',
          url: '/api/v1/billing/subscription',
          headers: { ...secret(), 'x-rekey-user-token': s.accessToken },
        }),
      );
      expect(direct).not.toBeNull();
      expect(direct).toHaveProperty('providerCapabilities');
      expect(dataOf(await authMe(s.accessToken, '?include=subscription')).subscription).toEqual(direct);
      expect(dataOf(await usersMe(s.accessToken, '?include=subscription')).subscription).toEqual(direct);
    });

    it('is null for an end-user with no subscription', async () => {
      const s = await signUp('none@example.com');
      expect(dataOf(await authMe(s.accessToken, '?include=subscription')).subscription).toBeNull();
    });
  });

  describe('an org-billed application', () => {
    it("resolves entitlements and subscription for the active organization, as the org routes do", async () => {
      const cfg = await op('PATCH', `/api/v1/tenant/applications/${appId}/billing-config`, { billingSubject: 'org' });
      expect(cfg.statusCode, cfg.body).toBe(200);
      const planId = await richPlan('team');
      const owner = await signUp('owner@example.com');
      const member = await signUp('member@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'acme');
      const add = await op('POST', `/api/v1/tenant/applications/${appId}/organizations/${orgId}/members`, {
        endUserId: member.endUser.id,
        role: 'MEMBER',
      });
      expect(add.statusCode).toBe(201);
      await subscribe(owner.endUser.id, planId, orgId);

      const acting = await switchTo(member.accessToken, orgId);
      const userToken = { 'x-rekey-user-token': acting.accessToken };

      const forUser = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/entitlements/for-user?endUserId=${member.endUser.id}&organizationId=${orgId}`,
          headers: secret(),
        }),
      );
      const sessionEntitlements = dataOf(
        await app.inject({ method: 'GET', url: '/api/v1/billing/entitlements', headers: { ...secret(), ...userToken } }),
      );
      const orgSubscription = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/subscription?organizationId=${orgId}`,
          headers: { ...secret(), ...userToken },
        }),
      );
      const org = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/users/me/organizations/${orgId}`,
          headers: { ...secret(), ...userToken },
        }),
      );

      for (const res of [
        await authMe(acting.accessToken, '?include=entitlements,subscription,organization'),
        await usersMe(acting.accessToken, '?include=entitlements,subscription,organization'),
      ]) {
        const data = dataOf(res);
        expect(data.activeOrganizationId).toBe(orgId);
        expect(data.entitlements).toEqual(forUser);
        expect(data.entitlements).toEqual(sessionEntitlements);
        expect((data.entitlements as { creditBalance: number }).creditBalance).toBe(500);
        expect(data.subscription).toEqual(orgSubscription);
        expect((data.subscription as { id: string } | null)?.id).toBeTruthy();
        expect(data.organization).toEqual(org);
        expect(data.organization).toMatchObject({ id: orgId, role: 'MEMBER', baseRole: 'MEMBER' });
      }
    });

    it('in a USER-billed application an org session still reads the personal subscription', async () => {
      // billingSubject defaults to "user": organizations never hold a
      // subscription here, so switching into a team must not hide the plan
      // the user pays for.
      const planId = await richPlan();
      const u = await signUp('payer@example.com');
      await subscribe(u.endUser.id, planId);
      const orgId = await makeOrg(u.endUser.id, 'team');
      const acting = await switchTo(u.accessToken, orgId);
      const userToken = { 'x-rekey-user-token': acting.accessToken };

      const subscription = dataOf(
        await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: { ...secret(), ...userToken } }),
      );
      const forUser = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/entitlements/for-user?endUserId=${u.endUser.id}`,
          headers: secret(),
        }),
      );
      expect(subscription).not.toBeNull();

      for (const res of [
        await authMe(acting.accessToken, '?include=subscription,entitlements'),
        await usersMe(acting.accessToken, '?include=subscription,entitlements'),
      ]) {
        const data = dataOf(res);
        expect(data.activeOrganizationId).toBe(orgId);
        expect(data.subscription).toEqual(subscription);
        expect(data.entitlements).toEqual(forUser);
        expect((data.entitlements as { features: object }).features).toEqual({ reports: true, projects: 5 });
      }
    });

    it('organization is null without an active organization, and after membership lapses', async () => {
      const owner = await signUp('o2@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'lapse');
      expect(dataOf(await authMe(owner.accessToken, '?include=organization')).organization).toBeNull();
      const acting = await switchTo(owner.accessToken, orgId);
      expect(dataOf(await authMe(acting.accessToken, '?include=organization')).organization).toMatchObject({
        id: orgId,
        baseRole: 'OWNER',
      });
      await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId } });
      const data = dataOf(await authMe(acting.accessToken, '?include=organization,entitlements'));
      expect(data.organization).toBeNull();
      // The billing subject degrades to the personal view, as GET /billing/entitlements does.
      const personal = dataOf(
        await app.inject({
          method: 'GET',
          url: `/api/v1/billing/entitlements/for-user?endUserId=${owner.endUser.id}`,
          headers: secret(),
        }),
      );
      expect(data.entitlements).toEqual(personal);
    });
  });

  // -------------------------------------------------------------------------
  // Device
  // -------------------------------------------------------------------------

  describe('device', () => {
    it("returns the token's device in the end-user shape, and null for an unbound session", async () => {
      await signUp('dev@example.com');
      const bound = await signIn('dev@example.com', 'fp-dev-00000001');
      const unbound = await signIn('dev@example.com');

      for (const res of [
        await authMe(bound.accessToken, '?include=device'),
        await usersMe(bound.accessToken, '?include=device'),
        await usersMe(bound.accessToken, '?include=device', publicKey),
      ]) {
        const device = dataOf(res).device as Record<string, unknown>;
        expect(device).toMatchObject({
          id: bound.deviceId,
          fingerprint: 'fp-dev-00000001',
          label: 'Laptop',
          status: 'ACTIVE',
        });
        expect(device).not.toHaveProperty('lastSeenIp');
        expect(device).not.toHaveProperty('blockedReason');
        expect(device.firstSeenAt).toBeTruthy();
        expect(device.lastSeenAt).toBeTruthy();
      }
      expect(dataOf(await authMe(unbound.accessToken, '?include=device')).device).toBeNull();
    });

    it("never returns another end-user's or another Application's device", async () => {
      const alice = await signUp('alice@example.com');
      await signUp('bob@example.com');
      const bob = await signIn('bob@example.com', 'fp-bob-00000001');
      const other = await makeApplication({ billing: false });
      const foreignDevice = await prisma.device.create({
        data: {
          applicationId: other.id,
          endUserId: (await prisma.endUser.create({
            data: { applicationId: other.id, email: 'carol@example.com' },
          })).id,
          fingerprint: 'fp-carol-0000001',
        },
      });

      // The resolver itself: a device id belonging to someone else reads as none.
      for (const deviceId of [bob.deviceId!, foreignDevice.id]) {
        const out = await resolveMeIncludes(new Set(['device']), {
          endUser: { id: alice.endUser.id, applicationId: appId },
          deviceId,
          activeOrganizationId: null,
          activeOrganizationRole: null,
          loadApplication: () => prisma.application.findUniqueOrThrow({ where: { id: appId } }),
        });
        expect(out).toEqual({ device: null });
      }

      // On the wire, a token naming Bob's device for Alice never gets that far:
      // the session check refuses a `dev` claim that is not the holder's.
      const app0 = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const forged = issueUserAccessToken(alice.endUser.id, appId, app0.tokenGeneration, {
        deviceId: bob.deviceId!,
      }).token;
      for (const res of [await authMe(forged, '?include=device'), await usersMe(forged, '?include=device')]) {
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
        expect(res.body).not.toContain('fp-bob');
      }
    });

    it('a BLOCKED or RELEASED device ends the session: 401 with or without include, as before', async () => {
      const u = await signUp('blocked@example.com');
      const toBlock = await signIn('blocked@example.com', 'fp-block-000001');
      const toRelease = await signIn('blocked@example.com', 'fp-release-00001');
      const base = `/api/v1/tenant/applications/${appId}/end-users/${u.endUser.id}/devices`;
      expect((await op('POST', `${base}/${toBlock.deviceId}/block`, { reason: 'x' })).statusCode).toBe(200);
      expect((await op('POST', `${base}/${toRelease.deviceId}/release`, {})).statusCode).toBe(200);

      for (const s of [toBlock, toRelease]) {
        for (const q of ['', '?include=device', '?include=device,entitlements']) {
          for (const res of [await authMe(s.accessToken, q), await usersMe(s.accessToken, q)]) {
            expect(res.statusCode).toBe(401);
            expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Existing checks still win
  // -------------------------------------------------------------------------

  describe('session checks run first', () => {
    const INCLUDES = ['?include=entitlements,device,subscription,organization', '?include=not-a-value'];

    it('an expired token: 401 USER_TOKEN_INVALID', async () => {
      const u = await signUp('exp@example.com');
      const app0 = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
      const expired = issueUserAccessToken(u.endUser.id, appId, app0.tokenGeneration, { lifetimeSeconds: -60 }).token;
      for (const q of ['', ...INCLUDES]) {
        for (const res of [await authMe(expired, q), await usersMe(expired, q)]) {
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
        }
      }
    });

    it('a token older than sessionsInvalidBefore: 401 USER_TOKEN_INVALID', async () => {
      const u = await signUp('stamp@example.com');
      await prisma.endUser.update({
        where: { id: u.endUser.id },
        data: { sessionsInvalidBefore: new Date(Date.now() + 60_000) },
      });
      for (const q of ['', ...INCLUDES]) {
        for (const res of [await authMe(u.accessToken, q), await usersMe(u.accessToken, q)]) {
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('USER_TOKEN_INVALID');
        }
      }
    });

    it('an erased end-user: 410 END_USER_ERASED', async () => {
      const u = await signUp('erased@example.com');
      await prisma.endUser.update({ where: { id: u.endUser.id }, data: { erasedAt: new Date() } });
      for (const q of ['', ...INCLUDES]) {
        for (const res of [await authMe(u.accessToken, q), await usersMe(u.accessToken, q)]) {
          expect(res.statusCode).toBe(410);
          expect(res.json().error.code).toBe('END_USER_ERASED');
        }
      }
    });

    it('an ended operator impersonation: 401 IMPERSONATION_SESSION_ENDED on /auth/me too', async () => {
      const u = await signUp('imp@example.com');
      const base = `/api/v1/tenant/applications/${appId}/end-users/${u.endUser.id}/impersonate`;
      const started = await op('POST', base, { reason: 'support' });
      expect(started.statusCode).toBe(200);
      const token = (started.json().data as { accessToken: string }).accessToken;
      expect((await authMe(token, '?include=entitlements')).statusCode).toBe(200);

      expect((await op('POST', `${base}/end`)).statusCode).toBe(200);
      for (const q of ['', ...INCLUDES]) {
        for (const res of [await authMe(token, q), await usersMe(token, q)]) {
          expect(res.statusCode).toBe(401);
          expect(res.json().error.code).toBe('IMPERSONATION_SESSION_ENDED');
        }
      }
    });

    it('a disabled Application: 403 APPLICATION_DISABLED', async () => {
      const u = await signUp('frozen@example.com');
      expect((await op('POST', `/api/v1/tenant/applications/${appId}/disable`, {})).statusCode).toBe(200);
      for (const q of ['', ...INCLUDES]) {
        for (const res of [await authMe(u.accessToken, q), await usersMe(u.accessToken, q)]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('APPLICATION_DISABLED');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Gates on the billing values
  // -------------------------------------------------------------------------

  describe('billing gates', () => {
    it('billing turned off: 403 BILLING_DISABLED for entitlements or subscription, device still works', async () => {
      const off = await makeApplication({ billing: false });
      appId = off.id;
      secretKey = off.key;
      const s = await signUp('off@example.com');
      for (const q of ['?include=entitlements', '?include=subscription,device']) {
        for (const res of [await authMe(s.accessToken, q), await usersMe(s.accessToken, q)]) {
          expect(res.statusCode).toBe(403);
          expect(res.json().error.code).toBe('BILLING_DISABLED');
        }
      }
      expect(dataOf(await authMe(s.accessToken, '?include=device,organization'))).toMatchObject({
        device: null,
        organization: null,
      });
    });

    it('a secret key needs the scope of the route that serves each value on /users/me', async () => {
      const narrow = (
        await op('POST', `/api/v1/tenant/applications/${appId}/api-keys`, {
          name: 'narrow',
          mode: 'live',
          scopes: ['auth:read'],
        })
      ).json().data.rawKey as string;
      const s = await signUp('scope@example.com');
      for (const q of ['?include=entitlements', '?include=subscription']) {
        const res = await usersMe(s.accessToken, q, narrow);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      }
      // GET /users/me/organizations/:id reads with auth:read, so the include does too.
      expect(dataOf(await usersMe(s.accessToken, '?include=device,organization', narrow))).toMatchObject({
        device: null,
        organization: null,
      });
      const direct = await app.inject({
        method: 'GET',
        url: '/api/v1/users/me/organizations/',
        headers: { authorization: `Bearer ${narrow}`, 'x-rekey-user-token': s.accessToken },
      });
      expect(direct.statusCode, direct.body).toBe(200);
      const writer = (
        await op('POST', `/api/v1/tenant/applications/${appId}/api-keys`, {
          name: 'writer',
          mode: 'live',
          scopes: ['auth:write'],
        })
      ).json().data.rawKey as string;
      expect(dataOf(await usersMe(s.accessToken, '?include=organization', writer))).toMatchObject({
        organization: null,
      });
      // A publishable key carries no scopes and is pre-authorised, as on /billing/entitlements.
      expect(dataOf(await usersMe(s.accessToken, '?include=entitlements', publicKey))).toHaveProperty('entitlements');
    });
  });

  // -------------------------------------------------------------------------
  // OpenAPI + serialisation
  // -------------------------------------------------------------------------

  describe('the published contract', () => {
    /** OpenAPI 3.0 `nullable` → JSON Schema, so a stock validator can read it. */
    function toJsonSchema(node: unknown): unknown {
      if (Array.isArray(node)) return node.map(toJsonSchema);
      if (node === null || typeof node !== 'object') return node;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'nullable' || k === 'example') continue;
        out[k] = toJsonSchema(v);
      }
      const n = node as Record<string, unknown>;
      if (n.nullable === true) {
        if (typeof n.type === 'string') return { ...out, type: [n.type, 'null'] };
        return { anyOf: [{ type: 'null' }, out] };
      }
      return out;
    }

    it('declares the parameter and every included property, and a full response validates against it', async () => {
      const doc = (await SwaggerParser.dereference(structuredClone(app.swagger()) as never)) as unknown as {
        paths: Record<string, Record<string, { parameters?: Array<{ name: string; in: string }>; responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
      };
      // Org-billed, since only an org-billed Application's checkout can
      // produce a subscription whose beneficiary is an organization.
      const cfg = await op('PATCH', `/api/v1/tenant/applications/${appId}/billing-config`, { billingSubject: 'org' });
      expect(cfg.statusCode, cfg.body).toBe(200);
      const planId = await richPlan();
      const u = await signUp('contract@example.com');
      const orgId = await makeOrg(u.endUser.id, 'contract');
      await subscribe(u.endUser.id, planId, orgId);
      const s = await signIn('contract@example.com', 'fp-contract-0001');
      const acting = await switchTo(s.accessToken, orgId);
      const all = '?include=entitlements,device,subscription,organization,licenses';

      for (const [path, res] of [
        ['/api/v1/auth/me', await authMe(acting.accessToken, all)],
        ['/api/v1/users/me', await usersMe(acting.accessToken, all)],
      ] as const) {
        const get = doc.paths[path]!.get!;
        expect(get.parameters?.some((p) => p.name === 'include' && p.in === 'query')).toBe(true);
        const schema = get.responses['200']!.content['application/json']!.schema;
        const text = JSON.stringify(schema);
        for (const key of ['entitlements', 'device', 'subscription', 'organization', 'licenses']) {
          expect(text).toContain(`"${key}"`);
        }

        // On the wire, after Fastify's serialiser: every property survives.
        const body = res.json() as { data: Record<string, unknown> };
        expect(res.statusCode).toBe(200);
        expect(body.data.entitlements).toMatchObject({ creditBalance: 500 });
        expect(body.data.device).toMatchObject({ status: 'ACTIVE' });
        expect(body.data.subscription).toMatchObject({ status: 'ACTIVE' });
        expect(body.data.organization).toMatchObject({ id: orgId });
        expect(body.data.licenses).toMatchObject({
          items: [{ organizationId: orgId, status: 'ACTIVE' }],
          truncated: false,
        });

        const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
        const validate = ajv.compile(toJsonSchema(schema) as object);
        expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
        // And the validator is not vacuous: a wrong shape in an included value fails it.
        const broken = structuredClone(body);
        (broken.data.device as Record<string, unknown>).status = 'GONE';
        (broken.data.entitlements as Record<string, unknown>).creditBalance = 'lots';
        expect(validate(broken)).toBe(false);
        const brokenLicence = structuredClone(body);
        (brokenLicence.data.licenses as { items: Array<Record<string, unknown>> }).items[0]!.kind = 'FOREVER';
        expect(validate(brokenLicence)).toBe(false);
      }
    });
  });
});
