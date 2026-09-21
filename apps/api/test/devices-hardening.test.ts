/**
 * Device hardening:
 *   - the licence routes are throttled per (application, IP), with no
 *     per-Application ceiling so a store outage fails open;
 *   - GDPR erasure deletes a person's devices and tombstones the fingerprint
 *     on retained license activations;
 *   - MCP tools over devices for operators (list / release / block / unblock)
 *     and for the signed-in user (list_my_devices).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { licenseRateLimit, licenseRateLimitKey } from '../src/lib/rate-limit.js';
import { licensesService } from '../src/modules/licenses/licenses.service.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { accountTools } from '../src/modules/mcp/account-tools.js';

const PASSWORD = 'pw-one-two-three';

describe('device hardening', () => {
  let app: FastifyInstance;
  let token: string;
  let appId: string;
  let tenantId: string;
  let tenantUserId: string;

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
    const email = `dh-${slug}@example.com`;
    token = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/sign-up',
        payload: { email, password: PASSWORD, workspaceName: `WS ${slug}` },
      })
      .then((r) => (r.json().data as { accessToken: string }).accessToken);
    appId = await app
      .inject({
        method: 'POST',
        url: '/api/v1/tenant/applications/',
        headers: auth(),
        payload: { name: 'DH', slug: `dh-${slug}`, enableBilling: true },
      })
      .then((r) => (r.json().data as { id: string }).id);
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    tenantId = application.tenantId;
    tenantUserId = (await prisma.tenantUser.findFirstOrThrow({ where: { email } })).id;
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

  const ctx = (): OperatorToolContext => ({
    tenantUserId,
    tenantId,
    role: 'OWNER',
    scopes: UNRESTRICTED,
    canWrite: true,
    canAdmin: true,
  });

  const tool = (name: string) => {
    const t = operatorWriteTools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} missing`);
    return t;
  };

  it('throttles licence verify per (application, IP): a guesser cannot open a fresh bucket per key', () => {
    const req = (body: unknown, application: string | undefined, ip: string) =>
      ({ body, application: application ? { id: application } : undefined, ip }) as unknown as FastifyRequest;
    const a = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1', '203.0.113.9'));
    const guess = licenseRateLimitKey(req({ key: 'rl_lic_other', machineFingerprint: 'fp-2' }, 'app1', '203.0.113.9'));
    const otherApp = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app2', '203.0.113.9'));
    const otherIp = licenseRateLimitKey(req({ key: 'rl_lic_secret', machineFingerprint: 'fp-1' }, 'app1', '198.51.100.7'));
    expect(guess).toBe(a);
    expect(new Set([a, otherApp, otherIp]).size).toBe(3);
    expect(a).toBe('license:app1:203.0.113.9');
    expect(a).not.toContain('rl_lic_secret');
    expect(a).not.toContain('fp-1');
    expect(licenseRateLimit(60).skipOnError).toBe(true);
  });

  it('erasure deletes devices and tombstones activation fingerprints while keeping the rows', async () => {
    const userId = await makeEndUser('erase@example.com');
    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-erase-0000001', label: 'PC' });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const endUser = await prisma.endUser.findUniqueOrThrow({ where: { id: userId } });
    const { rawKey, license } = await licensesService.issue({ application, endUser, kind: 'PERPETUAL' });
    expect((await licensesService.verify({ applicationId: appId, rawKey, machineFingerprint: 'fp-erase-0000001' })).ok).toBe(true);
    const before = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(before.deviceId).not.toBeNull();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${userId}?erasure=true`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    expect(await prisma.device.count({ where: { endUserId: userId } })).toBe(0);
    const after = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: license.id } });
    expect(after.machineFingerprint).toBe(`erased:${after.id}`);
    expect(after.label).toBeNull();
    expect(after.deviceId).toBeNull();
    // The license row itself is retained, as documented.
    expect(await prisma.license.count({ where: { id: license.id } })).toBe(1);
  });

  it("erasing one user leaves another user's activation on the same fingerprint alone", async () => {
    // Devices are unique per (application, end-user, fingerprint), so two
    // accounts can register the same machine: a shared workstation, a client
    // that derives the fingerprint from hardware alone. Erasure used to match
    // activations by fingerprint across the whole Application, which released
    // and renamed B's seat in the course of forgetting A.
    const shared = 'fp-shared-0000001';
    const a = await makeEndUser('erase-a@example.com');
    const b = await makeEndUser('keep-b@example.com');
    await devicesService.touch({ applicationId: appId, endUserId: a, fingerprint: shared, label: 'A' });
    await devicesService.touch({ applicationId: appId, endUserId: b, fingerprint: shared, label: 'B' });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const userA = await prisma.endUser.findUniqueOrThrow({ where: { id: a } });
    const userB = await prisma.endUser.findUniqueOrThrow({ where: { id: b } });
    const licA = await licensesService.issue({ application, endUser: userA, kind: 'PERPETUAL' });
    const licB = await licensesService.issue({ application, endUser: userB, kind: 'PERPETUAL' });
    expect((await licensesService.verify({ applicationId: appId, rawKey: licA.rawKey, machineFingerprint: shared })).ok).toBe(true);
    expect((await licensesService.verify({ applicationId: appId, rawKey: licB.rawKey, machineFingerprint: shared })).ok).toBe(true);
    const bBefore = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: licB.license.id } });
    expect(bBefore.deviceId).not.toBeNull();

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${a}?erasure=true`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    // A's seat: tombstoned and released.
    const aAfter = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: licA.license.id } });
    expect(aAfter.machineFingerprint).toBe(`erased:${aAfter.id}`);
    expect(aAfter.releasedAt).not.toBeNull();

    // B's seat on the same machine: untouched, still bound to B's device.
    const bAfter = await prisma.licenseActivation.findFirstOrThrow({ where: { licenseId: licB.license.id } });
    expect(bAfter.machineFingerprint).toBe(shared);
    expect(bAfter.label).toBe(bBefore.label);
    expect(bAfter.releasedAt).toBeNull();
    expect(bAfter.deviceId).toBe(bBefore.deviceId);
    expect(await prisma.device.count({ where: { endUserId: b } })).toBe(1);
    expect(await prisma.device.count({ where: { endUserId: a } })).toBe(0);
  });

  it('erasure reaches an org-pooled activation that names the subject\'s machine, and only that one', async () => {
    // A pooled licence belongs to the organization, not to the person, but an
    // activation on it that carries the subject's fingerprint still names
    // their machine. A team-mate's activation on the same pooled licence, on a
    // different machine, is not the subject's and stays.
    const a = await makeEndUser('erase-org-a@example.com');
    const b = await makeEndUser('keep-org-b@example.com');
    const org = await prisma.organization.create({
      data: { applicationId: appId, name: 'Pooled', slug: `pooled-${Math.random().toString(36).slice(2, 8)}` },
    });
    await prisma.organizationMembership.createMany({
      data: [
        { organizationId: org.id, endUserId: a, role: 'member' },
        { organizationId: org.id, endUserId: b, role: 'owner' },
      ],
    });
    await devicesService.touch({ applicationId: appId, endUserId: a, fingerprint: 'fp-org-a-0000001' });
    await devicesService.touch({ applicationId: appId, endUserId: b, fingerprint: 'fp-org-b-0000001' });
    const application = await prisma.application.findUniqueOrThrow({ where: { id: appId } });
    const userB = await prisma.endUser.findUniqueOrThrow({ where: { id: b } });
    const pooled = await licensesService.issue({
      application,
      endUser: userB,
      kind: 'SEATS',
      seatsAllowed: 5,
      organizationId: org.id,
    });
    expect((await licensesService.verify({ applicationId: appId, rawKey: pooled.rawKey, machineFingerprint: 'fp-org-a-0000001' })).ok).toBe(true);
    expect((await licensesService.verify({ applicationId: appId, rawKey: pooled.rawKey, machineFingerprint: 'fp-org-b-0000001' })).ok).toBe(true);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenant/applications/${appId}/end-users/${a}?erasure=true`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const rows = await prisma.licenseActivation.findMany({ where: { licenseId: pooled.license.id }, orderBy: { firstSeenAt: 'asc' } });
    expect(rows).toHaveLength(2);
    const [aRow, bRow] = rows as [typeof rows[number], typeof rows[number]];
    expect(aRow.machineFingerprint).toBe(`erased:${aRow.id}`);
    expect(aRow.releasedAt).not.toBeNull();
    expect(bRow.machineFingerprint).toBe('fp-org-b-0000001');
    expect(bRow.releasedAt).toBeNull();
  });

  it('operator MCP tools list, block, unblock and release devices within the workspace only', async () => {
    const userId = await makeEndUser('mcp@example.com');
    const t = await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-mcp-00000001', label: 'MCP' });
    if (t.kind !== 'ok') throw new Error('expected ok');

    const listed = (await tool('list_devices').handler(ctx(), { applicationId: appId, endUserId: userId })) as {
      total: number;
      devices: Array<{ id: string; status: string }>;
    };
    expect(listed.total).toBe(1);
    expect(listed.devices[0]!.id).toBe(t.device.id);

    const blocked = (await tool('block_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id, reason: 'fraud' })) as {
      device: { status: string; blockedReason: string | null };
    };
    expect(blocked.device.status).toBe('BLOCKED');
    expect(blocked.device.blockedReason).toBe('fraud');

    const unblocked = (await tool('unblock_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id })) as {
      device: { status: string };
    };
    expect(unblocked.device.status).toBe('RELEASED');

    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-mcp-00000001' });
    const released = (await tool('release_device').handler(ctx(), { applicationId: appId, endUserId: userId, deviceId: t.device.id })) as {
      device: { status: string };
      sessionsRevoked: number;
    };
    expect(released.device.status).toBe('RELEASED');

    // Another workspace's operator cannot see this end-user.
    const other = ctx();
    other.tenantId = 'not-this-tenant';
    other.tenantUserId = 'nobody';
    await expect(
      tool('list_devices').handler(other, { applicationId: appId, endUserId: userId }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // The write tools are marked as writes.
    for (const name of ['release_device', 'block_device', 'unblock_device']) expect(tool(name).write).toBe(true);
    expect(tool('list_devices').write).toBeFalsy();
  });

  it('end-user MCP list_my_devices returns the signed-in user\'s devices without IPs', async () => {
    const userId = await makeEndUser('me@example.com');
    await devicesService.touch({ applicationId: appId, endUserId: userId, fingerprint: 'fp-me-000000001', label: 'Mine', ip: '203.0.113.5' });
    const t = accountTools.find((x) => x.name === 'list_my_devices');
    if (!t) throw new Error('tool missing');
    const out = (await t.handler({ applicationId: appId, endUserId: userId })) as { devices: Array<Record<string, unknown>> };
    expect(out.devices).toHaveLength(1);
    expect(out.devices[0]!.label).toBe('Mine');
    expect(out.devices[0]).not.toHaveProperty('lastSeenIp');
    expect(out.devices[0]).not.toHaveProperty('fingerprint');
  });
});
