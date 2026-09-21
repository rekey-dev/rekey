/**
 * Device management routes and licence seat release. Three surfaces over one
 * service, each proven through HTTP:
 *
 *   - end-user (`/users/me/devices`): list is redacted (no IP, no operator
 *     notes), release revokes the device's sessions including the caller's
 *     own, and a blocked device cannot be released by its owner;
 *   - secret key (`/devices`): publishable key refused; list and release are
 *     scoped by endUserId so a foreign device id 404s;
 *   - operator (`/tenant/applications/:id/end-users/:euid/devices`): list,
 *     release, block (reason kept operator-side), unblock (comes back
 *     RELEASED), and the workspace boundary;
 *   - licences: `POST /licenses/deactivate` frees a seat idempotently and a
 *     later verify reactivates it; the operator activation list shows
 *     `releasedAt`; activations link to the holder's device.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';

const PASSWORD = 'pw-one-two-three';

describe('device management routes', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let liveKey: string;
  let pubKey: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });
  const secret = (): { authorization: string } => ({ authorization: `Bearer ${liveKey}` });
  const publishable = (): { authorization: string } => ({ authorization: `Bearer ${pubKey}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `dr-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const created = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DR', slug: `dr-${slug}`, enableBilling: true },
      })
      .then((r) => r.json().data as { id: string; publicKey: string });
    appId = created.id;
    pubKey = created.publicKey;
    liveKey = await app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/api-keys`,
        headers: auth(),
        payload: { name: 'k', mode: 'live', scopes: ['*'] },
      })
      .then((r) => (r.json().data as { rawKey: string }).rawKey);
  });

  async function makeEndUser(email: string): Promise<string> {
    return app
      .inject({
        method: 'POST',
        url: `/api/v1/tenant/applications/${appId}/end-users`,
        headers: auth(),
        payload: { email, password: PASSWORD },
      })
      .then((r) => (r.json().data as { id: string }).id);
  }

  type Session = { accessToken: string; refreshToken: string; deviceId: string | null };

  async function signIn(email: string, fingerprint: string, label?: string): Promise<Session> {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: publishable(),
      payload: { email, password: PASSWORD, device: { fingerprint, ...(label && { label }) } },
    });
    expect(r.statusCode).toBe(200);
    return r.json().data as Session;
  }

  const userHeaders = (s: Session) => ({ ...publishable(), 'x-rekey-user-token': s.accessToken });

  it('end-user: lists own devices redacted, releases one (revoking its sessions), cannot release a blocked one', async () => {
    const userId = await makeEndUser('a@example.com');
    const laptop = await signIn('a@example.com', 'fp-a-laptop-0001', 'Laptop');
    const desktop = await signIn('a@example.com', 'fp-a-desktop-001', 'Desktop');

    const list = await app.inject({ method: 'GET', url: '/api/v1/users/me/devices', headers: userHeaders(laptop) });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).not.toHaveProperty('lastSeenIp');
    expect(items[0]).not.toHaveProperty('blockedReason');
    expect(items.map((d) => d.id).sort()).toEqual([laptop.deviceId, desktop.deviceId].sort());

    // Release the desktop from the laptop's session: the desktop's session dies, the laptop's lives.
    const rel = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/me/devices/${desktop.deviceId}`,
      headers: userHeaders(laptop),
    });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().data.sessionsRevoked).toBe(1);
    expect(rel.json().data.device.status).toBe('RELEASED');
    // The release ends only the desktop's session: the laptop's refresh token
    // is live and still renews.
    const laptopRenewed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: publishable(),
      payload: { refreshToken: laptop.refreshToken },
    });
    expect(laptopRenewed.statusCode).toBe(200);
    const laptopNow = laptopRenewed.json().data as Session;
    const refreshDesktop = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: publishable(),
      payload: { refreshToken: desktop.refreshToken },
    });
    expect(refreshDesktop.statusCode).toBe(401);
    const active = await app.inject({ method: 'GET', url: '/api/v1/users/me/devices?status=ACTIVE', headers: userHeaders(laptopNow) });
    expect((active.json().data.items as unknown[]).length).toBe(1);

    // Idempotent.
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/users/me/devices/${desktop.deviceId}`, headers: userHeaders(laptopNow) });
    expect(again.statusCode).toBe(200);
    expect(again.json().data.sessionsRevoked).toBe(0);

    // A blocked device is not the owner's to release.
    await prisma.device.update({ where: { id: laptop.deviceId! }, data: { status: 'BLOCKED', blockedAt: new Date() } });
    const other = await signIn('a@example.com', 'fp-a-third-00001');
    const blockedRel = await app.inject({ method: 'DELETE', url: `/api/v1/users/me/devices/${laptop.deviceId}`, headers: userHeaders(other) });
    expect(blockedRel.statusCode).toBe(409);
    expect(blockedRel.json().error.code).toBe('DEVICE_BLOCKED');

    // Someone else's device id is a 404, not a hint.
    const stranger = await makeEndUser('a2@example.com');
    const strangerSession = await signIn('a2@example.com', 'fp-a2-00000001');
    const foreign = await app.inject({ method: 'DELETE', url: `/api/v1/users/me/devices/${desktop.deviceId}`, headers: userHeaders(strangerSession) });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe('DEVICE_NOT_FOUND');
    void userId;
    void stranger;
  });

  it('secret key: refuses the publishable key, lists with operator-grade fields, releases scoped by end-user', async () => {
    const userId = await makeEndUser('b@example.com');
    const s = await signIn('b@example.com', 'fp-b-000000001', 'B');

    const pub = await app.inject({ method: 'GET', url: `/api/v1/devices?endUserId=${userId}`, headers: publishable() });
    expect(pub.statusCode).toBe(401);

    const list = await app.inject({ method: 'GET', url: `/api/v1/devices?endUserId=${userId}`, headers: secret() });
    expect(list.statusCode).toBe(200);
    const items = list.json().data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveProperty('lastSeenIp');
    expect(items[0]).toHaveProperty('blockedReason');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: secret() });
    expect(missing.statusCode).toBe(400);

    const unknownUser = await app.inject({ method: 'GET', url: '/api/v1/devices?endUserId=nope', headers: secret() });
    expect(unknownUser.statusCode).toBe(404);

    const other = await makeEndUser('b2@example.com');
    const wrongOwner = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${s.deviceId}/release`,
      headers: secret(),
      payload: { endUserId: other },
    });
    expect(wrongOwner.statusCode).toBe(404);

    const rel = await app.inject({
      method: 'POST',
      url: `/api/v1/devices/${s.deviceId}/release`,
      headers: secret(),
      payload: { endUserId: userId },
    });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().data.sessionsRevoked).toBe(1);
  });

  it('operator: list, release, block (reason kept operator-side), unblock → RELEASED, workspace boundary', async () => {
    const userId = await makeEndUser('c@example.com');
    const s = await signIn('c@example.com', 'fp-c-000000001', 'C');
    const base = `/api/v1/tenant/applications/${appId}/end-users/${userId}/devices`;

    const list = await app.inject({ method: 'GET', url: base, headers: auth() });
    expect(list.statusCode).toBe(200);
    expect((list.json().data.items as unknown[]).length).toBe(1);

    const block = await app.inject({ method: 'POST', url: `${base}/${s.deviceId}/block`, headers: auth(), payload: { reason: 'chargeback' } });
    expect(block.statusCode).toBe(200);
    expect(block.json().data.device.status).toBe('BLOCKED');
    expect(block.json().data.device.blockedReason).toBe('chargeback');
    expect(block.json().data.sessionsRevoked).toBe(1);

    // The end-user sees DEVICE_BLOCKED at sign-in and no reason anywhere.
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: publishable(),
      payload: { email: 'c@example.com', password: PASSWORD, device: { fingerprint: 'fp-c-000000001' } },
    });
    expect(refused.statusCode).toBe(403);
    expect(JSON.stringify(refused.json())).not.toContain('chargeback');

    const release = await app.inject({ method: 'POST', url: `${base}/${s.deviceId}/release`, headers: auth() });
    expect(release.statusCode).toBe(409);

    const unblock = await app.inject({ method: 'POST', url: `${base}/${s.deviceId}/unblock`, headers: auth() });
    expect(unblock.statusCode).toBe(200);
    expect(unblock.json().data.status).toBe('RELEASED');
    expect(unblock.json().data.blockedReason).toBeNull();

    const back = await signIn('c@example.com', 'fp-c-000000001');
    expect(back.deviceId).toBe(s.deviceId);

    // Another workspace cannot see or touch it.
    const slug = Math.random().toString(36).slice(2, 8);
    const otherToken = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `dr-other-${slug}@example.com`, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    const foreign = await app.inject({ method: 'GET', url: base, headers: { authorization: `Bearer ${otherToken}` } });
    expect(foreign.statusCode).toBe(404);
  });

  it('licenses: deactivate frees a seat idempotently, verify reactivates it, activations list and link to the device', async () => {
    const userId = await makeEndUser('d@example.com');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
    const { rawKey, license } = await licensesService.issue({ application, endUser, kind: 'SEATS', seatsAllowed: 1 });

    // The holder signs in from machine 1, so a device row exists for the fingerprint.
    const s = await signIn('d@example.com', 'fp-d-machine-0001');

    const verify = (fp: string) =>
      app.inject({ method: 'POST', url: '/api/v1/licenses/verify', headers: publishable(), payload: { key: rawKey, machineFingerprint: fp } });
    const deactivate = (fp: string, key = rawKey) =>
      app.inject({ method: 'POST', url: '/api/v1/licenses/deactivate', headers: publishable(), payload: { key, machineFingerprint: fp } });

    expect((await verify('fp-d-machine-0001')).json().data.ok).toBe(true);
    const full = await verify('fp-d-machine-0002');
    expect(full.json().data).toMatchObject({ ok: false, reason: 'seats_exhausted' });

    // The activation points at the holder's device.
    const activation = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(activation.deviceId).toBe(s.deviceId);

    // Give the seat back; the second machine can now verify.
    const d1 = await deactivate('fp-d-machine-0001');
    expect(d1.statusCode).toBe(200);
    expect(d1.json().data).toEqual({ ok: true, released: true });
    const d1again = await deactivate('fp-d-machine-0001');
    expect(d1again.json().data).toEqual({ ok: true, released: false });
    expect((await verify('fp-d-machine-0002')).json().data.ok).toBe(true);

    // Now machine 1 is the one refused, until machine 2 releases.
    expect((await verify('fp-d-machine-0001')).json().data.reason).toBe('seats_exhausted');
    expect((await deactivate('fp-d-machine-0002')).json().data.released).toBe(true);
    expect((await verify('fp-d-machine-0001')).json().data.ok).toBe(true);
    // Reactivated in place: still two rows, not three.
    expect(await prisma.licenseActivation.count({ where: { licenseId: license.id } })).toBe(2);

    // Deterministic failures, never HTTP errors.
    expect((await deactivate('fp-d-machine-0001', 'rl_lic_nope')).json().data).toEqual({ ok: false, reason: 'unknown' });

    // Operator sees both, with releasedAt on the freed one, and can release by id.
    const list = await app.inject({ method: 'GET', url: `/api/v1/tenant/applications/${appId}/licenses/${license.id}/activations`, headers: auth() });
    expect(list.statusCode).toBe(200);
    const rows = list.json().data.items as Array<{ id: string; machineFingerprint: string; releasedAt: string | null }>;
    expect(rows).toHaveLength(2);
    const m2 = rows.find((r) => r.machineFingerprint === 'fp-d-machine-0002')!;
    expect(m2.releasedAt).not.toBeNull();
    const m1 = rows.find((r) => r.machineFingerprint === 'fp-d-machine-0001')!;
    expect(m1.releasedAt).toBeNull();
    const opRelease = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/licenses/${license.id}/activations/${m1.id}/release`,
      headers: auth(),
    });
    expect(opRelease.statusCode).toBe(200);
    expect(opRelease.json().data.releasedAt).not.toBeNull();
    expect((await verify('fp-d-machine-0002')).json().data.ok).toBe(true);
  });
});
