/**
 * Per-app Activity log — end-user events (sign-up / sign-in) are recorded as
 * `actorType: 'end_user'` security events, scoped to the Application + its
 * tenant, and read back via the operator security-events route filtered by
 * `actorType=end_user`.
 *
 * Events are written fire-and-forget (best-effort), but the subsequent HTTP
 * round-trip gives the microtask time to flush — same pattern the existing
 * `app.sessions_rotated` audit assertion relies on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

describe('per-app activity log', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('records end-user sign-up + sign-in and lists them for the operator', async () => {
    const slug = 'act-log';
    const tenantAccess = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `op-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);

    const applicationId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: `App ${slug}`, slug },
      })
      .then((r) => (r.json().data as { id: string }).id);

    const liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
        headers: { authorization: `Bearer ${tenantAccess}` },
        payload: { name: 'k', mode: 'live' },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);

    // End-user signs up...
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signUp.statusCode).toBe(201);
    const endUserId = (signUp.json().data as { endUser: { id: string } }).endUser.id;

    // ...then signs in.
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: { email: `eu-${slug}@example.com`, password: 'pw-one-two-three' },
    });
    expect(signIn.statusCode).toBe(200);

    // Operator reads the activity feed, filtered to end-user events for this app.
    const log = await app.inject({
      method: 'GET',
      url: `/api/v1/tenant/security-events?applicationId=${applicationId}&actorType=end_user&limit=50`,
      headers: { authorization: `Bearer ${tenantAccess}` },
    });
    expect(log.statusCode).toBe(200);
    const events = (
      log.json().data as {
        items: Array<{ type: string; actorType: string; actorId: string | null; applicationId: string | null }>;
      }
    ).items;

    // All returned rows are end-user events for this application.
    expect(events.every((e) => e.actorType === 'end_user' && e.applicationId === applicationId)).toBe(true);
    expect(events.some((e) => e.type === 'user.signed_up' && e.actorId === endUserId)).toBe(true);
    expect(events.some((e) => e.type === 'user.signed_in' && e.actorId === endUserId)).toBe(true);
  });
});
