/**
 * `POST /api/v1/admin/tenants/:id/members`.
 *
 * Closes the gap that made admin-created workspaces useless: `POST
 * /api/v1/admin/tenants` writes a Tenant and nothing else, and `ownerEmail` on
 * that row is a denormalised label rather than an access grant — everything
 * that actually reaches a workspace runs through `TenantMembership`. So an
 * admin-created workspace was one nobody could open.
 *
 * It exists for deployment provisioning automation acting FOR an operator who
 * already exists, from a service with no operator session. The two things it
 * must never become are the point of most of these cases: a way to create an
 * operator (which would bypass `OPERATOR_SIGNUP_MODE`), and a way to silently
 * re-promote one on a retry.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';

const PASSWORD = 'pw-one-two-three';

describe('admin: add an operator to a workspace', () => {
  let app: FastifyInstance;
  let adminKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    adminKey = process.env.SUPER_ADMIN_KEY!;
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  const auth = () => ({ authorization: `Bearer ${adminKey}` });

  /** An operator with their own workspace, plus a second bare admin workspace. */
  async function fixture(): Promise<{ email: string; ownTenantId: string; bareTenantId: string }> {
    const email = `op-${n++}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: PASSWORD, workspaceName: 'Their Own' },
    });
    expect(signUp.statusCode).toBe(201);
    const ownTenantId = (signUp.json().data as { activeTenantId: string }).activeTenantId;

    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/tenants',
      headers: auth(),
      payload: { name: 'Provisioned', ownerEmail: email },
    });
    expect(bare.statusCode).toBe(201);
    return { email, ownTenantId, bareTenantId: (bare.json().data as { id: string }).id };
  }

  const addMember = (tenantId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${tenantId}/members`,
      headers: auth(),
      payload: body,
    });

  it('an admin-created workspace has no members until this is called', async () => {
    const fx = await fixture();
    // The gap itself: ownerEmail is set, and it grants nothing.
    expect(await prisma.tenantMembership.count({ where: { tenantId: fx.bareTenantId } })).toBe(0);

    const res = await addMember(fx.bareTenantId, { email: fx.email });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { role: string; created: boolean; tenantId: string };
    expect(data.created).toBe(true);
    expect(data.role).toBe('OWNER');
    expect(data.tenantId).toBe(fx.bareTenantId);
  });

  it('the operator can actually open the workspace afterwards', async () => {
    const fx = await fixture();
    expect((await addMember(fx.bareTenantId, { email: fx.email })).statusCode).toBe(200);

    // Sign in fresh and switch into the provisioned workspace — the real proof
    // that the membership is what access depends on.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-in',
      payload: { email: fx.email, password: PASSWORD },
    });
    expect(signIn.statusCode).toBe(200);
    const session = signIn.json().data as {
      accessToken: string;
      memberships: { tenantId: string }[];
    };
    expect(session.memberships.map((m) => m.tenantId)).toContain(fx.bareTenantId);

    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { tenantId: fx.bareTenantId },
    });
    expect(switched.statusCode).toBe(200);
  });

  it('is idempotent and does NOT rewrite the role of an existing membership', async () => {
    const fx = await fixture();
    // They are already OWNER of their own workspace. A retry that "promotes"
    // to OWNER must not be how a demoted operator gets their role back.
    const demoted = await prisma.tenantMembership.findFirstOrThrow({
      where: { tenantId: fx.ownTenantId },
    });
    await prisma.tenantMembership.update({
      where: { id: demoted.id },
      data: { role: 'MEMBER' },
    });

    const res = await addMember(fx.ownTenantId, { email: fx.email, role: 'OWNER' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { created: boolean; role: string };
    expect(data.created).toBe(false);
    expect(data.role).toBe('MEMBER');
    expect(await prisma.tenantMembership.count({ where: { tenantId: fx.ownTenantId } })).toBe(1);
  });

  it('honours an explicit role for a NEW membership', async () => {
    const fx = await fixture();
    const res = await addMember(fx.bareTenantId, { email: fx.email, role: 'MEMBER' });
    expect((res.json().data as { role: string }).role).toBe('MEMBER');
  });

  it('refuses an email with no operator behind it — it never creates one', async () => {
    const fx = await fixture();
    const res = await addMember(fx.bareTenantId, { email: 'nobody-at-all@example.com' });
    expect(res.statusCode).toBe(404);
    expect((res.json().error as { code: string }).code).toBe('OPERATOR_NOT_FOUND');
    // The gate this protects: creating an operator here would sidestep
    // OPERATOR_SIGNUP_MODE completely.
    expect(await prisma.tenantUser.count({ where: { email: 'nobody-at-all@example.com' } })).toBe(0);
  });

  it('404s for a workspace that does not exist', async () => {
    const fx = await fixture();
    const res = await addMember('tenant_nope', { email: fx.email });
    expect(res.statusCode).toBe(404);
    expect((res.json().error as { code: string }).code).toBe('TENANT_NOT_FOUND');
  });

  it('requires the super-admin key', async () => {
    const fx = await fixture();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${fx.bareTenantId}/members`,
      payload: { email: fx.email },
    });
    expect(res.statusCode).toBe(401);
  });

  it('records a security event when a membership is actually created', async () => {
    const fx = await fixture();
    expect((await addMember(fx.bareTenantId, { email: fx.email })).statusCode).toBe(200);
    // Poll rather than sleep: the write is fire-and-forget, so a fixed delay
    // passes locally and loses on a loaded runner.
    const events = await waitForSecurityEvents({
      type: 'workspace.member_added_by_admin',
      tenantId: fx.bareTenantId,
    });
    expect(events).toHaveLength(1);

    // A no-op retry must not add noise to the audit log.
    expect((await addMember(fx.bareTenantId, { email: fx.email })).statusCode).toBe(200);
    // This half asserts an ABSENCE (the retry added no second event), and
    // polling cannot establish that - there is no moment at which "still not
    // there" becomes conclusive. A settle window is the honest tool here, and
    // it is the one assertion in this file that a slow enough runner could
    // still pass vacuously. Deliberately longer than the old 150ms.
    await new Promise((r) => setTimeout(r, 750));
    expect(
      await prisma.securityEvent.count({
        where: { type: 'workspace.member_added_by_admin', tenantId: fx.bareTenantId },
      }),
    ).toBe(1);
  });
});
