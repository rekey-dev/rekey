/**
 * MCP tools over devices: operators list, block, unblock and release within
 * their workspace only, and a signed-in user lists their own without IPs.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { devicesService } from '../src/modules/devices/devices.service.js';
import { operatorWriteTools } from '../src/modules/tenant-mcp/operator-write-tools.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import { accountTools } from '../src/modules/mcp/account-tools.js';

const PASSWORD = 'pw-one-two-three';

describe('device tools over MCP', () => {
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
