/**
 * The signed-in user's read surface (docs/specs/auth-me-include.md, gaps 4, 5,
 * 6, 9 and 11).
 *
 *   - GET /users/me/licenses and `include=licenses`: the caller's own licences,
 *     plus the active organization's where the Application bills
 *     organizations, with no key material and no operator notes.
 *   - GET /billing/plans carries `checkout.ready` and nothing more, from the
 *     same readiness pass the operator list uses, in a constant number of
 *     queries.
 *   - Reading your own sessions, passkeys, MFA status, linked identities and
 *     organizations needs `auth:read`; every change still needs `auth:write`.
 *     Every route in those plugins is enumerated from the live document.
 *   - GET /billing/entitlements/features/:key (and the for-user variant)
 *     answers one feature for the subject `include=entitlements` resolves.
 *   - PATCH /users/me returns what GET returns.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';
import { countQueries } from './query-counter.js';

const PASSWORD = 'pw-one-two-three';

const END_USER_LICENSE_KEYS = [
  'id',
  'applicationId',
  'endUserId',
  'organizationId',
  'planId',
  'kind',
  'status',
  'keyPrefix',
  'entitlementKey',
  'expiresAt',
  'seatsAllowed',
  'createdAt',
  'updatedAt',
  'revokedAt',
];

interface Session {
  accessToken: string;
  refreshToken: string;
  deviceId: string | null;
  endUser: { id: string };
}

type Res = { statusCode: number; body: string; json: () => unknown };

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
    if (Array.isArray(n.enum)) return { anyOf: [{ type: 'null' }, out] };
    if (typeof n.type === 'string') return { ...out, type: [n.type, 'null'] };
    return { anyOf: [{ type: 'null' }, out] };
  }
  return out;
}

describe("the signed-in user's read surface", () => {
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
      name: 'SR',
      slug: `sr-${slug}`,
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

  async function mintKey(scopes: string[]): Promise<string> {
    const r = await op('POST', `/api/v1/tenant/applications/${appId}/api-keys`, {
      name: scopes.join('+'),
      mode: 'live',
      scopes,
    });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json().data as { rawKey: string }).rawKey;
  }

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    operator = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `sr-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const made = await makeApplication({ billing: true });
    appId = made.id;
    publicKey = made.publicKey;
    secretKey = made.key;
  });

  const secret = (key = secretKey) => ({ authorization: `Bearer ${key}` });

  async function signUp(email: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: secret(),
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().data as Session;
  }

  async function signIn(email: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: secret(),
      payload: { email, password: PASSWORD },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data as Session;
  }

  const asUser = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, token: string, key = secretKey, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...secret(key), 'x-rekey-user-token': token },
      ...(payload !== undefined && { payload: payload as never }),
    });

  const authMe = (token: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/auth/me${query}`, headers: { 'x-rekey-user-token': token } });

  const dataOf = (res: Res) => {
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { data: Record<string, unknown> }).data;
  };

  async function orgBilled(): Promise<void> {
    const cfg = await op('PATCH', `/api/v1/tenant/applications/${appId}/billing-config`, { billingSubject: 'org' });
    expect(cfg.statusCode, cfg.body).toBe(200);
  }

  async function plan(slug: string, entitlements: unknown[]): Promise<string> {
    const created = await op('POST', `/api/v1/tenant/applications/${appId}/plans`, {
      slug,
      name: slug,
      amount: 0,
      kind: 'SUBSCRIPTION',
    });
    expect(created.statusCode, created.body).toBe(201);
    for (const payload of entitlements) {
      const put = await op('PUT', `/api/v1/tenant/applications/${appId}/plans/${slug}/entitlements`, payload);
      expect(put.statusCode, put.body).toBe(200);
    }
    return (await prisma.plan.findFirstOrThrow({ where: { applicationId: appId, slug } })).id;
  }

  const licencePlan = (slug: string) =>
    plan(slug, [
      { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' },
      { kind: 'LICENSE', licenseKind: 'PERPETUAL' },
    ]);

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
    const r = await op('POST', `/api/v1/tenant/applications/${appId}/organizations`, { name: slug, slug, ownerEndUserId });
    expect(r.statusCode, r.body).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  async function addMember(orgId: string, endUserId: string): Promise<void> {
    const r = await op('POST', `/api/v1/tenant/applications/${appId}/organizations/${orgId}/members`, {
      endUserId,
      role: 'MEMBER',
    });
    expect(r.statusCode, r.body).toBe(201);
  }

  async function switchTo(token: string, orgId: string): Promise<Session> {
    return dataOf(await asUser('POST', `/api/v1/users/me/organizations/${orgId}/switch`, token)) as unknown as Session;
  }

  async function issue(endUserId: string, extra: { metadata?: Record<string, unknown>; organizationId?: string } = {}) {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: endUserId } });
    return licensesService.issue({ application, endUser, kind: 'PERPETUAL', ...extra });
  }

  const myLicences = (token: string, query = '', key = secretKey) =>
    asUser('GET', `/api/v1/users/me/licenses/${query}`, token, key);

  const ids = (items: unknown) => (items as Array<{ id: string }>).map((l) => l.id);

  // -------------------------------------------------------------------------
  // Gap 4: licences for self
  // -------------------------------------------------------------------------

  describe('GET /users/me/licenses', () => {
    it("lists the caller's own licences, newest first, without key material or operator notes", async () => {
      const alice = await signUp('alice@example.com');
      const bob = await signUp('bob@example.com');
      const first = await issue(alice.endUser.id, { metadata: { note: 'operator-only-note' } });
      const second = await issue(alice.endUser.id);
      await issue(bob.endUser.id);
      // Another Application's licence for an end-user with the same email.
      const other = await makeApplication({ billing: true });
      const foreignUser = await prisma.endUser.create({ data: { applicationId: other.id, email: 'alice@example.com' } });
      await licensesService.issue({
        application: await prisma.application.findUniqueOrThrow({ where: { id: other.id } }),
        endUser: foreignUser,
        kind: 'PERPETUAL',
      });

      for (const key of [secretKey, publicKey]) {
        const res = await myLicences(alice.accessToken, '', key);
        const data = dataOf(res) as { items: Array<Record<string, unknown>>; page: { total: number } };
        expect(ids(data.items)).toEqual([second.license.id, first.license.id]);
        expect(data.page.total).toBe(2);
        for (const item of data.items) {
          expect(Object.keys(item).sort()).toEqual([...END_USER_LICENSE_KEYS].sort());
          expect(item.endUserId).toBe(alice.endUser.id);
        }
        expect(data.items[1]).toMatchObject({ keyPrefix: first.license.keyPrefix, status: 'ACTIVE', kind: 'PERPETUAL' });
        // Neither the raw key, its hash, nor the operator's notes reach the holder.
        const row = await prisma.license.findUniqueOrThrow({ where: { id: first.license.id } });
        expect(res.body).not.toContain(first.rawKey);
        expect(res.body).not.toContain(row.keyHash);
        expect(res.body).not.toContain('operator-only-note');
      }

      const paged = dataOf(await myLicences(alice.accessToken, '?limit=1&offset=1')) as {
        items: unknown[];
        page: { hasMore: boolean; total: number };
      };
      expect(ids(paged.items)).toEqual([first.license.id]);
      expect(paged.page).toMatchObject({ total: 2, hasMore: false });
      const tooMany = await myLicences(alice.accessToken, '?limit=101');
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().error.code).toBe('BAD_REQUEST');
    });

    it("in an org-billed Application, adds the active organization's pooled licences for a member", async () => {
      await orgBilled();
      const planId = await licencePlan('team');
      const owner = await signUp('owner@example.com');
      const member = await signUp('member@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'acme');
      await addMember(orgId, member.endUser.id);
      await subscribe(owner.endUser.id, planId, orgId);
      const pooled = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, organizationId: orgId } });
      const own = await issue(member.endUser.id);

      // Personal session: only the member's own licence.
      expect(ids((dataOf(await myLicences(member.accessToken)) as { items: unknown }).items)).toEqual([own.license.id]);

      // Acting for the organization: the pool too, whoever bought it.
      const acting = await switchTo(member.accessToken, orgId);
      const data = dataOf(await myLicences(acting.accessToken)) as { items: Array<{ id: string; organizationId: string | null }> };
      expect(new Set(ids(data.items))).toEqual(new Set([own.license.id, pooled.id]));
      expect(data.items.find((l) => l.id === pooled.id)?.organizationId).toBe(orgId);

      // Membership lapses: the pool is gone again, as the entitlements subject degrades.
      await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId, endUserId: member.endUser.id } });
      expect(ids((dataOf(await myLicences(acting.accessToken)) as { items: unknown }).items)).toEqual([own.license.id]);
    });

    it('in a USER-billed Application an organization session still lists only personal licences', async () => {
      const planId = await licencePlan('team');
      const owner = await signUp('owner2@example.com');
      const member = await signUp('member2@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'userbilled');
      await addMember(orgId, member.endUser.id);
      await subscribe(owner.endUser.id, planId, orgId);
      expect(await prisma.license.count({ where: { applicationId: appId, organizationId: orgId } })).toBe(1);

      const acting = await switchTo(member.accessToken, orgId);
      expect((dataOf(await myLicences(acting.accessToken)) as { items: unknown[] }).items).toEqual([]);
    });

    it('?organizationId= adds that organization\'s pool for a member, and is 403 for anyone else', async () => {
      await orgBilled();
      const planId = await licencePlan('team');
      const owner = await signUp('exp-owner@example.com');
      const member = await signUp('exp-member@example.com');
      const outsider = await signUp('exp-outsider@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'explicit');
      await addMember(orgId, member.endUser.id);
      await subscribe(owner.endUser.id, planId, orgId);
      const pooled = await prisma.license.findFirstOrThrow({ where: { applicationId: appId, organizationId: orgId } });
      const own = await issue(member.endUser.id);

      // A personal session, no switch: the explicit id alone brings the pool in.
      const data = dataOf(await myLicences(member.accessToken, `?organizationId=${orgId}`)) as { items: unknown };
      expect(new Set(ids(data.items))).toEqual(new Set([own.license.id, pooled.id]));
      // Paging still applies alongside it.
      const paged = dataOf(await myLicences(member.accessToken, `?organizationId=${orgId}&limit=1`)) as {
        items: unknown[];
        page: { total: number };
      };
      expect(paged.items).toHaveLength(1);
      expect(paged.page.total).toBe(2);

      for (const key of [secretKey, publicKey]) {
        const refused = await myLicences(outsider.accessToken, `?organizationId=${orgId}`, key);
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
      }
    });

    it('include=licenses equals the dedicated route on /auth/me and /users/me', async () => {
      await orgBilled();
      const planId = await licencePlan('team');
      const owner = await signUp('inc-owner@example.com');
      const member = await signUp('inc-member@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'inc');
      await addMember(orgId, member.endUser.id);
      await subscribe(owner.endUser.id, planId, orgId);
      await issue(member.endUser.id);
      const acting = await switchTo(member.accessToken, orgId);

      const dedicated = (dataOf(await myLicences(acting.accessToken)) as { items: unknown[] }).items;
      expect(dedicated).toHaveLength(2);
      for (const res of [
        await authMe(acting.accessToken, '?include=licenses'),
        await asUser('GET', '/api/v1/users/me/?include=licenses', acting.accessToken),
        await asUser('GET', '/api/v1/users/me/?include=licenses', acting.accessToken, publicKey),
      ]) {
        const data = dataOf(res);
        expect(data.licenses).toEqual({ items: dedicated, truncated: false });
        expect(Object.keys(data).at(-1)).toBe('licenses');
      }
      // A caller with no licences reads an empty list, not null.
      const none = await signUp('none@example.com');
      expect(dataOf(await authMe(none.accessToken, '?include=licenses')).licenses).toEqual({
        items: [],
        truncated: false,
      });
    });

    it('include=licenses says when it stopped at 100 rather than cutting the list silently', async () => {
      const u = await signUp('many@example.com');
      const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: u.endUser.id } });
      await prisma.license.createMany({
        data: Array.from({ length: 101 }, (_, i) => ({
          applicationId: appId,
          endUserId: endUser.id,
          kind: 'PERPETUAL' as const,
          keyPrefix: `rl_lic_${i}`,
          keyHash: `hash-many-${i}-${appId}`,
        })),
      });
      const included = dataOf(await authMe(u.accessToken, '?include=licenses')).licenses as {
        items: unknown[];
        truncated: boolean;
      };
      expect(included.items).toHaveLength(100);
      expect(included.truncated).toBe(true);
      const page = dataOf(await myLicences(u.accessToken, '?limit=1')) as { page: { total: number } };
      expect(page.page.total).toBe(101);
    });

    it('gates: billing off is 403 BILLING_DISABLED, and a secret key needs billing:read', async () => {
      const u = await signUp('gate@example.com');
      const authRead = await mintKey(['auth:read']);
      const billingRead = await mintKey(['billing:read']);
      const both = await mintKey(['auth:read', 'billing:read']);

      for (const res of [
        await myLicences(u.accessToken, '', authRead),
        await asUser('GET', '/api/v1/users/me/?include=licenses', u.accessToken, authRead),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      }
      expect(dataOf(await myLicences(u.accessToken, '', billingRead))).toMatchObject({ items: [] });
      expect(dataOf(await asUser('GET', '/api/v1/users/me/?include=licenses', u.accessToken, both))).toMatchObject({
        licenses: { items: [], truncated: false },
      });

      const off = await makeApplication({ billing: false });
      appId = off.id;
      secretKey = off.key;
      const v = await signUp('off@example.com');
      for (const res of [
        await myLicences(v.accessToken),
        await authMe(v.accessToken, '?include=licenses'),
        await asUser('GET', '/api/v1/users/me/?include=licenses', v.accessToken),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('BILLING_DISABLED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Gap 5: checkout readiness on the public plan list
  // -------------------------------------------------------------------------

  describe('GET /billing/plans checkout readiness', () => {
    const publicPlans = (key = publicKey) =>
      app.inject({ method: 'GET', url: '/api/v1/billing/plans', headers: secret(key) });
    const operatorPlans = () => op('GET', `/api/v1/tenant/applications/${appId}/plans`);

    type Listed = { items: Array<{ slug: string; checkout: Record<string, unknown> }> };
    const bySlug = (data: unknown) =>
      Object.fromEntries((data as Listed).items.map((p) => [p.slug, p.checkout]));

    async function stripeConnected(): Promise<void> {
      await prisma.billingCredentials.create({
        data: { applicationId: appId, provider: 'stripe', ciphertext: 'not-read-by-readiness' },
      });
    }

    it('carries checkout.ready only, and agrees with the operator list plan for plan', async () => {
      await plan('registered', []);
      await plan('unregistered', []);
      // Plans created before the provider was connected were never registered;
      // mark one as registered the way a successful registration leaves it.
      await prisma.plan.updateMany({
        where: { applicationId: appId, slug: 'registered' },
        data: { registrationStatus: 'REGISTERED', metadata: { stripe: { priceId: 'price_test_1' } } },
      });
      await stripeConnected();

      const operatorView = bySlug(dataOf(await operatorPlans()));
      expect(operatorView.registered).toEqual({ ready: true, blockers: [] });
      expect(operatorView.unregistered).toMatchObject({
        ready: false,
        blockers: [{ provider: 'stripe', code: 'PLAN_NOT_REGISTERED' }],
      });

      for (const key of [publicKey, secretKey]) {
        const res = await publicPlans(key);
        expect(bySlug(dataOf(res))).toEqual({ registered: { ready: true }, unregistered: { ready: false } });
        // No blocker detail, provider name or repair text on the public surface.
        expect(res.body).not.toContain('blockers');
        expect(res.body).not.toContain('PLAN_NOT_REGISTERED');
        expect(res.body).not.toContain('/register');
      }
    });

    it('an inbound-only provider beside a real one does not make every plan unbuyable', async () => {
      await plan('registered', []);
      await prisma.plan.updateMany({
        where: { applicationId: appId, slug: 'registered' },
        data: { registrationStatus: 'REGISTERED', metadata: { stripe: { priceId: 'price_test_2' } } },
      });
      await stripeConnected();
      expect(bySlug(dataOf(await publicPlans()))).toEqual({ registered: { ready: true } });

      // The external billing system posts events and hosts no checkout; buyers
      // are never routed to it, so it has no say in whether they can buy.
      await prisma.billingCredentials.create({
        data: { applicationId: appId, provider: 'external', ciphertext: 'not-read-by-readiness' },
      });
      expect(bySlug(dataOf(await publicPlans()))).toEqual({ registered: { ready: true } });
      expect(bySlug(dataOf(await operatorPlans())).registered).toEqual({ ready: true, blockers: [] });

      // With nothing else enabled it is the reason nothing can be bought.
      await prisma.billingCredentials.deleteMany({ where: { applicationId: appId, provider: 'stripe' } });
      expect(bySlug(dataOf(await publicPlans()))).toEqual({ registered: { ready: false } });
      expect(bySlug(dataOf(await operatorPlans())).registered).toMatchObject({
        ready: false,
        blockers: [{ provider: 'external', code: 'PROVIDER_INBOUND_ONLY' }],
      });
    });

    it('an Application with no provider reads ready: false without saying why', async () => {
      await plan('pro', []);
      expect(bySlug(dataOf(await operatorPlans())).pro).toMatchObject({
        ready: false,
        blockers: [{ provider: null, code: 'NO_BILLING_PROVIDER' }],
      });
      const res = await publicPlans();
      expect(bySlug(dataOf(res))).toEqual({ pro: { ready: false } });
      expect(res.body).not.toContain('NO_BILLING_PROVIDER');
    });

    it('costs one extra query per page, however many plans are on it', async () => {
      await stripeConnected();
      await plan('p0', []);
      await publicPlans();
      const one = await countQueries(() => publicPlans());
      for (let i = 1; i <= 5; i++) await plan(`p${i}`, []);
      const six = await countQueries(() => publicPlans());
      expect((dataOf(await publicPlans()) as Listed).items).toHaveLength(6);
      expect(six.count, six.queries.join('\n')).toBe(one.count);
      expect(six.queries.filter((q) => q.includes('FROM "public"."billing_credentials"'))).toHaveLength(1);
    });

    it('the published schema declares checkout.ready, and a real response validates against it', async () => {
      await plan('pro', []);
      await stripeConnected();
      const doc = (await SwaggerParser.dereference(structuredClone(app.swagger()) as never)) as unknown as {
        paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
      };
      const schema = doc.paths['/api/v1/billing/plans']!.get!.responses['200']!.content['application/json']!.schema;
      const body = (await publicPlans()).json();
      const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
      const validate = ajv.compile(toJsonSchema(schema) as object);
      expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
      const broken = structuredClone(body) as { data: { items: Array<{ checkout: unknown }> } };
      broken.data.items[0]!.checkout = {};
      expect(validate(broken)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 6: auth:read on GET routes
  // -------------------------------------------------------------------------

  describe('auth:read reads your own account; auth:write is still needed to change it', () => {
    /**
     * Every route in the session-bound auth plugins, keyed as the published
     * document names it. The completeness test below fails when one is added
     * without being classified here.
     */
    const ROUTES: Record<string, 'read' | 'write'> = {
      'POST /api/v1/auth/change-password': 'write',
      'POST /api/v1/auth/send-verification': 'write',
      'POST /api/v1/auth/passkey/register/start': 'write',
      'POST /api/v1/auth/passkey/register/complete': 'write',
      'GET /api/v1/auth/passkeys': 'read',
      'DELETE /api/v1/auth/passkeys/{id}': 'write',
      'GET /api/v1/auth/sessions': 'read',
      'DELETE /api/v1/auth/sessions/{id}': 'write',
      'POST /api/v1/auth/sign-out-everywhere': 'write',
      'GET /api/v1/auth/mfa/status': 'read',
      'POST /api/v1/auth/mfa/setup': 'write',
      'POST /api/v1/auth/mfa/setup-confirm': 'write',
      'POST /api/v1/auth/mfa/challenge': 'write',
      'POST /api/v1/auth/mfa/disable': 'write',
      'GET /api/v1/auth/oauth/identities': 'read',
      'POST /api/v1/auth/oauth/{provider}/link/start': 'write',
      'POST /api/v1/auth/oauth/{provider}/link/complete': 'write',
      'DELETE /api/v1/auth/oauth/{provider}': 'write',
      'POST /api/v1/users/me/organizations': 'write',
      'GET /api/v1/users/me/organizations': 'read',
      'GET /api/v1/users/me/organizations/roles': 'read',
      'GET /api/v1/users/me/organizations/{id}': 'read',
      'PATCH /api/v1/users/me/organizations/{id}': 'write',
      'GET /api/v1/users/me/organizations/{id}/members': 'read',
      'POST /api/v1/users/me/organizations/{id}/invitations': 'write',
      'POST /api/v1/users/me/organizations/{id}/invitations/{invId}/revoke': 'write',
      'PATCH /api/v1/users/me/organizations/{id}/members/{euid}': 'write',
      'DELETE /api/v1/users/me/organizations/{id}/members/{euid}': 'write',
      'POST /api/v1/users/me/organizations/{id}/leave': 'write',
      'POST /api/v1/users/me/organizations/{id}/switch': 'write',
      'POST /api/v1/users/me/organizations/clear-active-organization': 'write',
      'POST /api/v1/auth/organizations/accept-invitation': 'write',
    };

    const PLUGIN_PREFIXES = ['/api/v1/auth/', '/api/v1/users/me/organizations'];

    it('classifies every session-bound route under /auth and /users/me/organizations', () => {
      const doc = app.swagger() as {
        paths: Record<string, Record<string, { security?: Array<Record<string, unknown>> }>>;
      };
      const live: string[] = [];
      for (const [path, ops] of Object.entries(doc.paths)) {
        if (!PLUGIN_PREFIXES.some((p) => path.startsWith(p))) continue;
        for (const [method, operation] of Object.entries(ops)) {
          // A key AND the user token: the key-plus-session plugins, not the
          // token-only /auth/me nor the pre-session bootstrap routes.
          const sessionBound = (operation.security ?? []).some(
            (s) => 'userToken' in s && ('apiKey' in s || 'publishableKey' in s),
          );
          if (sessionBound) live.push(`${method.toUpperCase()} ${path}`);
        }
      }
      expect(live.sort()).toEqual(Object.keys(ROUTES).sort());
    });

    it('every GET answers an auth:read key; every other method refuses it and admits auth:write', async () => {
      const readKey = await mintKey(['auth:read']);
      const writeKey = await mintKey(['auth:write']);
      const u = await signUp('scopes@example.com');
      const orgId = await makeOrg(u.endUser.id, 'scopes');
      const concrete = (path: string, real: boolean) =>
        path
          .replace('{id}', real ? orgId : 'org_missing')
          .replace('{provider}', 'github')
          .replace('{invId}', 'inv_missing')
          .replace('{euid}', 'eu_missing');

      const routes = Object.entries(ROUTES).map(([route, kind]) => {
        const [method, path] = route.split(' ') as ['GET' | 'POST' | 'PATCH' | 'DELETE', string];
        return { route, kind, method, path };
      });
      // Reads first: some writes below (sign-out-everywhere) end every session.
      const reads = routes.filter((r) => r.kind === 'read');
      expect(reads).toHaveLength(8);
      for (const { route, method, path } of reads) {
        for (const key of [readKey, writeKey]) {
          const res = await asUser(method, concrete(path, true), u.accessToken, key);
          expect(res.statusCode, `${route}: ${res.body}`).toBe(200);
        }
      }
      for (const { route, method, path } of routes.filter((r) => r.kind === 'write')) {
        const refused = await asUser(method, concrete(path, false), u.accessToken, readKey, {});
        expect(refused.statusCode, route).toBe(403);
        expect(refused.json().error.code, route).toBe('API_KEY_SCOPE_INSUFFICIENT');
        expect(refused.json().error.message, route).toContain('"auth:write"');

        // Past the scope with auth:write. A fresh session each time, since some of
        // these (sign-out-everywhere) end every session they can reach.
        const fresh = await signIn('scopes@example.com');
        const admitted = await asUser(method, concrete(path, false), fresh.accessToken, writeKey, {});
        expect((admitted.json() as { error?: { code: string } }).error?.code, `${route}: ${admitted.body}`).not.toBe(
          'API_KEY_SCOPE_INSUFFICIENT',
        );
      }
    });

    it('include=organization on /users/me stays in step with GET /users/me/organizations/:id: auth:read is enough', async () => {
      const readKey = await mintKey(['auth:read']);
      const u = await signUp('inc-org@example.com');
      const orgId = await makeOrg(u.endUser.id, 'incorg');
      const acting = await switchTo(u.accessToken, orgId);
      const direct = dataOf(await asUser('GET', `/api/v1/users/me/organizations/${orgId}`, acting.accessToken, readKey));
      const included = dataOf(await asUser('GET', '/api/v1/users/me/?include=organization', acting.accessToken, readKey));
      expect(included.organization).toEqual(direct);
    });
  });

  // -------------------------------------------------------------------------
  // Gap 9: single-feature check
  // -------------------------------------------------------------------------

  describe('GET /billing/entitlements/features/:key', () => {
    const feature = (token: string, key: string, query = '', apiKey = secretKey) =>
      asUser('GET', `/api/v1/billing/entitlements/features/${encodeURIComponent(key)}${query}`, token, apiKey);
    const featureFor = (endUserId: string, key: string, extra = '', apiKey = secretKey) =>
      app.inject({
        method: 'GET',
        url: `/api/v1/billing/entitlements/for-user/features/${encodeURIComponent(key)}?endUserId=${endUserId}${extra}`,
        headers: secret(apiKey),
      });

    const FLAGS = [
      { kind: 'FEATURE', key: 'reports', valueType: 'BOOL', value: 'true' },
      { kind: 'FEATURE', key: 'projects', valueType: 'INT', value: '5' },
      { kind: 'FEATURE', key: 'tier', valueType: 'STRING', value: 'gold' },
      { kind: 'FEATURE', key: 'beta', valueType: 'BOOL', value: 'false' },
      { kind: 'FEATURE', key: 'seats', valueType: 'INT', value: '0' },
      { kind: 'CREDIT', quantity: 50 },
    ];

    it('answers each key with the value GET /billing/entitlements holds for it', async () => {
      const planId = await plan('pro', FLAGS);
      const u = await signUp('feat@example.com');
      await subscribe(u.endUser.id, planId);
      const { features } = dataOf(await asUser('GET', '/api/v1/billing/entitlements', u.accessToken)) as {
        features: Record<string, unknown>;
      };
      expect(features).toEqual({ reports: true, projects: 5, tier: 'gold', beta: false, seats: 0 });

      const expected: Record<string, { granted: boolean; value: unknown }> = {
        reports: { granted: true, value: true },
        projects: { granted: true, value: 5 },
        tier: { granted: true, value: 'gold' },
        beta: { granted: false, value: false },
        seats: { granted: false, value: 0 },
        nope: { granted: false, value: null },
        // Not an own property of the feature map, whatever the prototype says.
        constructor: { granted: false, value: null },
      };
      for (const [key, want] of Object.entries(expected)) {
        for (const apiKey of [secretKey, publicKey]) {
          expect(dataOf(await feature(u.accessToken, key, '', apiKey)), key).toEqual({ key, ...want });
        }
        expect(dataOf(await featureFor(u.endUser.id, key)), key).toEqual({ key, ...want });
      }
    });

    it('resolves the subject include=entitlements resolves, in both kinds of Application', async () => {
      // Org-billed: the organization's features while acting for it.
      await orgBilled();
      const teamPlan = await plan('team', [{ kind: 'FEATURE', key: 'sso', valueType: 'BOOL', value: 'true' }]);
      const owner = await signUp('fo@example.com');
      const member = await signUp('fm@example.com');
      const orgId = await makeOrg(owner.endUser.id, 'fteam');
      await addMember(orgId, member.endUser.id);
      await subscribe(owner.endUser.id, teamPlan, orgId);
      const acting = await switchTo(member.accessToken, orgId);
      const viaInclude = dataOf(await authMe(acting.accessToken, '?include=entitlements')).entitlements as {
        features: Record<string, unknown>;
      };
      expect(viaInclude.features).toEqual({ sso: true });
      expect(dataOf(await feature(acting.accessToken, 'sso'))).toEqual({ key: 'sso', granted: true, value: true });
      expect(dataOf(await featureFor(member.endUser.id, 'sso', `&organizationId=${orgId}`))).toMatchObject({ granted: true });

      // The explicit organization is member-only.
      const outsider = await signUp('fx@example.com');
      const refused = await feature(outsider.accessToken, 'sso', `?organizationId=${orgId}`);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('ORGANIZATION_NOT_MEMBER');
      const refusedFor = await featureFor(outsider.endUser.id, 'sso', `&organizationId=${orgId}`);
      expect(refusedFor.statusCode).toBe(403);
      expect(dataOf(await feature(member.accessToken, 'sso', `?organizationId=${orgId}`))).toMatchObject({ granted: true });
    });

    it('in a user-billed Application an organization session reads the personal plan, as the include does', async () => {
      const personal = await plan('solo', [{ kind: 'FEATURE', key: 'export', valueType: 'BOOL', value: 'true' }]);
      const u = await signUp('fu@example.com');
      await subscribe(u.endUser.id, personal);
      const orgId = await makeOrg(u.endUser.id, 'fsolo');
      const acting = await switchTo(u.accessToken, orgId);
      const viaInclude = dataOf(await authMe(acting.accessToken, '?include=entitlements')).entitlements as {
        features: Record<string, unknown>;
      };
      expect(viaInclude.features).toEqual({ export: true });
      expect(dataOf(await feature(acting.accessToken, 'export'))).toEqual({ key: 'export', granted: true, value: true });
      // GET /billing/entitlements resolves the same subject: it read the team's
      // empty view here, `features: {}`, for a user paying for `export`.
      for (const key of [secretKey, publicKey]) {
        const direct = dataOf(await asUser('GET', '/api/v1/billing/entitlements', acting.accessToken, key));
        expect(direct).toEqual(viaInclude);
      }
      // An explicit organization is still that organization's view.
      const explicit = dataOf(
        await asUser('GET', `/api/v1/billing/entitlements?organizationId=${orgId}`, acting.accessToken),
      ) as { features: Record<string, unknown> };
      expect(explicit.features).toEqual({});
    });

    it('skips the credit balance read the full call makes', async () => {
      const planId = await plan('pro', FLAGS);
      const u = await signUp('fq@example.com');
      await subscribe(u.endUser.id, planId);
      await feature(u.accessToken, 'reports');
      const full = await countQueries(() => asUser('GET', '/api/v1/billing/entitlements', u.accessToken));
      const one = await countQueries(() => feature(u.accessToken, 'reports'));
      expect(one.count, one.queries.join('\n')).toBe(full.count - 1);
    });

    it('gates: secret key only on for-user, billing:read, a real end-user, a bounded key', async () => {
      const u = await signUp('fg@example.com');
      const authRead = await mintKey(['auth:read']);
      for (const res of [await feature(u.accessToken, 'x', '', authRead), await featureFor(u.endUser.id, 'x', '', authRead)]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('API_KEY_SCOPE_INSUFFICIENT');
      }
      expect((await featureFor(u.endUser.id, 'x', '', publicKey)).statusCode).toBe(401);

      const other = await makeApplication({ billing: true });
      const foreign = await prisma.endUser.create({ data: { applicationId: other.id, email: 'fg@example.com' } });
      const missing = await featureFor(foreign.id, 'x');
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('END_USER_NOT_FOUND');

      const long = await feature(u.accessToken, 'k'.repeat(81));
      expect(long.statusCode).toBe(400);
      expect(long.json().error.code).toBe('BAD_REQUEST');
    });

    it('the published schema matches the wire, for every value type', async () => {
      const planId = await plan('pro', FLAGS);
      const u = await signUp('fs@example.com');
      await subscribe(u.endUser.id, planId);
      const doc = (await SwaggerParser.dereference(structuredClone(app.swagger()) as never)) as unknown as {
        paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: unknown }> }> }>>;
      };
      for (const path of [
        '/api/v1/billing/entitlements/features/{key}',
        '/api/v1/billing/entitlements/for-user/features/{key}',
      ]) {
        const schema = doc.paths[path]!.get!.responses['200']!.content['application/json']!.schema;
        const validate = new Ajv({ strict: false, validateFormats: false }).compile(toJsonSchema(schema) as object);
        for (const key of ['reports', 'projects', 'tier', 'nope']) {
          const body = (await feature(u.accessToken, key)).json();
          expect(validate(body), `${path} ${key}: ${JSON.stringify(validate.errors)}`).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Gap 11: PATCH /users/me returns what GET returns
  // -------------------------------------------------------------------------

  describe('PATCH /users/me', () => {
    it('returns the GET shape, active organization role fields included, on the wire', async () => {
      const u = await signUp('patch@example.com');
      const orgId = await makeOrg(u.endUser.id, 'patchorg');
      const acting = await switchTo(u.accessToken, orgId);

      for (const token of [u.accessToken, acting.accessToken]) {
        const patched = await asUser('PATCH', '/api/v1/users/me/', token, secretKey, { metadata: { theme: 'dark' } });
        const got = await asUser('GET', '/api/v1/users/me/', token);
        const patchedData = dataOf(patched);
        const gotData = dataOf(got);
        expect(Object.keys(patchedData)).toEqual(Object.keys(gotData));
        expect(patchedData).toEqual(gotData);
        expect(patchedData).toHaveProperty('activeOrganizationRole');
        expect(patchedData).toHaveProperty('activeOrganizationBaseRole');
      }
      const patched = dataOf(
        await asUser('PATCH', '/api/v1/users/me/', acting.accessToken, publicKey, { metadata: { a: 1 } }),
      );
      expect(patched).toMatchObject({
        activeOrganizationId: orgId,
        activeOrganizationRole: 'OWNER',
        activeOrganizationBaseRole: 'OWNER',
        metadata: { theme: 'dark', a: 1 },
      });
    });
  });
});
