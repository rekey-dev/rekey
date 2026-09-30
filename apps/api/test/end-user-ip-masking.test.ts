/**
 * End-user IP addresses: in full only for OWNER and ADMIN whose credential
 * holds activity:read, masked to /24 or /48 for everyone else, on every
 * operator surface (sessions, impersonation audits, devices and their
 * block/unblock/release responses, the operator MCP device tools) and on
 * secret-key device routes, where the key reads what its minter could.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { maskIp, mayReadRawIps } from '../src/lib/ip-mask.js';
import { UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';
import { allOperatorTools } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

const V4 = '203.0.113.77';
const V6 = '2001:db8:1234:5678::1';
const V4_NET = '203.0.113.0/24';
const V6_NET = '2001:db8:1234::/48';

describe('end-user IP masking', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let euid: string;
  let deviceId: string;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await operatorWorld(app, 'APP_ADMIN');
    const a = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    const eu = await prisma.endUser.create({ data: { applicationId: w.appId, email: 'ip@example.com' } });
    euid = eu.id;
    const owner = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: a.tenantId, role: 'OWNER' } });
    await prisma.refreshToken.create({
      data: { applicationId: w.appId, endUserId: euid, tokenHash: `h-${euid}`, expiresAt: new Date(Date.now() + 86_400_000), ip: V4 },
    });
    await prisma.impersonationAudit.create({
      data: { applicationId: w.appId, tenantId: a.tenantId, operatorUserId: owner.tenantUserId, endUserId: euid, ip: V6 },
    });
    deviceId = (await prisma.device.create({ data: { applicationId: w.appId, endUserId: euid, fingerprint: 'fp-1', lastSeenIp: V4 } })).id;
  });

  const base = () => `/api/v1/tenant/applications/${w.appId}`;

  async function readSurfaces(token: string) {
    const get = (url: string) => w.inject({ method: 'GET', url, headers: bearer(token) });
    const sessions = await get(`${base()}/end-users/${euid}/sessions`);
    const detail = await get(`${base()}/end-users/${euid}`);
    const devices = await get(`${base()}/end-users/${euid}/devices`);
    for (const r of [sessions, detail, devices]) expect(r.statusCode, r.body).toBe(200);
    return {
      session: sessions.json().data.items[0].ip,
      impersonation: detail.json().data.recentImpersonations[0].ip,
      device: devices.json().data.items[0].lastSeenIp,
    };
  }

  async function writeSurfaces(token: string) {
    const post = (url: string, payload: unknown = {}) => w.inject({ method: 'POST', url, headers: bearer(token), payload });
    const block = await post(`${base()}/end-users/${euid}/devices/${deviceId}/block`, { reason: 'test' });
    const unblock = await post(`${base()}/end-users/${euid}/devices/${deviceId}/unblock`);
    const release = await post(`${base()}/end-users/${euid}/devices/${deviceId}/release`);
    for (const r of [block, unblock, release]) expect(r.statusCode, r.body).toBe(200);
    return {
      block: block.json().data.device.lastSeenIp,
      unblock: unblock.json().data.lastSeenIp,
      release: release.json().data.device.lastSeenIp,
    };
  }

  const RAW_READ = { session: V4, impersonation: V6, device: V4 };
  const MASKED_READ = { session: V4_NET, impersonation: V6_NET, device: V4_NET };
  const RAW_WRITE = { block: V4, unblock: V4, release: V4 };
  const MASKED_WRITE = { block: V4_NET, unblock: V4_NET, release: V4_NET };

  it('the OWNER sees addresses in full, on reads and on device writes', async () => {
    expect(await readSurfaces(w.ownerToken)).toEqual(RAW_READ);
    expect(await writeSurfaces(w.ownerToken)).toEqual(RAW_WRITE);
  });

  it('an ADMIN sees addresses in full', async () => {
    await w.promoteToAdmin();
    expect(await readSurfaces(w.memberToken)).toEqual(RAW_READ);
  });

  it('an APP_ADMIN member gets the network only, reads and writes, even holding activity:read', async () => {
    expect(await readSurfaces(w.memberToken)).toEqual(MASKED_READ);
    expect(await writeSurfaces(w.memberToken)).toEqual(MASKED_WRITE);
    await w.setScopes(['end-users:read', 'end-users:write', 'activity:read']);
    expect(await readSurfaces(w.memberToken)).toEqual(MASKED_READ);
  });

  it.each(['APP_VIEWER', 'APP_BILLING'] as const)('an %s member gets the network only', async (role) => {
    await w.grant(role);
    expect(await readSurfaces(w.memberToken)).toEqual(MASKED_READ);
  });

  it('a legacy member (workspace-wide read, no grant) gets the network only', async () => {
    const m = await prisma.tenantMembership.findUniqueOrThrow({ where: { id: w.membershipId } });
    await prisma.applicationGrant.deleteMany({ where: { tenantMembershipId: m.id } });
    await prisma.tenantMembership.update({ where: { id: m.id }, data: { legacyWorkspaceRead: true } });
    expect(await readSurfaces(w.memberToken)).toEqual(MASKED_READ);
  });

  describe('secret keys read what their minter could', () => {
    const mintKey = async (token: string, url = `${base()}/api-keys`) => {
      const r = await w.inject({ method: 'POST', url, headers: bearer(token), payload: { name: 'k', mode: 'live' } });
      expect(r.statusCode, r.body).toBe(201);
      return (r.json().data as { rawKey: string }).rawKey;
    };
    const deviceIpWith = async (key: string) => {
      const list = await w.inject({ method: 'GET', url: `/api/v1/devices?endUserId=${euid}`, headers: bearer(key) });
      expect(list.statusCode, list.body).toBe(200);
      const release = await w.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/release`, headers: bearer(key), payload: { endUserId: euid } });
      expect(release.statusCode, release.body).toBe(200);
      return { list: list.json().data.items[0].lastSeenIp, release: release.json().data.device.lastSeenIp };
    };

    it('an OWNER-minted key reads in full', async () => {
      expect(await deviceIpWith(await mintKey(w.ownerToken))).toEqual({ list: V4, release: V4 });
    });

    it('an APP_ADMIN-minted key reads the network only', async () => {
      await w.setScopes(['developer:write', 'end-users:read']);
      expect(await deviceIpWith(await mintKey(w.memberToken))).toEqual({ list: V4_NET, release: V4_NET });
    });

    it('a key minted through an OWNER PAT narrowed to keys:mint reads the network only', async () => {
      const pat = await w.inject({
        method: 'POST',
        url: '/api/v1/tenant/auth/api-tokens',
        headers: bearer(w.ownerToken),
        payload: { name: 'agent', scopes: ['keys:mint'] },
      });
      const rawPat = (pat.json().data as { rawToken: string }).rawToken;
      const key = await mintKey(rawPat, `/api/v1/tenant/operator/applications/${w.appId}/api-keys`);
      expect(await deviceIpWith(key)).toEqual({ list: V4_NET, release: V4_NET });
    });

    it('a key minted before this was recorded keeps reading in full', async () => {
      const key = await mintKey(w.ownerToken);
      await prisma.apiKey.updateMany({ where: { applicationId: w.appId }, data: { revealsEndUserIps: null } });
      expect(await deviceIpWith(key)).toEqual({ list: V4, release: V4 });
    });
  });

  describe('operator MCP device tools', () => {
    const ctxFor = async (role: 'OWNER' | 'MEMBER', scopes: ReadonlySet<Scope>): Promise<OperatorToolContext> => {
      const a = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
      const m = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: a.tenantId, role } });
      return { tenantUserId: m.tenantUserId, tenantId: a.tenantId, role, tenantMembershipId: m.id, scopes, canWrite: true, canAdmin: true };
    };
    const tool = (name: string) => allOperatorTools.find((t) => t.name === name)!;
    const run = async (ctx: OperatorToolContext) => {
      const args = { applicationId: w.appId, endUserId: euid, deviceId };
      const list = (await tool('list_devices').handler(ctx, args)) as { devices: Array<{ lastSeenIp: string }> };
      const block = (await tool('block_device').handler(ctx, { ...args, reason: 'x' })) as { device: { lastSeenIp: string } };
      const unblock = (await tool('unblock_device').handler(ctx, args)) as { device: { lastSeenIp: string } };
      const release = (await tool('release_device').handler(ctx, args)) as { device: { lastSeenIp: string } };
      return [list.devices[0]!.lastSeenIp, block.device.lastSeenIp, unblock.device.lastSeenIp, release.device.lastSeenIp];
    };

    it('OWNER with activity:read reads in full on all four tools', async () => {
      expect(await run(await ctxFor('OWNER', UNRESTRICTED))).toEqual([V4, V4, V4, V4]);
    });

    it('OWNER whose token lacks activity:read, and a MEMBER, get the network only', async () => {
      const narrowed = new Set<Scope>(['end-users:read', 'end-users:write']);
      expect(await run(await ctxFor('OWNER', narrowed))).toEqual([V4_NET, V4_NET, V4_NET, V4_NET]);
      expect(await run(await ctxFor('MEMBER', UNRESTRICTED))).toEqual([V4_NET, V4_NET, V4_NET, V4_NET]);
    });
  });

  it('decides on the credential\'s own scopes, not the role\'s unrestricted set', () => {
    expect(mayReadRawIps('OWNER', new Set<Scope>(['developer:read', 'developer:write']))).toBe(false);
    expect(mayReadRawIps('ADMIN', new Set<Scope>(['activity:read']))).toBe(true);
    expect(mayReadRawIps('MEMBER', UNRESTRICTED)).toBe(false);
  });

  it('masks each address family to its network in canonical CIDR', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.0/24');
    expect(maskIp('::ffff:198.51.100.9')).toBe('198.51.100.0/24');
    expect(maskIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(maskIp('2001:0db8:0000::1')).toBe('2001:db8::/48');
    expect(maskIp('::1')).toBe('::/48');
    expect(maskIp('not-an-ip')).toBeNull();
    expect(maskIp(null)).toBeNull();
  });
});
