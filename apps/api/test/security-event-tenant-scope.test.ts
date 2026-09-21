/**
 * A security event must reach the workspace that owns the Application it names.
 *
 * `securityEventWhere` used to scope every tenant-facing read by `tenantId`
 * alone, so a row written without one was durable, correct, and invisible: in
 * `security_events`, and in no operator's log. Nothing failed and nothing
 * warned, so the only way to notice was to go looking for an event you knew you
 * had caused.
 *
 * Six emit sites had that shape against 53 that pass `tenantId`, and five of the
 * six were the whole device family. The entire device audit trail was therefore
 * written and surfaced nowhere: not the workspace Activity log, not the audit
 * log, not the end-user it happened to.
 *
 * ## Why the fix is on the read side
 *
 * Deriving the tenant when the event is WRITTEN was tried first and reverted. It
 * puts a database read on the audit-write path, which is exactly what the
 * scalar-only, relation-free shape of this table exists to prevent (see the
 * `ApiRequestLog` note in the schema: a logging write must not contend with the
 * request it records). It was not theoretical, it reordered detached webhook
 * emission in `devices.test.ts` about half the time, by contending for a
 * connection with the `emitDetached` next to it.
 *
 * An event naming an Application already identifies its workspace. The fact was
 * never missing, only unjoined. So these cases assert **visibility**, which is
 * the property that actually matters, rather than the value of a column, and
 * the last one asserts the thing widening a security-scoped read must never
 * break.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { recordSecurityEvent } from '../src/lib/security-events.js';

interface Bootstrapped {
  tenantId: string;
  applicationId: string;
  publishableKey: string;
  tenantAccess: string;
}

describe('Security events are reachable from the workspace that owns the Application', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<Bootstrapped> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-sectenant-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS sectenant ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string; activeTenantId: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App sectenant ${slug}`, slug: `sectenant-${slug}` },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    return {
      tenantId: session.activeTenantId,
      applicationId: application.id,
      publishableKey: application.publicKey,
      tenantAccess: session.accessToken,
    };
  }

  /** Event types visible in `b`'s workspace log, optionally for one Application. */
  async function loggedTypes(
    b: Bootstrapped,
    opts: { actorType?: string; applicationId?: string | null } = {},
  ): Promise<string[]> {
    const query = new URLSearchParams({ limit: '100' });
    const appId = opts.applicationId === undefined ? b.applicationId : opts.applicationId;
    if (appId !== null) query.set('applicationId', appId);
    if (opts.actorType) query.set('actorType', opts.actorType);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?${query.toString()}`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data.items as Array<{ type: string }>).map((e) => e.type);
  }

  it('an event recorded with only an applicationId is visible to that workspace', async () => {
    const b = await bootstrap('derived');

    await recordSecurityEvent({
      type: 'end_user.device_blocked',
      actorType: 'operator',
      actorId: 'op-1',
      applicationId: b.applicationId,
      metadata: { deviceId: 'dev-1', endUserId: 'eu-1' },
    });

    // The column really is null, the row is unchanged, the READ is what moved.
    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { applicationId: b.applicationId, type: 'end_user.device_blocked' },
    });
    expect(row.tenantId).toBeNull();

    expect(await loggedTypes(b)).toContain('end_user.device_blocked');
  });

  it('an event that names the workspace directly is still visible', async () => {
    const b = await bootstrap('explicit');

    await recordSecurityEvent({
      type: 'end_user.device_unblocked',
      actorType: 'operator',
      tenantId: b.tenantId,
      applicationId: b.applicationId,
      metadata: {},
    });

    expect(await loggedTypes(b)).toContain('end_user.device_unblocked');
  });

  it('a workspace never sees another workspace\'s events', async () => {
    // The point of the whole exercise. Widening a security-scoped read is only
    // safe if this holds, so it is asserted for both shapes: an event carrying
    // a foreign tenantId, and one carrying only a foreign applicationId, the
    // shape the new OR branch matches on.
    const mine = await bootstrap('mine');
    const theirs = await bootstrap('theirs');

    await recordSecurityEvent({
      type: 'end_user.device_blocked',
      actorType: 'operator',
      applicationId: theirs.applicationId,
      metadata: { marker: 'foreign-app-only' },
    });
    await recordSecurityEvent({
      type: 'end_user.device_unblocked',
      actorType: 'operator',
      tenantId: theirs.tenantId,
      applicationId: theirs.applicationId,
      metadata: { marker: 'foreign-tenant' },
    });

    // Unfiltered by Application: everything my workspace can see, full stop.
    const visibleToMe = await loggedTypes(mine, { applicationId: null });
    expect(visibleToMe).not.toContain('end_user.device_blocked');
    expect(visibleToMe).not.toContain('end_user.device_unblocked');

    // And naming their Application explicitly does not reach it either.
    expect(await loggedTypes(mine, { applicationId: theirs.applicationId })).toEqual([]);

    // Their own workspace does see both.
    const visibleToThem = await loggedTypes(theirs, { applicationId: null });
    expect(visibleToThem).toContain('end_user.device_blocked');
    expect(visibleToThem).toContain('end_user.device_unblocked');
  });

  it('an event with no Application at all is recorded and belongs to no workspace', async () => {
    const b = await bootstrap('systemwide');
    await recordSecurityEvent({ type: 'operator.sign_in_failed', actorType: 'operator' });

    const row = await prisma.securityEvent.findFirstOrThrow({
      where: { type: 'operator.sign_in_failed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.tenantId).toBeNull();
    expect(row.applicationId).toBeNull();

    // Deployment-level, so no tenant log claims it.
    expect(await loggedTypes(b, { applicationId: null })).not.toContain('operator.sign_in_failed');
  });

  it('blocking a device through the operator route reaches the workspace log', async () => {
    const b = await bootstrap('device');

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${b.publishableKey}` },
      payload: {
        email: 'device-owner@example.com',
        password: 'pw-one-two-three',
        device: { fingerprint: 'fp-test-0123456789abcdef', label: 'Test machine' },
      },
    });
    expect(signUp.statusCode).toBe(201);
    const endUserId = signUp.json().data.endUser.id as string;

    const devices = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${endUserId}/devices`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
    });
    expect(devices.statusCode).toBe(200);
    const deviceId = (devices.json().data.items as Array<{ id: string }>)[0]!.id;

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${b.applicationId}/end-users/${endUserId}/devices/${deviceId}/block`,
      headers: { authorization: `Bearer ${b.tenantAccess}` },
      payload: { reason: 'chargeback' },
    });
    expect(blocked.statusCode).toBe(200);

    // Registration is the end-user's own event; the block is the operator's.
    // Both were unreachable before, and they arrive under different actor
    // types, which is why the panel scans more than one.
    expect(await loggedTypes(b, { actorType: 'end_user' })).toContain('user.device_registered');
    expect(await loggedTypes(b, { actorType: 'operator' })).toContain('end_user.device_blocked');
  });
});
