/**
 * Per-application team permissions (roadmap #8) — `ApplicationGrant`.
 *
 * Covers:
 *   - legacy MEMBER (zero grants) keeps workspace-wide READ access + 403 on writes
 *   - a granted MEMBER sees ONLY granted apps in the list / 404 elsewhere
 *   - APP_VIEWER: read-only (writes → 403 APP_ACCESS_DENIED)
 *   - APP_BILLING: can create coupons/plans, cannot mint API keys, cannot
 *     see (redacted) or write auth config
 *   - APP_ADMIN: full read/write on the granted app, 404 on others
 *   - OWNER/ADMIN: unaffected by grants
 *   - grants CRUD is OWNER/ADMIN-gated and MEMBER-membership-only
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

interface Session {
  accessToken: string;
}

describe('per-application grants (ApplicationGrant)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  // The global rate limit is per-IP (100/min) and the app instance lives for
  // the whole file — give each bootstrapped scenario its own source address
  // so the suite never trips 429s.
  let currentIp = '10.99.0.1';
  function inject(opts: Record<string, unknown>) {
    return app.inject({ remoteAddress: currentIp, ...opts } as never);
  }

  async function signUp(email: string, workspaceName: string): Promise<Session> {
    const r = await inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return { accessToken: (r.json().data as { accessToken: string }).accessToken };
  }

  /** Owner + two apps + one invited member (role MEMBER unless overridden). */
  async function bootstrap(role: 'MEMBER' | 'ADMIN' = 'MEMBER'): Promise<{
    ownerToken: string;
    memberToken: string;
    membershipId: string;
    appA: string;
    appB: string;
  }> {
    currentIp = `10.99.${++n}.1`;
    const tag = `grants-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const owner = await signUp(`owner-${tag}@example.com`, 'Grants Co');
    const invitee = await signUp(`member-${tag}@example.com`, 'Member Own Co');

    const mkApp = async (suffix: string): Promise<string> => {
      const r = await inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        payload: { name: `App ${suffix}`, slug: `${tag}-${suffix}` },
      });
      expect(r.statusCode).toBe(201);
      return (r.json().data as { id: string }).id;
    };
    const appA = await mkApp('a');
    const appB = await mkApp('b');

    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: `member-${tag}@example.com`, role },
    });
    expect(inv.statusCode).toBe(201);
    const token = (inv.json().data as { token: string }).token;
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${invitee.accessToken}` },
      payload: { token },
    });
    expect(accept.statusCode).toBe(200);
    const memberToken = (accept.json().data as { accessToken: string }).accessToken;

    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    const rows = members.json().data as Array<{ membershipId: string; email: string }>;
    const membershipId = rows.find((m) => m.email === `member-${tag}@example.com`)!.membershipId;

    return { ownerToken: owner.accessToken, memberToken, membershipId, appA, appB };
  }

  function setGrant(
    ownerToken: string,
    membershipId: string,
    applicationId: string,
    role: 'APP_ADMIN' | 'APP_BILLING' | 'APP_VIEWER',
  ) {
    return inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { applicationId, role },
    });
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  // ---------- legacy mode (zero grants) ----------

  it('legacy MEMBER (no grants) keeps read access everywhere, writes stay 403', async () => {
    const { memberToken, appA, appB } = await bootstrap();

    // Reads: list shows both apps, detail works.
    const list = await inject({
      method: 'GET',
      url: '/api/v1/tenant/applications',
      headers: auth(memberToken),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().data as Array<{ id: string }>).map((a) => a.id).sort();
    expect(ids).toEqual([appA, appB].sort());

    const detail = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}`,
      headers: auth(memberToken),
    });
    expect(detail.statusCode).toBe(200);

    const plans = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appB}/plans`,
      headers: auth(memberToken),
    });
    expect(plans.statusCode).toBe(200);

    // Writes: same 403 + code as before grants existed.
    const coupon = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/coupons`,
      headers: auth(memberToken),
      payload: { code: 'NOPE', discountType: 'PERCENT', amountOff: 10 },
    });
    expect(coupon.statusCode).toBe(403);
    expect(coupon.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');

    const key = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/api-keys`,
      headers: auth(memberToken),
      payload: { name: 'k' },
    });
    expect(key.statusCode).toBe(403);
    expect(key.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- grant-scoped visibility ----------

  it('granted MEMBER sees only the granted app in the list; others 404', async () => {
    const { ownerToken, memberToken, membershipId, appA, appB } = await bootstrap();
    expect((await setGrant(ownerToken, membershipId, appA, 'APP_VIEWER')).statusCode).toBe(200);

    const list = await inject({
      method: 'GET',
      url: '/api/v1/tenant/applications',
      headers: auth(memberToken),
    });
    const ids = (list.json().data as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual([appA]);

    // Direct access to the ungranted app: 404, not 403 (non-disclosure).
    const other = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appB}`,
      headers: auth(memberToken),
    });
    expect(other.statusCode).toBe(404);
    expect(other.json().error.code).toBe('APPLICATION_NOT_FOUND');

    // …including its sub-resources (plans, webhooks, email config).
    for (const path of ['plans', 'webhooks', 'email-config']) {
      const r = await inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appB}/${path}`,
        headers: auth(memberToken),
      });
      expect(r.statusCode, path).toBe(404);
    }
  });

  // ---------- APP_VIEWER ----------

  it('APP_VIEWER can read the granted app but every write is 403 APP_ACCESS_DENIED', async () => {
    const { ownerToken, memberToken, membershipId, appA } = await bootstrap();
    await setGrant(ownerToken, membershipId, appA, 'APP_VIEWER');

    for (const path of ['', '/stats', '/plans', '/coupons', '/api-keys', '/end-users', '/webhooks']) {
      const r = await inject({
        method: 'GET',
        url: `/api/v1/tenant/applications/${appA}${path}`,
        headers: auth(memberToken),
      });
      expect(r.statusCode, `GET ${path}`).toBe(200);
    }

    const writes: Array<{ method: 'POST' | 'PATCH' | 'PUT'; path: string; payload: unknown }> = [
      { method: 'POST', path: '/coupons', payload: { code: 'NO', discountType: 'PERCENT', amountOff: 5 } },
      { method: 'POST', path: '/plans', payload: { slug: 'p1', name: 'P1', amount: 100 } },
      { method: 'POST', path: '/api-keys', payload: { name: 'k' } },
      { method: 'PATCH', path: '/auth-config', payload: { signupEnabled: false } },
      { method: 'PUT', path: '/access', payload: { ipAllowlist: [] } },
    ];
    for (const w of writes) {
      const r = await inject({
        method: w.method,
        url: `/api/v1/tenant/applications/${appA}${w.path}`,
        headers: auth(memberToken),
        payload: w.payload as Record<string, unknown>,
      });
      expect(r.statusCode, `${w.method} ${w.path}`).toBe(403);
      expect(r.json().error.code, `${w.method} ${w.path}`).toBe('APP_ACCESS_DENIED');
    }
  });

  // ---------- APP_BILLING ----------

  it('APP_BILLING: coupon + plan writes OK; API keys 403; auth config hidden + locked', async () => {
    const { ownerToken, memberToken, membershipId, appA } = await bootstrap();
    await setGrant(ownerToken, membershipId, appA, 'APP_BILLING');

    // Billing writes allowed.
    const coupon = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/coupons`,
      headers: auth(memberToken),
      payload: { code: 'SAVE10', discountType: 'PERCENT', amountOff: 10 },
    });
    expect(coupon.statusCode).toBe(201);

    const plan = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/plans`,
      headers: auth(memberToken),
      payload: { slug: 'pro', name: 'Pro', amount: 999 },
    });
    expect(plan.statusCode).toBe(201);

    // Non-billing writes denied.
    const key = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/api-keys`,
      headers: auth(memberToken),
      payload: { name: 'k' },
    });
    expect(key.statusCode).toBe(403);
    expect(key.json().error.code).toBe('APP_ACCESS_DENIED');

    // Auth config: not visible (redacted to {}) and not writable.
    const detail = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}`,
      headers: auth(memberToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.authConfig).toEqual({});

    const list = await inject({
      method: 'GET',
      url: '/api/v1/tenant/applications',
      headers: auth(memberToken),
    });
    expect((list.json().data as Array<{ authConfig: unknown }>)[0]!.authConfig).toEqual({});

    const patchAuth = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appA}/auth-config`,
      headers: auth(memberToken),
      payload: { signupEnabled: false },
    });
    expect(patchAuth.statusCode).toBe(403);
    expect(patchAuth.json().error.code).toBe('APP_ACCESS_DENIED');

    // Billing credentials are infrastructure, not catalog — still 403.
    const creds = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/applications/${appA}/billing-credentials/stripe`,
      headers: auth(memberToken),
      payload: { data: { apiKey: 'sk_test_x'.padEnd(12, 'x') } },
    });
    expect(creds.statusCode).toBe(403);
    expect(creds.json().error.code).toBe('APP_ACCESS_DENIED');

    // Reads on billing surfaces work.
    const payments = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}/payments`,
      headers: auth(memberToken),
    });
    expect(payments.statusCode).toBe(200);
    const dunning = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}/dunning`,
      headers: auth(memberToken),
    });
    expect(dunning.statusCode).toBe(200);
  });

  // ---------- APP_ADMIN ----------

  it('APP_ADMIN: full read/write on the granted app, 404/403 on the other', async () => {
    const { ownerToken, memberToken, membershipId, appA, appB } = await bootstrap();
    await setGrant(ownerToken, membershipId, appA, 'APP_ADMIN');

    // Full write on the granted app.
    const key = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/api-keys`,
      headers: auth(memberToken),
      payload: { name: 'admin-key' },
    });
    expect(key.statusCode).toBe(201);

    const patchAuth = await inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appA}/auth-config`,
      headers: auth(memberToken),
      payload: { signupEnabled: false },
    });
    expect(patchAuth.statusCode).toBe(200);

    const coupon = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appA}/coupons`,
      headers: auth(memberToken),
      payload: { code: 'ADM', discountType: 'AMOUNT', amountOff: 100 },
    });
    expect(coupon.statusCode).toBe(201);

    // The other app stays invisible — reads AND writes 404.
    const readB = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appB}`,
      headers: auth(memberToken),
    });
    expect(readB.statusCode).toBe(404);
    const writeB = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appB}/api-keys`,
      headers: auth(memberToken),
      payload: { name: 'nope' },
    });
    expect(writeB.statusCode).toBe(404);

    // Workspace-trust routes stay OWNER/ADMIN-only even for APP_ADMIN grants.
    const reqLog = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}/requests`,
      headers: auth(memberToken),
    });
    expect(reqLog.statusCode).toBe(403);
    expect(reqLog.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- OWNER/ADMIN unaffected ----------

  it('workspace ADMIN keeps implicit full access regardless of grants', async () => {
    const { ownerToken, memberToken, appA, appB } = await bootstrap('ADMIN');

    const list = await inject({
      method: 'GET',
      url: '/api/v1/tenant/applications',
      headers: auth(memberToken),
    });
    expect((list.json().data as unknown[]).length).toBe(2);

    for (const id of [appA, appB]) {
      const key = await inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${id}/api-keys`,
        headers: auth(memberToken),
        payload: { name: 'admin-mints' },
      });
      expect(key.statusCode).toBe(201);
    }

    // Owner too, with grants existing for someone else in the workspace.
    const detail = await inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${appA}`,
      headers: auth(ownerToken),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.authConfig).not.toEqual({});
  });

  // ---------- grants CRUD ----------

  it('grants CRUD is OWNER/ADMIN-gated, MEMBER-membership-only, and visible in the members list', async () => {
    const { ownerToken, memberToken, membershipId, appA } = await bootstrap();

    // MEMBER cannot manage grants (not even their own).
    const memberPut = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(memberToken),
      payload: { applicationId: appA, role: 'APP_ADMIN' },
    });
    expect(memberPut.statusCode).toBe(403);
    expect(memberPut.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');

    const memberList = await inject({
      method: 'GET',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(memberToken),
    });
    expect(memberList.statusCode).toBe(403);

    // Owner sets a grant; upsert changes the role in place.
    expect((await setGrant(ownerToken, membershipId, appA, 'APP_VIEWER')).statusCode).toBe(200);
    expect((await setGrant(ownerToken, membershipId, appA, 'APP_BILLING')).statusCode).toBe(200);

    const grants = await inject({
      method: 'GET',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(ownerToken),
    });
    expect(grants.statusCode).toBe(200);
    const rows = grants.json().data as Array<{ applicationId: string; role: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ applicationId: appA, role: 'APP_BILLING' });

    // Members list carries grants (this is how members see their own access).
    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: auth(memberToken),
    });
    const memberRows = members.json().data as Array<{
      membershipId: string;
      grants: Array<{ applicationId: string; role: string }>;
    }>;
    const mine = memberRows.find((m) => m.membershipId === membershipId)!;
    expect(mine.grants).toHaveLength(1);
    expect(mine.grants[0]).toMatchObject({ applicationId: appA, role: 'APP_BILLING' });

    // Cannot grant on an OWNER/ADMIN membership.
    const ownerMembership = memberRows.find((m) => m.membershipId !== membershipId)!;
    const onOwner = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${ownerMembership.membershipId}/grants`,
      headers: auth(ownerToken),
      payload: { applicationId: appA, role: 'APP_VIEWER' },
    });
    expect(onOwner.statusCode).toBe(400);
    expect(onOwner.json().error.code).toBe('APP_GRANT_MEMBER_ONLY');

    // Cannot grant an app from another workspace (404, non-disclosure).
    const outsider = await signUp(`outside-${Math.random().toString(36).slice(2, 7)}@example.com`, 'Outside Co');
    const foreignApp = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications',
        headers: auth(outsider.accessToken),
        payload: { name: 'Foreign', slug: `foreign-${Math.random().toString(36).slice(2, 7)}` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const crossTenant = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants`,
      headers: auth(ownerToken),
      payload: { applicationId: foreignApp, role: 'APP_VIEWER' },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe('APPLICATION_NOT_FOUND');

    // Delete the last grant → member returns to legacy read-everything mode.
    const del = await inject({
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants/${appA}`,
      headers: auth(ownerToken),
    });
    expect(del.statusCode).toBe(200);

    const delAgain = await inject({
      method: 'DELETE',
      url: `/api/v1/tenant/workspace/members/${membershipId}/grants/${appA}`,
      headers: auth(ownerToken),
    });
    expect(delAgain.statusCode).toBe(404);
    expect(delAgain.json().error.code).toBe('APP_GRANT_NOT_FOUND');

    const listAfter = await inject({
      method: 'GET',
      url: '/api/v1/tenant/applications',
      headers: auth(memberToken),
    });
    expect((listAfter.json().data as unknown[]).length).toBe(2);
  });
});
