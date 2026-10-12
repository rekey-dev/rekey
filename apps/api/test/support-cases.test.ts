/**
 * Support mode, the case lifecycle and what a session reads:
 *   GET/POST/PATCH /tenant/applications/:id/end-users/:euid/support, POST .../support/end
 *   GET /auth/me?include=support, GET /users/me?include=support, GET /users/:id/support
 *
 * What a ban, an erasure and a device release do to a case, the catalogue,
 * the role gates and the export are in support-cases-surfaces.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { waitForDeliveries } from './device-fixtures.js';
import { codeOf, PASSWORD, REASON, supportWorld, type Json, type SupportWorld } from './support-fixtures.js';

const INACTIVE = { active: false, capabilities: [] };

describe('support cases', () => {
  let app: FastifyInstance;
  let w: SupportWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    w = await supportWorld(app, 'sc');
    for (const name of ['diagnostics.debug', 'beta-builds', 'log_export']) {
      expect((await w.capability(name)).statusCode).toBe(201);
    }
  });

  const supportEvents = (euid: string, type: string) =>
    prisma.securityEvent.findMany({ where: { applicationId: w.appId, subjectEndUserId: euid, type } });

  it('with no case, include=support is inactive and /auth/me without it is unchanged', async () => {
    await w.makeUser('none@example.com');
    const s = await w.signIn('none@example.com', 'fp-none-00000001');
    expect(await w.support(s.accessToken)).toEqual(INACTIVE);

    const plain = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { 'x-rekey-user-token': s.accessToken } });
    expect(plain.json().data).not.toHaveProperty('support');

    const usersMe = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me?include=support',
      headers: { ...w.pk(), 'x-rekey-user-token': s.accessToken },
    });
    expect((usersMe.json().data as Json).support).toEqual(INACTIVE);
  });

  it('a USER case is active on every device and on a session with no device', async () => {
    const euid = await w.makeUser('user@example.com');
    const a = await w.signIn('user@example.com', 'fp-user-0000000a');
    const b = await w.signIn('user@example.com', 'fp-user-0000000b');
    const bare = await w.signIn('user@example.com');

    const res = await w.open(euid, { capabilities: ['log_export', 'diagnostics.debug', 'log_export'] });
    expect(res.statusCode, res.body).toBe(201);
    const opened = res.json().data as Json;
    expect(opened).toMatchObject({
      status: 'OPEN',
      scope: 'USER',
      deviceIds: [],
      capabilities: ['diagnostics.debug', 'log_export'],
      reason: REASON,
      endUserEmail: 'user@example.com',
      openedBy: w.operatorId,
      openedByEmail: expect.stringContaining('op-sc-'),
      closedAt: null,
      closedCause: null,
    });

    for (const s of [a, b, bare]) {
      expect(await w.support(s.accessToken)).toEqual({
        active: true,
        capabilities: ['diagnostics.debug', 'log_export'],
        scope: 'user',
        since: opened.openedAt,
        updatedAt: opened.updatedAt,
      });
    }
    const [delivery] = await waitForDeliveries({ applicationId: w.appId, eventType: 'support.opened' }, 1);
    expect((delivery!.payload as Json).data).toEqual({
      user: { id: euid },
      support: {
        caseId: opened.id,
        active: true,
        capabilities: ['diagnostics.debug', 'log_export'],
        scope: 'USER',
        deviceIds: [],
        since: opened.openedAt,
        updatedAt: opened.updatedAt,
      },
    });
    const [event] = await supportEvents(euid, 'end_user.support_opened');
    expect(event).toMatchObject({ actorType: 'operator', actorId: w.operatorId, tenantId: w.tenantId });
    expect(event!.metadata).toEqual({
      endUserId: euid,
      caseId: opened.id,
      via: 'session',
      capabilities: ['diagnostics.debug', 'log_export'],
      scope: 'USER',
      deviceIds: [],
    });
  });

  it('a DEVICES case is active only on a named device, and inactive on a session with no device', async () => {
    const euid = await w.makeUser('dev@example.com');
    const a = await w.signIn('dev@example.com', 'fp-dev-00000000a');
    const b = await w.signIn('dev@example.com', 'fp-dev-00000000b');
    const bare = await w.signIn('dev@example.com');

    const res = await w.open(euid, { deviceIds: [a.deviceId] });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data).toMatchObject({ scope: 'DEVICES', deviceIds: [a.deviceId] });

    expect(await w.support(a.accessToken)).toMatchObject({ active: true, scope: 'device', capabilities: ['diagnostics.debug'] });
    expect(await w.support(b.accessToken)).toEqual(INACTIVE);
    expect(await w.support(bare.accessToken)).toEqual(INACTIVE);
  });

  it('leaves the entitlements response identical before, during and after a case', async () => {
    const euid = await w.makeUser('ent@example.com');
    const s = await w.signIn('ent@example.com');
    const entitlements = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/billing/entitlements',
          headers: { ...w.sk(), 'x-rekey-user-token': s.accessToken },
        })
      ).body;
    const before = await entitlements();
    expect(JSON.parse(before).success).toBe(true);
    expect((await w.open(euid)).statusCode).toBe(201);
    expect(await entitlements()).toBe(before);
    expect((await w.end(euid)).statusCode).toBe(200);
    expect(await entitlements()).toBe(before);
  });

  it('PATCH shows on the next read, moves updatedAt and records one change with before and after', async () => {
    const euid = await w.makeUser('patch@example.com');
    const a = await w.signIn('patch@example.com', 'fp-patch-000000a');
    const opened = (await w.open(euid)).json().data as Json;
    await new Promise((r) => setTimeout(r, 5));

    const res = await w.patch(euid, { capabilities: ['beta-builds'], deviceIds: [a.deviceId] });
    expect(res.statusCode, res.body).toBe(200);
    const changed = res.json().data as Json;
    expect(changed).toMatchObject({ capabilities: ['beta-builds'], scope: 'DEVICES', deviceIds: [a.deviceId], reason: REASON });
    expect(Date.parse(changed.updatedAt as string)).toBeGreaterThan(Date.parse(opened.updatedAt as string));
    expect(changed.openedAt).toBe(opened.openedAt);

    expect(await w.support(a.accessToken)).toEqual({
      active: true,
      capabilities: ['beta-builds'],
      scope: 'device',
      since: opened.openedAt,
      updatedAt: changed.updatedAt,
    });

    const events = await supportEvents(euid, 'end_user.support_updated');
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({
      endUserId: euid,
      caseId: opened.id,
      via: 'session',
      capabilitiesBefore: ['diagnostics.debug'],
      capabilitiesAfter: ['beta-builds'],
      scopeBefore: 'USER',
      scopeAfter: 'DEVICES',
      deviceIdsBefore: [],
      deviceIdsAfter: [a.deviceId],
    });
    const deliveries = await waitForDeliveries({ applicationId: w.appId, eventType: 'support.updated' }, 1);
    expect(((deliveries[0]!.payload as Json).data as Json).support).toMatchObject({
      active: true,
      capabilities: ['beta-builds'],
      scope: 'DEVICES',
      deviceIds: [a.deviceId],
    });

    // Widen back to every device.
    const widened = await w.patch(euid, { deviceIds: null });
    expect(widened.json().data).toMatchObject({ scope: 'USER', deviceIds: [], capabilities: ['beta-builds'] });
  });

  it('a PATCH that changes nothing writes nothing and announces nothing', async () => {
    const euid = await w.makeUser('noop@example.com');
    const opened = (await w.open(euid, { capabilities: ['beta-builds', 'log_export'] })).json().data as Json;
    for (const body of [{}, { capabilities: ['log_export', 'beta-builds'] }, { deviceIds: null }]) {
      const res = await w.patch(euid, body);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json().data as Json).updatedAt).toBe(opened.updatedAt);
    }
    expect(await supportEvents(euid, 'end_user.support_updated')).toHaveLength(0);
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId, eventType: 'support.updated' } })).toBe(0);
  });

  it('ending a case turns it off on the next read, delivers support.closed, and ending again is a no-op', async () => {
    const euid = await w.makeUser('end@example.com');
    const s = await w.signIn('end@example.com', 'fp-end-00000001');
    const opened = (await w.open(euid)).json().data as Json;
    expect(await w.support(s.accessToken)).toMatchObject({ active: true });
    await new Promise((r) => setTimeout(r, 5));

    const res = await w.end(euid);
    expect(res.statusCode, res.body).toBe(200);
    const closed = (res.json().data as { case: Json }).case;
    expect(closed).toMatchObject({
      id: opened.id,
      status: 'CLOSED',
      closedCause: 'operator',
      closedBy: w.operatorId,
      capabilities: ['diagnostics.debug'],
    });
    // Closing is the newest change to the case, so a consumer keeping the
    // payload with the newest `updatedAt` keeps this one.
    expect(closed.updatedAt).toBe(closed.closedAt);
    expect(Date.parse(closed.updatedAt as string)).toBeGreaterThan(Date.parse(opened.updatedAt as string));
    expect(await w.support(s.accessToken)).toEqual(INACTIVE);

    const [delivery] = await waitForDeliveries({ applicationId: w.appId, eventType: 'support.closed' }, 1);
    expect((delivery!.payload as Json).data).toEqual({
      user: { id: euid },
      support: {
        caseId: opened.id,
        active: false,
        capabilities: [],
        scope: 'USER',
        deviceIds: [],
        since: opened.openedAt,
        updatedAt: closed.updatedAt,
        closedCause: 'operator',
      },
    });

    const again = await w.end(euid);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toEqual({ case: null });
    expect(await supportEvents(euid, 'end_user.support_closed')).toHaveLength(1);
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId, eventType: 'support.closed' } })).toBe(1);

    const state = await w.read(euid);
    expect(state.open).toBeNull();
    expect(state.history.map((c) => c.id)).toEqual([opened.id]);
    expect(state.events.map((e) => e.type)).toEqual(['end_user.support_closed', 'end_user.support_opened']);
    expect(state.events[0]).toMatchObject({ actorEmail: expect.stringContaining('op-sc-') });

    // A new case can be opened once the old one is closed.
    expect((await w.open(euid)).statusCode).toBe(201);
    expect((await w.read(euid)).history).toHaveLength(1);
  });

  it('refuses bad capabilities, a bad reason and an empty device list', async () => {
    const euid = await w.makeUser('bad@example.com');

    const unknown = await w.open(euid, { capabilities: ['diagnostics.debug', 'not-in-catalogue'] });
    expect(unknown.statusCode).toBe(400);
    expect(codeOf(unknown)).toBe('SUPPORT_CAPABILITY_UNKNOWN');
    expect((unknown.json().error as Json).message).toContain('not-in-catalogue');

    const empty = await w.open(euid, { capabilities: [] });
    expect([empty.statusCode, codeOf(empty)]).toEqual([400, 'SUPPORT_CAPABILITIES_REQUIRED']);

    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const res = await w.open(euid, { reason });
      expect([res.statusCode, codeOf(res)]).toEqual([400, 'SUPPORT_REASON_INVALID']);
    }
    const noDevices = await w.open(euid, { deviceIds: [] });
    expect([noDevices.statusCode, codeOf(noDevices)]).toEqual([400, 'SUPPORT_CASE_DEVICES_EMPTY']);
    const unknownKey = await w.open(euid, { expiresAt: '2027-01-01' });
    expect([unknownKey.statusCode, codeOf(unknownKey)]).toEqual([400, 'VALIDATION_ERROR']);
    const noReason = await app.inject({
      method: 'POST',
      url: `${w.base(euid)}/support`,
      headers: w.op(),
      payload: { capabilities: ['diagnostics.debug'] },
    });
    expect([noReason.statusCode, codeOf(noReason)]).toEqual([400, 'BAD_REQUEST']);
    expect(await prisma.supportCase.count({ where: { endUserId: euid } })).toBe(0);

    const none = await w.patch(euid, { capabilities: ['beta-builds'] });
    expect([none.statusCode, codeOf(none)]).toEqual([404, 'SUPPORT_CASE_NOT_OPEN']);

    expect((await w.open(euid)).statusCode).toBe(201);
    const emptyDevices = await w.patch(euid, { deviceIds: [] });
    expect([emptyDevices.statusCode, codeOf(emptyDevices)]).toEqual([400, 'SUPPORT_CASE_DEVICES_EMPTY']);
    const emptyCaps = await w.patch(euid, { capabilities: [] });
    expect([emptyCaps.statusCode, codeOf(emptyCaps)]).toEqual([400, 'SUPPORT_CAPABILITIES_REQUIRED']);
    const unknownPatch = await w.patch(euid, { capabilities: ['nope'] });
    expect([unknownPatch.statusCode, codeOf(unknownPatch)]).toEqual([400, 'SUPPORT_CAPABILITY_UNKNOWN']);
    expect((await w.read(euid)).open).toMatchObject({ capabilities: ['diagnostics.debug'], scope: 'USER' });
  });

  it("refuses another end-user's device, another application's device and a released device", async () => {
    const euid = await w.makeUser('mine@example.com');
    await w.makeUser('theirs@example.com');
    const mine = await w.signIn('mine@example.com', 'fp-mine-0000001');
    const theirs = await w.signIn('theirs@example.com', 'fp-theirs-00001');

    const other = await supportWorld(app, 'sc-other');
    await other.makeUser('elsewhere@example.com');
    const elsewhere = await other.signIn('elsewhere@example.com', 'fp-elsewhere-01');

    for (const deviceId of [theirs.deviceId, elsewhere.deviceId, 'no-such-device']) {
      const res = await w.open(euid, { deviceIds: [mine.deviceId, deviceId] });
      expect([res.statusCode, codeOf(res)], String(deviceId)).toEqual([404, 'SUPPORT_CASE_DEVICE_NOT_FOUND']);
    }
    expect(await prisma.supportCase.count({ where: { endUserId: euid } })).toBe(0);

    expect((await w.open(euid)).statusCode).toBe(201);
    const patched = await w.patch(euid, { deviceIds: [theirs.deviceId] });
    expect([patched.statusCode, codeOf(patched)]).toEqual([404, 'SUPPORT_CASE_DEVICE_NOT_FOUND']);

    const released = await app.inject({
      method: 'POST',
      url: `${w.base(euid)}/devices/${mine.deviceId}/release`,
      headers: w.op(),
    });
    expect(released.statusCode, released.body).toBe(200);
    const inactive = await w.patch(euid, { deviceIds: [mine.deviceId] });
    expect([inactive.statusCode, codeOf(inactive)]).toEqual([409, 'SUPPORT_CASE_DEVICE_NOT_ACTIVE']);
    expect((await w.read(euid)).open).toMatchObject({ scope: 'USER', deviceIds: [] });
  });

  it('a second open is a 409 that names the open case', async () => {
    const euid = await w.makeUser('twice@example.com');
    const first = (await w.open(euid)).json().data as Json;
    const second = await w.open(euid, { capabilities: ['beta-builds'] });
    expect([second.statusCode, codeOf(second)]).toEqual([409, 'SUPPORT_CASE_ALREADY_OPEN']);
    expect((second.json().error as Json).details).toEqual({ caseId: first.id });
    expect((await w.read(euid)).open).toMatchObject({ id: first.id, capabilities: ['diagnostics.debug'] });
  });

  it('eight concurrent opens leave exactly one open case', async () => {
    const euid = await w.makeUser('race@example.com');
    const results = await Promise.all(Array.from({ length: 8 }, () => w.open(euid)));
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    const rows = await prisma.supportCase.findMany({ where: { applicationId: w.appId, endUserId: euid } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('OPEN');
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(codeOf(r)).toBe('SUPPORT_CASE_ALREADY_OPEN');
      expect((r.json().error as Json).details).toEqual({ caseId: rows[0]!.id });
    }
    expect(await supportEvents(euid, 'end_user.support_opened')).toHaveLength(1);
  });

  it('eight changes racing eight first sign-ins on new devices do not deadlock', async () => {
    const euid = await w.makeUser('lock@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => [
        w.patch(euid, { capabilities: [i % 2 === 0 ? 'beta-builds' : 'log_export'] }),
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/sign-in',
          headers: w.pk(),
          payload: { email: 'lock@example.com', password: PASSWORD, device: { fingerprint: `fp-lock-0000000${i}` } },
        }),
      ]).flat(),
    );
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    expect(await prisma.device.count({ where: { endUserId: euid, status: 'ACTIVE' } })).toBe(8);
  });

  it('the unique index refuses a second open case even when the service check is bypassed', async () => {
    const euid = await w.makeUser('index@example.com');
    const row = { applicationId: w.appId, tenantId: w.tenantId, endUserId: euid, capabilities: ['diagnostics.debug'] };
    await prisma.supportCase.create({ data: row });
    await expect(prisma.supportCase.create({ data: row })).rejects.toMatchObject({ code: 'P2002' });
    await prisma.supportCase.updateMany({ where: { endUserId: euid }, data: { status: 'CLOSED' } });
    await prisma.supportCase.create({ data: row });
    expect(await prisma.supportCase.count({ where: { endUserId: euid } })).toBe(2);
  });

  it('a publishable key, a secret key and a user token cannot reach any case or catalogue route', async () => {
    const euid = await w.makeUser('door@example.com');
    const s = await w.signIn('door@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    const routes: Array<[string, string, Json?]> = [
      ['GET', `${w.base(euid)}/support`],
      ['POST', `${w.base(euid)}/support`, { capabilities: ['beta-builds'], reason: 'x' }],
      ['PATCH', `${w.base(euid)}/support`, { capabilities: ['beta-builds'] }],
      ['POST', `${w.base(euid)}/support/end`],
      ['GET', `${w.appBase}/support-cases`],
      ['GET', `${w.appBase}/support-capabilities`],
      ['POST', `${w.appBase}/support-capabilities`, { name: 'sneaky' }],
      ['DELETE', `${w.appBase}/support-capabilities/beta-builds`],
    ];
    const credentials: Array<Record<string, string>> = [
      w.pk(),
      w.sk(),
      { authorization: `Bearer ${s.accessToken}` },
      { ...w.pk(), 'x-rekey-user-token': s.accessToken },
      {},
    ];
    for (const [method, url, payload] of routes) {
      for (const headers of credentials) {
        const res = await app.inject({ method: method as 'GET', url, headers, ...(payload && { payload }) });
        expect([401, 403], `${method} ${url}`).toContain(res.statusCode);
      }
    }
    expect((await w.read(euid)).open).toMatchObject({ capabilities: ['diagnostics.debug'] });
    expect(await prisma.supportCapability.count({ where: { applicationId: w.appId } })).toBe(3);
  });

  it('a `support` field sent by the client on sign-in, refresh or profile update changes nothing', async () => {
    const euid = await w.makeUser('self@example.com');
    const claim = { active: true, capabilities: ['diagnostics.debug'] };
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      headers: w.pk(),
      payload: { email: 'self@example.com', password: PASSWORD, support: claim },
    });
    const s = signIn.statusCode === 200 ? (signIn.json().data as { accessToken: string; refreshToken: string }) : await w.signIn('self@example.com');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: w.pk(),
      payload: { refreshToken: s.refreshToken, support: claim },
    });
    const fresh = await w.signIn('self@example.com');
    for (const payload of [{ support: claim }, { metadata: { support: claim } }]) {
      await app.inject({
        method: 'PATCH',
        url: '/api/v1/users/me',
        headers: { ...w.pk(), 'x-rekey-user-token': fresh.accessToken },
        payload,
      });
    }
    expect(await w.support(fresh.accessToken)).toEqual(INACTIVE);
    expect(await prisma.supportCase.count({ where: { endUserId: euid } })).toBe(0);
  });

  it('secret key: GET /users/:id/support with and without deviceId', async () => {
    const euid = await w.makeUser('server@example.com');
    await w.makeUser('neighbour@example.com');
    const a = await w.signIn('server@example.com', 'fp-server-00001');
    const b = await w.signIn('server@example.com', 'fp-server-00002');
    const foreign = await w.signIn('neighbour@example.com', 'fp-neighbour-01');
    const get = async (query = '', headers: Record<string, string> = w.sk(), id = euid) =>
      app.inject({ method: 'GET', url: `/api/v1/users/${id}/support${query}`, headers });

    expect((await get()).json().data).toEqual(INACTIVE);

    expect((await w.open(euid)).statusCode).toBe(201);
    expect((await get()).json().data).toMatchObject({ active: true, scope: 'user', capabilities: ['diagnostics.debug'] });
    expect((await get(`?deviceId=${a.deviceId}`)).json().data).toMatchObject({ active: true, scope: 'user' });

    expect((await w.patch(euid, { deviceIds: [a.deviceId] })).statusCode).toBe(200);
    expect((await get()).json().data).toEqual(INACTIVE);
    expect((await get(`?deviceId=${a.deviceId}`)).json().data).toMatchObject({ active: true, scope: 'device' });
    expect((await get(`?deviceId=${b.deviceId}`)).json().data).toEqual(INACTIVE);
    expect((await get(`?deviceId=${foreign.deviceId}`)).json().data).toEqual(INACTIVE);
    expect((await get('?deviceId=no-such-device')).json().data).toEqual(INACTIVE);

    const neighbour = await get(`?deviceId=${a.deviceId}`, w.sk(), (await prisma.endUser.findFirstOrThrow({ where: { email: 'neighbour@example.com' } })).id);
    expect(neighbour.json().data).toEqual(INACTIVE);

    expect((await get('', w.pk())).statusCode).toBe(401);
    const missing = await get('', w.sk(), 'no-such-user');
    expect([missing.statusCode, codeOf(missing)]).toEqual([404, 'END_USER_NOT_FOUND']);
    const other = await supportWorld(app, 'sc-key');
    const crossApp = await get('', other.sk());
    expect([crossApp.statusCode, codeOf(crossApp)]).toEqual([404, 'END_USER_NOT_FOUND']);
  });

  it('lists open cases oldest first and closed cases most recently opened first', async () => {
    const first = await w.makeUser('l1@example.com');
    const second = await w.makeUser('l2@example.com');
    const third = await w.makeUser('l3@example.com');
    for (const euid of [first, second, third]) expect((await w.open(euid)).statusCode).toBe(201);
    const list = async (query: string) => {
      const r = await app.inject({ method: 'GET', url: `${w.appBase}/support-cases${query}`, headers: w.op() });
      expect(r.statusCode, r.body).toBe(200);
      return r.json().data as { items: Json[]; page: Json };
    };
    const open = await list('');
    expect(open.items.map((c) => c.endUserId)).toEqual([first, second, third]);
    expect(open.page).toMatchObject({ total: 3, hasMore: false });
    expect((await list('?limit=1&offset=1')).items.map((c) => c.endUserId)).toEqual([second]);

    await w.end(third);
    await w.end(first);
    expect((await list('?status=open')).items.map((c) => c.endUserId)).toEqual([second]);
    expect((await list('?status=closed')).items.map((c) => c.endUserId)).toEqual([third, first]);
    expect((await list(`?status=closed&endUserId=${first}`)).items).toHaveLength(1);
    const bad = await app.inject({ method: 'GET', url: `${w.appBase}/support-cases?status=pending`, headers: w.op() });
    expect(bad.statusCode).toBe(400);
  });
});
