/**
 * `?endUserId=` returns every event ABOUT a person, whoever performed it.
 *
 * The panel's end-user screen needs one question answered, "what happened to
 * this person?", and the log stores the answer in two different columns. An
 * end-user's own events name them in `actor_id`. Everything done TO them by
 * somebody else (an operator blocking a device, the billing webhook creating
 * the account) names them in `metadata.endUserId`, with the operator or the
 * system as the actor.
 *
 * With no filter that could express "either", the panel read the application's
 * latest 200 events three times over, once per actor type, and matched both
 * fields in memory: 600 rows fetched to render twenty, on every view. Worse, it
 * was wrong for a quiet user on a busy application, their events simply were
 * not in anyone's most recent 200.
 *
 * `recordSecurityEvent` now derives one `subject_end_user_id` at write time, so
 * the read is an indexed equality. These cases pin the behaviour that makes the
 * collapse safe: both shapes come back, a filter on `actorType` alone still
 * does NOT (which is the bug the three scans existed to work around), and the
 * subject filter cannot be used to read across a workspace boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { recordSecurityEvent, subjectEndUserIdOf } from '../src/lib/security-events.js';

describe('subjectEndUserIdOf', () => {
  it('prefers the explicit subject over the actor', () => {
    expect(
      subjectEndUserIdOf({
        actorType: 'operator',
        actorId: 'op_1',
        metadata: { endUserId: 'eu_1' },
      }),
    ).toBe('eu_1');
  });

  it('falls back to the actor when an end-user acted on themselves', () => {
    expect(subjectEndUserIdOf({ actorType: 'end_user', actorId: 'eu_1' })).toBe('eu_1');
  });

  it('is null for an operator acting on nobody in particular', () => {
    expect(subjectEndUserIdOf({ actorType: 'operator', actorId: 'op_1' })).toBeNull();
  });

  it('ignores a non-string or empty endUserId rather than writing a junk subject', () => {
    expect(subjectEndUserIdOf({ actorType: 'system', metadata: { endUserId: '' } })).toBeNull();
    expect(subjectEndUserIdOf({ actorType: 'system', metadata: { endUserId: 42 } })).toBeNull();
  });
});

describe('GET /api/v1/tenant/security-events?endUserId=', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function bootstrap(slug: string): Promise<{
    applicationId: string;
    tenantAccess: string;
  }> {
    const session = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: {
          email: `op-subject-${slug}@example.com`,
          password: 'pw-one-two-three',
          workspaceName: `WS subject ${slug}`,
        },
      })
      .then((r) => r.json().data as { accessToken: string });
    const application = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${session.accessToken}` },
        payload: { name: `App subject ${slug}`, slug: `subject-${slug}` },
      })
      .then((r) => r.json().data as { id: string });
    return { applicationId: application.id, tenantAccess: session.accessToken };
  }

  async function typesFor(
    access: string,
    query: Record<string, string>,
  ): Promise<string[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?${new URLSearchParams({ limit: '100', ...query })}`,
      headers: { authorization: `Bearer ${access}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data.items as Array<{ type: string }>).map((e) => e.type).sort();
  }

  it('returns the end-user\'s own events AND what was done to them, and nobody else\'s', async () => {
    const { applicationId, tenantAccess } = await bootstrap('a');
    const mine = 'eu_subject_mine';
    const theirs = 'eu_subject_theirs';

    // The person's own action: they are the actor.
    await recordSecurityEvent({
      type: 'user.signed_in',
      actorType: 'end_user',
      actorId: mine,
      applicationId,
    });
    // Done TO them by an operator: the operator is the actor, they are the
    // subject. This is the shape `actorType=end_user` could never return.
    await recordSecurityEvent({
      type: 'end_user.device_blocked',
      actorType: 'operator',
      actorId: 'op_someone',
      applicationId,
      metadata: { endUserId: mine },
    });
    // Done by the system, no actor at all.
    await recordSecurityEvent({
      type: 'end_user.created_by_billing_webhook',
      actorType: 'system',
      applicationId,
      metadata: { endUserId: mine },
    });
    // A different person entirely, must not leak into the answer.
    await recordSecurityEvent({
      type: 'user.signed_in',
      actorType: 'end_user',
      actorId: theirs,
      applicationId,
    });

    expect(await typesFor(tenantAccess, { applicationId, endUserId: mine })).toEqual([
      'end_user.created_by_billing_webhook',
      'end_user.device_blocked',
      'user.signed_in',
    ]);

    // The bug the three scans worked around: filtering by actor type alone
    // still drops everything an operator or the system did to this person.
    expect(await typesFor(tenantAccess, { applicationId, actorType: 'end_user' })).toEqual([
      'user.signed_in',
      'user.signed_in',
    ]);
  });

  it('does not reach across a workspace boundary', async () => {
    const a = await bootstrap('b');
    const b = await bootstrap('c');
    const shared = 'eu_subject_shared';

    await recordSecurityEvent({
      type: 'user.signed_in',
      actorType: 'end_user',
      actorId: shared,
      applicationId: a.applicationId,
    });

    // `b` knows the id and asks for it. Tenant scoping, not the subject
    // filter, is what refuses, but this is the case that matters, because a
    // filter that widened a read would be a silent cross-tenant leak.
    expect(await typesFor(b.tenantAccess, { endUserId: shared })).toEqual([]);
    expect(await typesFor(a.tenantAccess, { endUserId: shared })).toEqual(['user.signed_in']);
  });
});
