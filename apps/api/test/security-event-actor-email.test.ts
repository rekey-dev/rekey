/**
 * The security-events feed names each actor by email, resolved at read time.
 *
 * Operators asked "which of us did this to my customer?" and got an opaque
 * actor id: the end-user Security and Activity views printed "operator", and
 * the audit log matched ids against the CURRENT member list, so anyone who had
 * since left the workspace was a bare cuid. `withActorEmails` resolves
 * operators to their account email and end-users to theirs (within the event's
 * own Application), and leaves `system` as null.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForSecurityEvents } from './wait-for-security-events.js';
import { operatorTools } from '../src/modules/tenant-mcp/operator-tools.js';

interface EventRow {
  id: string;
  type: string;
  actorType: string;
  actorId: string | null;
  actorEmail: string | null;
  applicationId: string | null;
}

describe('security events carry the actor email', () => {
  let app: FastifyInstance;
  let access: string;
  let operatorId: string;
  let tenantId: string;
  let applicationId: string;
  let endUserId: string;
  const slug = 'actor-email';
  const operatorEmail = `op-${slug}@example.com`;
  const endUserEmail = `eu-${slug}@example.com`;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  // Per test: `setup.ts` truncates every domain table before each one.
  beforeEach(async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: { email: operatorEmail, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
    });
    const auth = signUp.json().data as { accessToken: string; user: { id: string }; activeTenantId: string };
    access = auth.accessToken;
    operatorId = auth.user.id;
    tenantId = auth.activeTenantId;

    applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${access}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const key = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${access}` },
        payload: { name: 'k' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // An end-user event: they sign themselves up.
    const eu = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${key}` },
      payload: { email: endUserEmail, password: 'pw-one-two-three' },
    });
    expect(eu.statusCode).toBe(201);
    endUserId = (eu.json().data as { endUser: { id: string } }).endUser.id;

    // An operator event about them: a support action from the panel.
    const unlock = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/unlock`,
      headers: { authorization: `Bearer ${access}` },
      payload: {},
    });
    expect(unlock.statusCode).toBe(200);

    await waitForSecurityEvents({ applicationId, actorType: 'end_user' });
    await waitForSecurityEvents({ applicationId, actorType: 'operator', subjectEndUserId: endUserId });
  });

  afterAll(async () => {
    await app.close();
  });

  async function feed(query: string): Promise<EventRow[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?${query}`,
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data as { items: EventRow[] }).items;
  }

  it("names the operator who acted on an end-user, on that end-user's own feed", async () => {
    const events = await feed(`applicationId=${applicationId}&endUserId=${endUserId}&limit=50`);
    const byOperator = events.filter((e) => e.actorType === 'operator');
    expect(byOperator.length).toBeGreaterThan(0);
    for (const e of byOperator) {
      expect(e.actorId).toBe(operatorId);
      expect(e.actorEmail).toBe(operatorEmail);
    }
  });

  it("names the end-user on their own events", async () => {
    const events = await feed(`applicationId=${applicationId}&actorType=end_user&limit=50`);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.actorEmail).toBe(endUserEmail);
  });

  it('still names an operator who is no longer a member, and gives null for system and for a missing actor', async () => {
    // A former member: an operator account with no membership here. The
    // current-member lookup the panel used to do could never name them.
    const former = await prisma.tenantUser.create({ data: { email: `former-${slug}@example.com` } });
    const base = { tenantId, applicationId, metadata: {} };
    await prisma.securityEvent.createMany({
      data: [
        { ...base, type: 'end_user.unlocked', actorType: 'operator', actorId: former.id },
        { ...base, type: 'app.sessions_rotated', actorType: 'system', actorId: null },
        { ...base, type: 'end_user.unlocked', actorType: 'operator', actorId: 'cmdoesnotexist000000000000' },
      ],
    });

    const events = await feed(`applicationId=${applicationId}&limit=200`);
    expect(events.find((e) => e.actorId === former.id)?.actorEmail).toBe(`former-${slug}@example.com`);
    expect(events.find((e) => e.actorType === 'system')?.actorEmail).toBeNull();
    expect(events.find((e) => e.actorId === 'cmdoesnotexist000000000000')?.actorEmail).toBeNull();
  });

  it("does not resolve an end-user id against another Application's end-users", async () => {
    // An event that claims an end-user actor from a different Application
    // must not borrow that person's email.
    const otherId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${access}` },
        payload: { name: 'Other', slug: `${slug}-other` },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const stranger = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${otherId}/end-users`,
        headers: { authorization: `Bearer ${access}` },
        payload: { email: `stranger-${slug}@example.com`, password: 'pw-one-two-three' },
      })
      .then((r) => r.json().data as { id: string });
    await prisma.securityEvent.create({
      data: { tenantId, applicationId, type: 'user.signed_in', actorType: 'end_user', actorId: stranger.id, metadata: {} },
    });
    const events = await feed(`applicationId=${applicationId}&actorType=end_user&limit=200`);
    expect(events.find((e) => e.actorId === stranger.id)?.actorEmail).toBeNull();
  });

  it("names the operator on the end-user's recent impersonations", async () => {
    const minted = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}/impersonate`,
      headers: { authorization: `Bearer ${access}` },
      payload: { reason: 'support ticket' },
    });
    expect(minted.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${applicationId}/end-users/${endUserId}`,
      headers: { authorization: `Bearer ${access}` },
    });
    expect(detail.statusCode).toBe(200);
    const rows = (detail.json().data as {
      recentImpersonations: Array<{ operatorUserId: string; operatorEmail: string | null }>;
    }).recentImpersonations;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operatorUserId: operatorId, operatorEmail });
  });

  it('the operator MCP recent_security_events tool returns actorEmail too', async () => {
    const tool = operatorTools.find((t) => t.name === 'recent_security_events');
    expect(tool, 'recent_security_events is not an operator tool any more').toBeDefined();
    const result = (await tool!.handler(
      {
        tenantUserId: operatorId,
        tenantId,
        role: 'OWNER',
        canWrite: false,
        canAdmin: false,
        scopes: new Set(),
      },
      { limit: 200 },
    )) as { events: Array<{ actorType: string; actorId: string | null; actorEmail: string | null }> };
    const byOperator = result.events.filter((e) => e.actorType === 'operator' && e.actorId === operatorId);
    expect(byOperator.length).toBeGreaterThan(0);
    for (const e of byOperator) expect(e.actorEmail).toBe(operatorEmail);
    const system = result.events.filter((e) => e.actorType === 'system');
    for (const e of system) expect(e.actorEmail).toBeNull();
  });

  it('adds actorEmail as the last CSV column', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?applicationId=${applicationId}&endUserId=${endUserId}&format=csv`,
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    const [header, ...lines] = res.body.trim().split('\n');
    expect(header).toBe('id,type,actorType,actorId,applicationId,ip,userAgent,metadata,createdAt,actorEmail');
    expect(lines.some((l) => l.endsWith(`"${operatorEmail}"`))).toBe(true);
  });
});
