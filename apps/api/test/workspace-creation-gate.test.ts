/**
 * WORKSPACE_CREATION — deploy-time control of "an operator makes themselves
 * another workspace".
 *
 * The gate exists because a per-workspace ceiling (DEFAULT_TENANT_LIMITS) is
 * worth nothing if any operator — including someone merely invited into a
 * team — can mint a fresh workspace with a fresh ceiling.
 *
 * The assertions that make it safe to ship:
 *   1. Default 'open' is today's behaviour, so a self-host that never sets the
 *      variable notices nothing.
 *   2. It gates CREATION and nothing else. Reading, listing, switching and
 *      renaming stay open under 'disabled' — an operator who already has
 *      workspaces must keep working exactly as before.
 *   3. It is not the sign-up gate. A brand-new operator still gets their first
 *      workspace; who may register at all is OPERATOR_SIGNUP_MODE's job.
 *
 * Read live from process.env by the enforcement layer, so each test sets it
 * directly and clears it afterwards (the suite runs single-fork).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';

describe('WORKSPACE_CREATION', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    // Restore the default so other test files (which assume 'open') are unaffected.
    delete process.env.WORKSPACE_CREATION;
  });

  async function signUp(
    email: string,
    workspaceName: string,
  ): Promise<{ activeTenantId: string; accessToken: string }> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email, password: 'pw-one-two-three', workspaceName },
    });
    expect(r.statusCode).toBe(201);
    return r.json().data as { activeTenantId: string; accessToken: string };
  }

  function createWorkspace(
    accessToken: string,
    name: string,
  ): ReturnType<FastifyInstance['inject']> {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tenant/workspace',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { name },
    });
  }

  // ---------- today's behaviour ----------

  it('unset → an operator can still create another workspace', async () => {
    const { accessToken } = await signUp('open-unset@example.com', 'Unset Co');
    const r = await createWorkspace(accessToken, 'Another Co');
    expect(r.statusCode).toBe(200);
    expect((r.json().data as { name: string }).name).toBe('Another Co');
  });

  it("open → same as unset", async () => {
    process.env.WORKSPACE_CREATION = 'open';
    const { accessToken } = await signUp('open-explicit@example.com', 'Open Co');
    expect((await createWorkspace(accessToken, 'Also Fine')).statusCode).toBe(200);
  });

  // ---------- the gate ----------

  it('disabled → 403 WORKSPACE_CREATION_DISABLED, and nothing is written', async () => {
    const { accessToken } = await signUp('gated@example.com', 'Gated Co');
    process.env.WORKSPACE_CREATION = 'disabled';

    const r = await createWorkspace(accessToken, 'Escape Hatch Co');
    expect(r.statusCode).toBe(403);
    const body = r.json();
    expect(body.error.code).toBe('WORKSPACE_CREATION_DISABLED');
    // The fix line has to tell the operator what to do about it.
    expect(body.error.fix).toMatch(/administrator/i);

    expect(await prisma.tenant.count({ where: { name: 'Escape Hatch Co' } })).toBe(0);
  });

  it('disabled → a brand-new operator still gets their first workspace', async () => {
    process.env.WORKSPACE_CREATION = 'disabled';
    const { activeTenantId } = await signUp('fresh@example.com', 'Fresh Co');
    const tenant = await prisma.tenant.findUnique({ where: { id: activeTenantId } });
    expect(tenant?.name).toBe('Fresh Co');
  });

  // ---------- creation only ----------

  it('disabled → reading, listing, switching and renaming are untouched', async () => {
    const { accessToken } = await signUp('multi@example.com', 'Multi Co');
    // Two workspaces while creation is still open.
    const second = await createWorkspace(accessToken, 'Multi Two');
    expect(second.statusCode).toBe(200);
    const secondId = (second.json().data as { id: string }).id;

    process.env.WORKSPACE_CREATION = 'disabled';
    const auth = { authorization: `Bearer ${accessToken}` };

    const read = await app.inject({ method: 'GET', url: '/api/v1/tenant/workspace', headers: auth });
    expect(read.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/v1/tenant/auth/me', headers: auth });
    expect(list.statusCode).toBe(200);

    const switched = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/switch-workspace',
      headers: auth,
      payload: { tenantId: secondId },
    });
    expect(switched.statusCode).toBe(200);
    const switchedToken = (switched.json().data as { accessToken: string }).accessToken;

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/workspace',
      headers: { authorization: `Bearer ${switchedToken}` },
      payload: { name: 'Multi Two Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json().data as { name: string }).name).toBe('Multi Two Renamed');
  });

  // ---------- misconfiguration ----------

  it('an unrecognised runtime value falls back to the boot value, not to open-by-accident', async () => {
    const { accessToken } = await signUp('typo@example.com', 'Typo Co');
    // Boot value here is the default 'open', so a typo must behave like 'open'
    // rather than silently becoming a gate (or silently lifting one).
    process.env.WORKSPACE_CREATION = 'disabledd';
    expect((await createWorkspace(accessToken, 'Typo Two')).statusCode).toBe(200);
  });
});
