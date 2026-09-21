/**
 * Devices: the model and service behind device binding.
 *
 * What is proven here:
 *   - `touch` registers a new device, refreshes a known one without consuming
 *     a slot, and reactivates a released one in place.
 *   - The `max_devices` FEATURE entitlement is the only limit, it comes from
 *     the plan union (default plan supplies the free tier), and it is enforced
 *     under a lock, concurrent first sign-ins from N new machines never
 *     over-register.
 *   - A BLOCKED fingerprint is refused, and neither release nor a fresh touch
 *     can un-block it; only `unblock` can, and it comes back RELEASED (no slot).
 *   - Release and block revoke the sessions minted on the device, and nothing
 *     else.
 *   - Every outcome that is news reaches the webhook outbox with the right
 *     event type, and a no-op touch reaches nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import {
  makeEndUser as makeEndUserFor,
  setDefaultDeviceLimit as setDefaultDeviceLimitFor,
  waitForDeliveries,
} from './device-fixtures.js';
import { issueRefreshToken } from '../src/lib/refresh-tokens.js';

describe('devices service', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const auth = (): { authorization: string } => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    const slug = Math.random().toString(36).slice(2, 8);
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email: `dv-${slug}@example.com`, password: 'pw-one-two-three', workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DV', slug: `dv-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
  });



  /** Subscribe every event on an endpoint so the outbox records what was emitted. */
  async function subscribeAll(): Promise<void> {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${appId}/webhooks`,
      headers: auth(),
      payload: { url: 'http://127.0.0.1:9/never', events: ['*'] },
    });
    expect(r.statusCode).toBe(201);
  }

  const makeEndUser = (email: string) => makeEndUserFor(app, token, appId, email);
  const setDefaultDeviceLimit = (limit: number) => setDefaultDeviceLimitFor(app, token, appId, limit);

  /** Event types delivered so far, once at least `expected` have landed. */
  async function emitted(expected: number): Promise<string[]> {
    const rows = await waitForDeliveries({ applicationId: appId }, expected);
    return rows.map((r) => r.eventType);
  }

  it('registers, refreshes, and reactivates a device without double-counting', async () => {
    await subscribeAll();
    const userId = await makeEndUser('a@example.com');

    const first = await devicesService.touch({
      applicationId: appId,
      endUserId: userId,
      fingerprint: 'fp-laptop-0001',
      label: 'Laptop',
      ip: '203.0.113.7',
      via: 'sign_in',
    });
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    expect(first.created).toBe(true);
    expect(first.device.status).toBe('ACTIVE');
    expect(first.device.label).toBe('Laptop');
    expect(first.device.lastSeenIp).toBe('203.0.113.7');

    const again = await devicesService.touch({
      applicationId: appId,
      endUserId: userId,
      fingerprint: 'fp-laptop-0001',
      label: 'Laptop (renamed)',
      via: 'refresh',
    });
    expect(again.kind).toBe('ok');
    if (again.kind !== 'ok') return;
    expect(again.created).toBe(false);
    expect(again.device.id).toBe(first.device.id);
    expect(again.device.label).toBe('Laptop (renamed)');

    await devicesService.release({
      applicationId: appId,
      endUserId: userId,
      deviceId: first.device.id,
      actor: { type: 'end_user', id: userId },
    });
    const released = await prisma.device.findUniqueOrThrow({ where: { id: first.device.id } });
    expect(released.status).toBe('RELEASED');
    expect(released.releasedAt).not.toBeNull();

    const back = await devicesService.touch({
      applicationId: appId,
      endUserId: userId,
      fingerprint: 'fp-laptop-0001',
    });
    expect(back.kind).toBe('ok');
    if (back.kind !== 'ok') return;
    expect(back.reactivated).toBe(true);
    expect(back.device.id).toBe(first.device.id);
    expect(back.device.status).toBe('ACTIVE');
    expect(back.device.releasedAt).toBeNull();

    // Exactly one row for the fingerprint, whatever happened to it.
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(1);

    // registered → (refresh: nothing) → released → registered(reactivated).
    // Compared as a multiset: each emit is detached, so the three rows race
    // to createdAt and their order is not a contract. Ordering them was a
    // ~8% flake that became deterministic on a loaded machine.
    expect((await emitted(3)).sort()).toEqual(['device.registered', 'device.registered', 'device.released']);
  });

  it('is uncapped when no plan grants max_devices', async () => {
    const userId = await makeEndUser('b@example.com');
    expect(await devicesService.maxDevicesFor(appId, userId)).toBeNull();
    for (let i = 0; i < 5; i++) {
      const r = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: `fp-${i}-xxxxxx` });
      expect(r.kind).toBe('ok');
    }
    expect(await prisma.device.count({ where: { endUserId: userId, status: 'ACTIVE' } })).toBe(5);
  });

  it('enforces max_devices from the default plan and reports the devices filling the cap', async () => {
    await subscribeAll();
    await setDefaultDeviceLimit(2);
    const userId = await makeEndUser('c@example.com');
    expect(await devicesService.maxDevicesFor(appId, userId)).toBe(2);

    const a = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-aaaaaaaa', label: 'A' });
    const b = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-bbbbbbbb', label: 'B' });
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');

    const c = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-cccccccc', label: 'C' });
    expect(c.kind).toBe('limit_reached');
    if (c.kind !== 'limit_reached') return;
    expect(c.limit).toBe(2);
    expect(c.devices.map((d) => d.label).sort()).toEqual(['A', 'B']);
    // Refused means no row.
    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(2);

    // A known ACTIVE device still refreshes at the cap.
    const aAgain = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-aaaaaaaa' });
    expect(aAgain.kind).toBe('ok');

    // Releasing one frees the slot for the refused machine.
    if (a.kind !== 'ok') return;
    await devicesService.release({ applicationId: appId, endUserId: userId, deviceId: a.device.id, actor: { type: 'end_user', id: userId } });
    const cAgain = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-cccccccc', label: 'C' });
    expect(cAgain.kind).toBe('ok');

    const types = await emitted(5);
    expect(types.filter((t) => t === 'device.limit_reached')).toHaveLength(1);
    expect(types.filter((t) => t === 'device.registered')).toHaveLength(3);
  });

  it('never over-registers under concurrent first sign-ins', async () => {
    await setDefaultDeviceLimit(3);
    const userId = await makeEndUser('d@example.com');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: `fp-race-${i}-xxxx` }),
      ),
    );
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r.kind === 'limit_reached')).toHaveLength(7);
    expect(await prisma.device.count({ where: { endUserId: userId, status: 'ACTIVE' } })).toBe(3);
  });

  it('keeps devices per end-user: the same fingerprint under two accounts is two devices', async () => {
    await setDefaultDeviceLimit(1);
    const u1 = await makeEndUser('e1@example.com');
    const u2 = await makeEndUser('e2@example.com');
    const r1 = await devicesService.touch({ applicationId: appId, endUserId: u1, fingerprint: 'fp-shared-000' });
    const r2 = await devicesService.touch({ applicationId: appId, endUserId: u2, fingerprint: 'fp-shared-000' });
    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    expect(await prisma.device.count({ where: { applicationId: appId, fingerprint: 'fp-shared-000' } })).toBe(2);
  });

  it('block refuses the fingerprint, revokes its sessions, survives release, and unblock returns it RELEASED', async () => {
    await subscribeAll();
    const userId = await makeEndUser('f@example.com');
    const r = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-blockme-01' });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    // Two sessions on the device, one elsewhere. Sessions learn their device
    // in the next PR of the series; here the rows are bound directly so this
    // asserts the service's revocation, not the wiring.
    const onDevice1 = await issueRefreshToken(appId, userId, {});
    const onDevice2 = await issueRefreshToken(appId, userId, {});
    await issueRefreshToken(appId, userId, {});
    await prisma.refreshToken.updateMany({
      where: { id: { in: [onDevice1.record.id, onDevice2.record.id] } },
      data: { deviceId: r.device.id },
    });

    const blocked = await devicesService.block({
      applicationId: appId,
      endUserId: userId,
      deviceId: r.device.id,
      reason: 'chargeback',
      operatorUserId: null,
    });
    expect(blocked.device.status).toBe('BLOCKED');
    expect(blocked.device.blockedReason).toBe('chargeback');
    expect(blocked.sessionsRevoked).toBe(2);
    expect(await prisma.refreshToken.count({ where: { endUserId: userId, revokedAt: null } })).toBe(1);

    const refused = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-blockme-01' });
    expect(refused.kind).toBe('blocked');

    await expect(
      devicesService.release({ applicationId: appId, endUserId: userId, deviceId: r.device.id, actor: { type: 'end_user', id: userId } }),
    ).rejects.toMatchObject({ code: 'DEVICE_BLOCKED' });

    // Idempotent.
    const again = await devicesService.block({ applicationId: appId, endUserId: userId, deviceId: r.device.id, operatorUserId: null });
    expect(again.sessionsRevoked).toBe(0);

    const unblocked = await devicesService.unblock({ applicationId: appId, endUserId: userId, deviceId: r.device.id, operatorUserId: null });
    expect(unblocked.status).toBe('RELEASED');
    expect(unblocked.blockedAt).toBeNull();
    expect(unblocked.blockedReason).toBeNull();

    const back = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-blockme-01' });
    expect(back.kind).toBe('ok');

    expect(await emitted(4)).toEqual([
      'device.registered',
      'device.blocked',
      'device.unblocked',
      'device.registered',
    ]);
  });

  it('scopes get/release/block to the (application, end-user) pair', async () => {
    const u1 = await makeEndUser('g1@example.com');
    const u2 = await makeEndUser('g2@example.com');
    const r = await devicesService.touch({ applicationId: appId, endUserId: u1, fingerprint: 'fp-scoped-0001' });
    if (r.kind !== 'ok') throw new Error('expected ok');
    await expect(devicesService.get(appId, u2, r.device.id)).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    await expect(
      devicesService.release({ applicationId: appId, endUserId: u2, deviceId: r.device.id, actor: { type: 'end_user', id: u2 } }),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
    await expect(
      devicesService.block({ applicationId: appId, endUserId: u2, deviceId: r.device.id, operatorUserId: null }),
    ).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });

  it('backfilled application_id on license activations and lists them app-scoped', async () => {
    // The migration made `license_activations.application_id` NOT NULL and
    // filled it from the license; a fresh insert through Prisma must carry it.
    const userId = await makeEndUser('h@example.com');
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
    const { licensesService } = await import('../src/modules/licenses/licenses.service.js');
    const issued = await licensesService.issue({ application, endUser, kind: 'PERPETUAL' });
    const verified = await licensesService.verify({
      applicationId: appId,
      rawKey: issued.rawKey,
      machineFingerprint: 'fp-license-0001',
    });
    expect(verified.ok).toBe(true);
    const activation = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: issued.license.id } });
    expect(activation.applicationId).toBe(appId);
    expect(activation.releasedAt).toBeNull();
  });
});
