/**
 * Device-bound sessions.
 *
 * Every session-minting flow funnels through one chokepoint (`issuePair`), so
 * the assertions here go through the public routes and prove the behaviour a
 * desktop client sees:
 *   - a `device` binding on sign-in yields a session whose access token carries
 *     `dev`, whose refresh row records `deviceId`, and whose AuthResult says so;
 *   - no binding means nothing changed, `deviceId: null`, no claim, no row;
 *   - `authConfig.deviceBinding = 'required'` refuses primary sign-in without
 *     one, and never gates refresh;
 *   - `max_devices` from the default plan refuses the next machine with a 403
 *     that lists the devices to release, and releasing one lets it in;
 *   - a blocked device cannot sign in;
 *   - refresh keeps the binding, binds an unbound chain, refuses a different
 *     fingerprint (and revokes the family), and a released device's chain is
 *     dead;
 *   - the session list shows `deviceId`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { rotateRefreshToken } from '../src/lib/refresh-tokens.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import { authService } from '../src/modules/auth/auth.service.js';
import {
  makeEndUser as makeEndUserFor,
  setDefaultDeviceLimit as setDefaultDeviceLimitFor,
  waitForDeliveries,
} from './device-fixtures.js';

const PASSWORD = 'pw-one-two-three';

describe('device-bound sessions', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const keyAuth = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `ds-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DS', slug: `ds-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });



  const makeEndUser = (email: string) => makeEndUserFor(app, token, appId, email, PASSWORD);
  const setDefaultDeviceLimit = (limit: number) => setDefaultDeviceLimitFor(app, token, appId, limit);

  async function setDeviceBinding(mode: 'optional' | 'required'): Promise<void> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenant/applications/${appId}/auth-config`,
      headers: auth(),
      payload: { deviceBinding: mode },
    });
    expect(res.statusCode).toBe(200);
  }

  type Session = {
    accessToken: string;
    refreshToken: string;
    deviceId: string | null;
    endUser: { id: string };
  };

  function signIn(email: string, device?: { fingerprint: string; label?: string }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: keyAuth(),
      payload: { email, password: PASSWORD, ...(device && { device }) },
    });
  }

  function refresh(refreshToken: string, device?: { fingerprint: string; label?: string }) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: keyAuth(),
      payload: { refreshToken, ...(device && { device }) },
    });
  }

  const claims = (accessToken: string): Record<string, unknown> =>
    jwt.decode(accessToken) as Record<string, unknown>;

  it('binds a session to the device named at sign-in', async () => {
    const userId = await makeEndUser('a@example.com');
    const res = await signIn('a@example.com', { fingerprint: 'fp-laptop-a-0001', label: 'Laptop' });
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(s.deviceId).toBeTruthy();
    expect(claims(s.accessToken).dev).toBe(s.deviceId);

    const device = await prisma.device.findUniqueOrThrow({ where: { id: s.deviceId! } });
    expect(device.endUserId).toBe(userId);
    expect(device.fingerprint).toBe('fp-laptop-a-0001');
    expect(device.label).toBe('Laptop');
    expect(device.status).toBe('ACTIVE');

    const rows = await prisma.refreshToken.findMany({ where: { endUserId: userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceId).toBe(s.deviceId);

    // The session list shows it.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sessions',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json().data.items as Array<{ deviceId: string | null }>)[0]!.deviceId).toBe(s.deviceId);
  });

  it('changes nothing for a client that sends no device', async () => {
    const userId = await makeEndUser('b@example.com');
    const res = await signIn('b@example.com');
    expect(res.statusCode).toBe(200);
    const s = res.json().data as Session;
    expect(s.deviceId).toBeNull();
    expect(claims(s.accessToken).dev).toBeUndefined();
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
    const row = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId } });
    expect(row.deviceId).toBeNull();
  });

  it('deviceBinding=required refuses primary sign-in without a device, but not refresh', async () => {
    await makeEndUser('c@example.com');
    await setDeviceBinding('required');

    const bare = await signIn('c@example.com');
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');

    const bound = await signIn('c@example.com', { fingerprint: 'fp-required-0001' });
    expect(bound.statusCode).toBe(200);
    const s = bound.json().data as Session;

    // Refresh without repeating the fingerprint keeps working, the chain is
    // already bound, and `required` gates primary sign-in only.
    const r = await refresh(s.refreshToken);
    expect(r.statusCode).toBe(200);
    expect((r.json().data as Session).deviceId).toBe(s.deviceId);
  });

  it('deviceBinding=required refuses a sign-up without a device before the account exists', async () => {
    await setDeviceBinding('required');
    const bare = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: keyAuth(),
      payload: { email: 'new@example.com', password: PASSWORD },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('DEVICE_FINGERPRINT_REQUIRED');
    // Nothing was created, so the corrected retry is a sign-up, not a 409.
    expect(await prisma.endUser.count({ where: { applicationId: appId } })).toBe(0);
    const withDevice = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: keyAuth(),
      payload: { email: 'new@example.com', password: PASSWORD, device: { fingerprint: 'fp-signup-00001' } },
    });
    expect(withDevice.statusCode).toBe(201);
    expect((withDevice.json().data as Session).deviceId).toBeTruthy();
  });

  it('a released device is not brought back by an organization switch on a still-valid access token', async () => {
    const userId = await makeEndUser('org@example.com');
    const s = (await signIn('org@example.com', { fingerprint: 'fp-org-switch-001' })).json().data as Session;
    const orgId = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/organizations`,
        headers: auth(),
        payload: { name: 'team', slug: 'team', ownerEndUserId: userId },
      })
      .then((r) => (r.json().data as { id: string }).id);
    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: s.deviceId!, actor: { type: 'end_user', id: userId } });

    // Over HTTP the session middleware answers first: the token's `dev` names
    // a released device and its `sid` a revoked session, so it is refused
    // before the handler runs. That is the per-session kill switch.
    const switched = await app.inject({
      method: 'POST',
      url: `/api/v1/users/me/organizations/${orgId}/switch`,
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken },
    });
    expect(switched.statusCode).toBe(401);
    expect(switched.json().error.code).toBe('USER_TOKEN_INVALID');

    // The device check itself, with nothing in front of it: a re-mint bound
    // to a released device is refused and must not reactivate the device.
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    await expect(
      authService.switchActiveOrganization({
        application,
        endUserId: userId,
        activeOrganizationId: orgId,
        impersonation: undefined,
        device: { deviceId: s.deviceId, primary: false },
      }),
    ).rejects.toMatchObject({ code: 'SESSION_DEVICE_RELEASED' });
    const device = await prisma.device.findUniqueOrThrow({ where: { id: s.deviceId! } });
    expect(device.status).toBe('RELEASED');
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);
  });

  it('a refresh refused by the device limit does not spend the token', async () => {
    await setDefaultDeviceLimit(1);
    const userId = await makeEndUser('cap@example.com');
    // An unbound chain, plus one active device filling the cap.
    const unbound = (await signIn('cap@example.com')).json().data as Session;
    expect((await signIn('cap@example.com', { fingerprint: 'fp-cap-first-0001' })).statusCode).toBe(200);

    const refused = await refresh(unbound.refreshToken, { fingerprint: 'fp-cap-second-001' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('DEVICE_LIMIT_REACHED');
    // The chain is intact: the same token still refreshes, and nothing was
    // revoked. Before the reorder, the retry read as a replay and every
    // session for the user was burned.
    const retry = await refresh(unbound.refreshToken);
    expect(retry.statusCode).toBe(200);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(2);
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);
  });

  it('refuses the device over max_devices with the list to release, then admits it after a release', async () => {
    await setDefaultDeviceLimit(1);
    const userId = await makeEndUser('d@example.com');

    const first = await signIn('d@example.com', { fingerprint: 'fp-d-first-0001', label: 'First' });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json().data as Session).deviceId!;

    const second = await signIn('d@example.com', { fingerprint: 'fp-d-second-001', label: 'Second' });
    expect(second.statusCode).toBe(403);
    const err = second.json().error as { code: string; details?: { limit: number; devices: Array<{ id: string; label: string }> } };
    expect(err.code).toBe('DEVICE_LIMIT_REACHED');
    expect(err.details?.limit).toBe(1);
    expect(err.details?.devices.map((d) => d.id)).toEqual([firstId]);
    // No session, no row for the refused machine.
    expect(await prisma.refreshToken.count({ where: { endUserId: userId } })).toBe(1);
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);

    // The same first device keeps signing in at the cap.
    const again = await signIn('d@example.com', { fingerprint: 'fp-d-first-0001' });
    expect(again.statusCode).toBe(200);

    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: firstId, actor: { type: 'end_user', id: userId } });
    const admitted = await signIn('d@example.com', { fingerprint: 'fp-d-second-001', label: 'Second' });
    expect(admitted.statusCode).toBe(200);
  });

  it('refuses sign-in from a blocked device', async () => {
    const userId = await makeEndUser('e@example.com');
    const first = await signIn('e@example.com', { fingerprint: 'fp-e-blocked-001' });
    const deviceId = (first.json().data as Session).deviceId!;
    await devicesService.block({ applicationId: appId, endUserId: userId, deviceId, operatorUserId: null });

    const blocked = await signIn('e@example.com', { fingerprint: 'fp-e-blocked-001' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('DEVICE_BLOCKED');
    // The block revoked the first session; its refresh is dead.
    const r = await refresh((first.json().data as Session).refreshToken);
    expect(r.statusCode).toBe(401);
  });

  it('refresh carries the binding, binds an unbound chain, and refuses a different device', async () => {
    const userId = await makeEndUser('f@example.com');

    // Unbound chain becomes bound on the first refresh that identifies itself.
    const unbound = (await signIn('f@example.com')).json().data as Session;
    expect(unbound.deviceId).toBeNull();
    const r1 = await refresh(unbound.refreshToken, { fingerprint: 'fp-f-late-00001', label: 'Late' });
    expect(r1.statusCode).toBe(200);
    const s1 = r1.json().data as Session;
    expect(s1.deviceId).toBeTruthy();
    expect(claims(s1.accessToken).dev).toBe(s1.deviceId);
    const rotated = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId, revokedAt: null } });
    expect(rotated.deviceId).toBe(s1.deviceId);

    // A plain refresh keeps it.
    const r2 = await refresh(s1.refreshToken);
    expect(r2.statusCode).toBe(200);
    const s2 = r2.json().data as Session;
    expect(s2.deviceId).toBe(s1.deviceId);
    expect(claims(s2.accessToken).dev).toBe(s1.deviceId);

    // The same fingerprint is fine; a different one is the stolen-token case.
    const r3 = await refresh(s2.refreshToken, { fingerprint: 'fp-f-late-00001' });
    expect(r3.statusCode).toBe(200);
    const s3 = r3.json().data as Session;
    const r4 = await refresh(s3.refreshToken, { fingerprint: 'fp-f-other-0001' });
    expect(r4.statusCode).toBe(401);
    expect(r4.json().error.code).toBe('REFRESH_TOKEN_DEVICE_MISMATCH');
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);
    // The impostor registered no device.
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);
  });

  it('a replayed refresh token with a fresh fingerprint registers no device and announces nothing', async () => {
    // Every event to an outbox endpoint, so "no device.registered" is checked
    // against what was actually emitted rather than against nothing.
    const hook = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/webhooks`,
      headers: auth(),
      payload: { url: 'http://127.0.0.1:9/never', events: ['*'] },
    });
    expect(hook.statusCode).toBe(201);
    const userId = await makeEndUser('replay@example.com');
    const unbound = (await signIn('replay@example.com')).json().data as Session;

    // The plain replay: the legitimate client rotated already, the thief
    // presents the spent token from a new machine.
    const rotated = await refresh(unbound.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const replay = await refresh(unbound.refreshToken, { fingerprint: 'fp-thief-0000001', label: 'Thief' });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);

    // The race: both requests pass the lookup, the thief's is the one that
    // loses the rotation. Simulated by rotating the presented token out from
    // under the request at the first point the device path reads anything
    // (the limit resolution), which is before the write in either ordering.
    // Before the write moved behind the rotation, this registered the
    // thief's machine and emitted device.registered, then burned the family.
    const fresh = (await signIn('replay@example.com')).json().data as Session;
    const presented = await prisma.refreshToken.findFirstOrThrow({
      where: { endUserId: userId, revokedAt: null },
    });
    const real = devicesService.maxDevicesFor.bind(devicesService);
    const spy = vi.spyOn(devicesService, 'maxDevicesFor').mockImplementationOnce(async (applicationId, endUserId) => {
      await rotateRefreshToken(presented);
      return real(applicationId, endUserId);
    });
    try {
      const raced = await refresh(fresh.refreshToken, { fingerprint: 'fp-thief-0000002', label: 'Thief' });
      expect(raced.statusCode).toBe(401);
      expect(raced.json().error.code).toBe('REFRESH_TOKEN_REUSED');
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(0);

    // A genuine sign-in afterwards is the one and only device.registered:
    // waiting for it proves the outbox has caught up, so the absence of the
    // thief's is not just the emission being slow.
    const legit = (await signIn('replay@example.com', { fingerprint: 'fp-legit-0000001', label: 'Mine' })).json()
      .data as Session;
    expect(legit.deviceId).toBeTruthy();
    const registered = await waitForDeliveries({ applicationId: appId, eventType: 'device.registered' }, 1);
    expect(registered).toHaveLength(1);
    expect(JSON.stringify(registered[0]!.payload)).toContain('fp-legit-0000001');
    expect(JSON.stringify(registered[0]!.payload)).not.toContain('fp-thief');
    const trail = await prisma.securityEvent.findMany({
      where: { applicationId: appId, type: 'user.device_registered' },
    });
    expect(trail).toHaveLength(1);
    expect((trail[0]!.metadata as { deviceId: string }).deviceId).toBe(legit.deviceId);
  });

  it("a released device's chain is dead", async () => {
    const userId = await makeEndUser('g@example.com');
    const s = (await signIn('g@example.com', { fingerprint: 'fp-g-release-001' })).json().data as Session;
    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: s.deviceId!, actor: { type: 'end_user', id: userId } });
    const r = await refresh(s.refreshToken);
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('requireUserSession exposes the device on the request', async () => {
    await makeEndUser('h@example.com');
    const s = (await signIn('h@example.com', { fingerprint: 'fp-h-expose-0001' })).json().data as Session;
    // /users/me is the smallest user-session route; it does not echo the
    // device, so assert through the claim the middleware reads.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { ...keyAuth(), 'x-rekey-user-token': s.accessToken },
    });
    expect(me.statusCode).toBe(200);
    expect(claims(s.accessToken).dev).toBe(s.deviceId);
  });

  // ---------- per-session revocation (sid / dev), not the per-user stamp ----------

  const me = (accessToken: string) =>
    app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { ...keyAuth(), 'x-rekey-user-token': accessToken } });

  // Every test below steps past the sign-in second first. The per-user stamp
  // is compared at second granularity, so without the pause a regression that
  // stamps again would go unnoticed: the surviving token's `iat` would equal
  // the stamp and pass.
  const pastTheSecond = () => new Promise((r) => setTimeout(r, 1_100));

  it('revoking one session refuses its access token and leaves the other session working without a refresh', async () => {
    const userId = await makeEndUser('sid@example.com');
    const a = (await signIn('sid@example.com')).json().data as Session;
    const b = (await signIn('sid@example.com')).json().data as Session;
    expect(claims(a.accessToken).sid).toBeTruthy();
    expect(claims(a.accessToken).sid).not.toBe(claims(b.accessToken).sid);
    const aRow = await prisma.refreshToken.findFirstOrThrow({
      where: { endUserId: userId, sessionId: claims(a.accessToken).sid as string },
    });
    await pastTheSecond();

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${aRow.id}`,
      headers: { ...keyAuth(), 'x-rekey-user-token': b.accessToken },
    });
    expect(del.statusCode).toBe(200);

    const refusedA = await me(a.accessToken);
    expect(refusedA.statusCode).toBe(401);
    expect(refusedA.json().error.code).toBe('USER_TOKEN_INVALID');
    // B's access token, the very one it held before the revoke, still works.
    expect((await me(b.accessToken)).statusCode).toBe(200);
    expect((await prisma.endUser.findUniqueOrThrow({ where: { id: userId } })).sessionsInvalidBefore).toBeNull();
  });

  it('a session keeps its sid across rotation, so revoking it after a refresh still refuses the new access token', async () => {
    const userId = await makeEndUser('sid-rot@example.com');
    const a = (await signIn('sid-rot@example.com')).json().data as Session;
    const rotated = (await refresh(a.refreshToken)).json().data as Session;
    expect(claims(rotated.accessToken).sid).toBe(claims(a.accessToken).sid);
    const head = await prisma.refreshToken.findFirstOrThrow({ where: { endUserId: userId, revokedAt: null } });
    await authService.revokeSession({
      application: await prisma.application.findUniqueOrThrow({ where: { id: appId } }),
      endUserId: userId,
      sessionId: head.id,
    });
    expect((await me(rotated.accessToken)).statusCode).toBe(401);
  });

  it('releasing device D1 refuses the access token bound to D1 and leaves the one bound to D2 working', async () => {
    const userId = await makeEndUser('dev@example.com');
    const d1 = (await signIn('dev@example.com', { fingerprint: 'fp-dev-one-00001' })).json().data as Session;
    const d2 = (await signIn('dev@example.com', { fingerprint: 'fp-dev-two-00001' })).json().data as Session;
    await pastTheSecond();

    const released = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/end-users/${userId}/devices/${d1.deviceId}/release`,
      headers: auth(),
    });
    expect(released.statusCode).toBe(200);

    const refused = await me(d1.accessToken);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('USER_TOKEN_INVALID');
    expect((await me(d2.accessToken)).statusCode).toBe(200);
  });

  it('blocking a device refuses only its access token', async () => {
    const userId = await makeEndUser('blk@example.com');
    const d1 = (await signIn('blk@example.com', { fingerprint: 'fp-blk-one-00001' })).json().data as Session;
    const d2 = (await signIn('blk@example.com', { fingerprint: 'fp-blk-two-00001' })).json().data as Session;
    await pastTheSecond();
    await devicesService.block({ applicationId: appId, endUserId: userId, deviceId: d1.deviceId!, operatorUserId: null });
    expect((await me(d1.accessToken)).statusCode).toBe(401);
    expect((await me(d2.accessToken)).statusCode).toBe(200);
  });

  it('a token whose dev names a device no longer ACTIVE is refused even while its session is live', async () => {
    // Isolates the `dev` check from the `sid` one: the session is untouched.
    await makeEndUser('devonly@example.com');
    const s = (await signIn('devonly@example.com', { fingerprint: 'fp-devonly-00001' })).json().data as Session;
    await prisma.device.update({ where: { id: s.deviceId! }, data: { status: 'RELEASED', releasedAt: new Date() } });
    expect((await me(s.accessToken)).statusCode).toBe(401);
  });

  it('a token minted before the sid claim existed keeps working', async () => {
    await makeEndUser('legacy@example.com');
    const s = (await signIn('legacy@example.com')).json().data as Session;
    const c = claims(s.accessToken);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const { issueUserAccessToken } = await import('../src/lib/jwt.js');
    const legacy = issueUserAccessToken(c.sub as string, appId, application.tokenGeneration).token;
    expect(claims(legacy).sid).toBeUndefined();
    expect((await me(legacy)).statusCode).toBe(200);
  });

  it('a password change still refuses the access tokens of every session', async () => {
    await makeEndUser('pw@example.com');
    const a = (await signIn('pw@example.com')).json().data as Session;
    const b = (await signIn('pw@example.com', { fingerprint: 'fp-pw-device-0001' })).json().data as Session;
    await pastTheSecond();
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...keyAuth(), 'x-rekey-user-token': a.accessToken },
      payload: { currentPassword: PASSWORD, newPassword: 'a-new-and-longer-pass-7q2x' },
    });
    expect(changed.statusCode).toBe(200);
    expect((await me(a.accessToken)).statusCode).toBe(401);
    expect((await me(b.accessToken)).statusCode).toBe(401);
  });

  it('a device refused after the rotation answers a REFRESH_TOKEN_ verdict, so the client drops the spent token', async () => {
    const userId = await makeEndUser('post@example.com');
    const other = (await signIn('post@example.com')).json().data as Session;
    const unbound = (await signIn('post@example.com')).json().data as Session;
    // Preflight admits the machine; the post-rotation `touch` then refuses it,
    // as a same-user admission landing between the two would.
    const spy = vi.spyOn(devicesService, 'touch').mockResolvedValueOnce({ kind: 'limit_reached', limit: 1, devices: [] });
    let res;
    try {
      res = await refresh(unbound.refreshToken, { fingerprint: 'fp-post-rotation-1' });
    } finally {
      spy.mockRestore();
    }
    expect(res.statusCode).toBe(401);
    const err = res.json().error as { code: string; details?: { reason?: string; limit?: number } };
    expect(err.code.startsWith('REFRESH_TOKEN_')).toBe(true);
    expect(err.code).toBe('REFRESH_TOKEN_REVOKED');
    expect(err.details?.reason).toBe('DEVICE_LIMIT_REACHED');
    expect(err.details?.limit).toBe(1);
    // Only this chain ended; the user's other session is untouched.
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(1);
    expect((await refresh(other.refreshToken)).statusCode).toBe(200);
  });
});
