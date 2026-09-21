/**
 * Who may destroy an end-user.
 *
 * Two operations live behind `DELETE /tenant/applications/:id/end-users/:euid`,
 * and they had different floors for reasons that do not survive being written
 * down:
 *
 *   ?erasure=true   GDPR erasure. Tombstones the account and RETAINS the
 *                   financial rows, anonymized. Was OWNER/ADMIN, checked in the
 *                   handler.
 *   (default)       Plain cascade delete. Removes the end-user AND every
 *                   dependent row the schema cascades into, payments,
 *                   subscriptions, licences, the credit ledger, usage. Was
 *                   `ensureAppAccess(..., 'write')` and nothing else, which a
 *                   MEMBER holding an `APP_ADMIN` grant satisfies.
 *
 * So the path that keeps the accounting record was gated harder than the path
 * that destroys it, and the more destructive of the two was reachable by the
 * least privileged role that can reach the Application at all. Nothing about
 * "delete" being the older, plainer verb makes it the safer operation.
 *
 * Both are now OWNER. That is a deliberate tightening and it is breaking for
 * anyone who had an ADMIN or a granted MEMBER doing this: erasure answers a
 * legal request and a cascade delete is unrecoverable, and neither is routine
 * support work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('destructive end-user operations are workspace-OWNER only', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  // The global rate limit is per-IP and the instance lives for the whole file;
  // give each scenario its own source address so the suite never trips 429s.
  let currentIp = '10.98.0.1';
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

  interface Scenario {
    ownerToken: string;
    /** A second operator at `role` in the same workspace. */
    otherToken: string;
    membershipId: string;
    applicationId: string;
  }

  async function bootstrap(role: 'MEMBER' | 'ADMIN'): Promise<Scenario> {
    currentIp = `10.98.${++n}.1`;
    const tag = `floors-${n}-${Math.random().toString(36).slice(2, 7)}`;
    const ownerToken = await signUp(`owner-${tag}@example.com`, 'Floors Co');
    const inviteeToken = await signUp(`other-${tag}@example.com`, 'Other Own Co');

    const appRes = await inject({
      method: 'POST',
      url: '/api/v1/tenant/applications',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { name: 'Floors app', slug: `${tag}-app` },
    });
    expect(appRes.statusCode).toBe(201);
    const applicationId = (appRes.json().data as { id: string }).id;

    const inv = await inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace/invitations',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { email: `other-${tag}@example.com`, role },
    });
    expect(inv.statusCode).toBe(201);
    const accept = await inject({
      method: 'POST',
      url: '/api/v1/tenant/invitations/accept',
      headers: { authorization: `Bearer ${inviteeToken}` },
      payload: { token: (inv.json().data as { token: string }).token },
    });
    expect(accept.statusCode).toBe(200);
    const otherToken = (accept.json().data as { accessToken: string }).accessToken;

    const members = await inject({
      method: 'GET',
      url: '/api/v1/tenant/workspace/members',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const membershipId = (
      members.json().data as { items: Array<{ membershipId: string; email: string }> }
    ).items.find((m) => m.email === `other-${tag}@example.com`)!.membershipId;

    return { ownerToken, otherToken, membershipId, applicationId };
  }

  /** Give the MEMBER the strongest per-application grant there is. */
  async function grantAppAdmin(s: Scenario): Promise<void> {
    const r = await inject({
      method: 'PUT',
      url: `/api/v1/tenant/workspace/members/${s.membershipId}/grants`,
      headers: { authorization: `Bearer ${s.ownerToken}` },
      payload: { applicationId: s.applicationId, role: 'APP_ADMIN' },
    });
    expect(r.statusCode).toBe(200);
  }

  let seq = 0;
  async function makeEndUser(s: Scenario): Promise<string> {
    const r = await inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${s.applicationId}/end-users`,
      headers: { authorization: `Bearer ${s.ownerToken}` },
      payload: { email: `victim-${++seq}-${Math.random().toString(36).slice(2, 7)}@example.com` },
    });
    expect(r.statusCode).toBe(201);
    return (r.json().data as { id: string }).id;
  }

  function del(token: string, s: Scenario, euid: string, erasure: boolean) {
    return inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${s.applicationId}/end-users/${euid}${
        erasure ? '?erasure=true' : ''
      }`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  // ---------- the hole this closes ----------

  it('a MEMBER with APP_ADMIN cannot cascade-delete an end-user', async () => {
    const s = await bootstrap('MEMBER');
    await grantAppAdmin(s);
    const euid = await makeEndUser(s);

    const res = await del(s.otherToken, s, euid, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  it('a MEMBER with APP_ADMIN cannot erase an end-user', async () => {
    const s = await bootstrap('MEMBER');
    await grantAppAdmin(s);
    const euid = await makeEndUser(s);

    const res = await del(s.otherToken, s, euid, true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- the tightening ----------

  it('an ADMIN cannot cascade-delete an end-user', async () => {
    const s = await bootstrap('ADMIN');
    const euid = await makeEndUser(s);

    const res = await del(s.otherToken, s, euid, false);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  it('an ADMIN cannot erase an end-user', async () => {
    const s = await bootstrap('ADMIN');
    const euid = await makeEndUser(s);

    const res = await del(s.otherToken, s, euid, true);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('TENANT_ROLE_INSUFFICIENT');
  });

  // ---------- the OWNER still can ----------

  it('the OWNER can erase, and the tombstone is idempotent', async () => {
    const s = await bootstrap('ADMIN');
    const euid = await makeEndUser(s);

    const first = await del(s.ownerToken, s, euid, true);
    expect(first.statusCode).toBe(200);
    expect(first.json().data.erased).toBe(true);

    const again = await del(s.ownerToken, s, euid, true);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.alreadyErased).toBe(true);
  });

  it('the OWNER can cascade-delete', async () => {
    const s = await bootstrap('ADMIN');
    const euid = await makeEndUser(s);

    const res = await del(s.ownerToken, s, euid, false);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.removed).toBe(true);
  });

  // ---------- unchanged: no grant means the Application does not exist ----------

  it('a grant-less MEMBER still gets 404 rather than 403', async () => {
    // Non-disclosure comes first and is unaffected by the role floor: a MEMBER
    // with no grant must not be able to tell a real end-user id from a typo.
    const s = await bootstrap('MEMBER');
    const euid = await makeEndUser(s);

    const res = await del(s.otherToken, s, euid, false);
    expect(res.statusCode).toBe(404);
  });
});
