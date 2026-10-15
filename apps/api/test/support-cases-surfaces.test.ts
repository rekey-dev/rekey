/**
 * Support mode where it meets the rest of the system: a ban, an erasure and a
 * device release acting on a case, the capability catalogue, the operator role
 * gates, the data export, the operator MCP tools, and the rule that the
 * operator's reason never leaves the case row.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED } from '../src/lib/operator-scopes.js';
import type { OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { allOperatorTools, TOOL_SCOPES } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { waitForDeliveries } from './device-fixtures.js';
import { bearer, operatorWorld } from './operator-world.js';
import { codeOf, PASSWORD, REASON, supportWorld, type Json, type SupportWorld } from './support-fixtures.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const INACTIVE = { active: false, capabilities: [] };

describe('support cases and the rest of the system', () => {
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
    w = await supportWorld(app, 'ss');
    expect((await w.capability('diagnostics.debug')).statusCode).toBe(201);
    expect((await w.capability('beta-builds')).statusCode).toBe(201);
  });

  const closedEvents = (euid: string) =>
    prisma.securityEvent.findMany({
      where: { applicationId: w.appId, subjectEndUserId: euid, type: 'end_user.support_closed' },
    });
  const release = (euid: string, deviceId: string | null) =>
    app.inject({ method: 'POST', url: `${w.base(euid)}/devices/${deviceId}/release`, headers: w.op() });
  const closedPayloads = async (count: number) =>
    (await waitForDeliveries({ applicationId: w.appId, eventType: 'support.closed' }, count)).map(
      (d) => ((d.payload as Json).data as Json).support as Json,
    );

  it('a ban closes the open case in the same transaction, and a banned user cannot get one', async () => {
    const euid = await w.makeUser('ban@example.com');
    const opened = (await w.open(euid)).json().data as Json;

    const ban = await app.inject({ method: 'POST', url: `${w.base(euid)}/ban`, headers: w.op(), payload: { reason: 'fraud' } });
    expect(ban.statusCode, ban.body).toBe(200);

    const state = await w.read(euid);
    expect(state.open).toBeNull();
    expect(state.history[0]).toMatchObject({ id: opened.id, status: 'CLOSED', closedCause: 'banned', closedBy: w.operatorId });
    expect(await closedPayloads(1)).toMatchObject([{ caseId: opened.id, active: false, capabilities: [], closedCause: 'banned' }]);
    const [event] = await closedEvents(euid);
    expect(event).toMatchObject({ actorType: 'operator', actorId: w.operatorId });
    expect(event!.metadata).toMatchObject({ caseId: opened.id, cause: 'banned', capabilities: ['diagnostics.debug'] });

    const refused = await w.open(euid);
    expect([refused.statusCode, codeOf(refused)]).toEqual([403, 'END_USER_BANNED']);
    // Ending is still safe to call, and still a no-op.
    expect((await w.end(euid)).json().data).toEqual({ case: null });

    await app.inject({ method: 'POST', url: `${w.base(euid)}/unban`, headers: w.op() });
    expect((await w.open(euid)).statusCode).toBe(201);
  });

  it('erasure closes the open case, nulls the reason on every case, and an erased user cannot get one', async () => {
    const euid = await w.makeUser('erase@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    expect((await w.end(euid)).statusCode).toBe(200);
    const second = (await w.open(euid, { reason: `${REASON} again` })).json().data as Json;

    const erased = await app.inject({ method: 'DELETE', url: `${w.base(euid)}?erasure=true`, headers: w.op() });
    expect(erased.statusCode, erased.body).toBe(200);

    const rows = await prisma.supportCase.findMany({ where: { endUserId: euid }, orderBy: { openedAt: 'asc' } });
    expect(rows.map((r) => [r.status, r.reason, r.closedCause])).toEqual([
      ['CLOSED', null, 'operator'],
      ['CLOSED', null, 'erased'],
    ]);
    // Erasing the reason is not a change to the case a client could cache on:
    // `updatedAt` is still the moment the case closed.
    expect(rows[1]!.status).toBe('CLOSED');
    expect(rows[1]!.id).toBe(second.id);
    expect(rows[1]!.updatedAt).toEqual(rows[1]!.closedAt);
    const state = await w.read(euid);
    expect(state.open).toBeNull();
    expect(state.history.map((c) => [c.reason, c.endUserEmail])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect((await closedPayloads(2)).map((s) => s.closedCause)).toEqual(['operator', 'erased']);
    expect((await closedEvents(euid)).map((e) => (e.metadata as Json).cause).sort()).toEqual(['erased', 'operator']);

    const refused = await w.open(euid);
    expect([refused.statusCode, codeOf(refused)]).toEqual([410, 'END_USER_ERASED']);
    expect(await prisma.supportCase.count({ where: { endUserId: euid, status: 'OPEN' } })).toBe(0);
  });

  it('releasing the only device of a DEVICES case closes it', async () => {
    const euid = await w.makeUser('one@example.com');
    const a = await w.signIn('one@example.com', 'fp-one-00000001');
    const opened = (await w.open(euid, { deviceIds: [a.deviceId] })).json().data as Json;

    expect((await release(euid, a.deviceId)).statusCode).toBe(200);
    const state = await w.read(euid);
    expect(state.open).toBeNull();
    expect(state.history[0]).toMatchObject({ id: opened.id, closedCause: 'device_released', closedBy: w.operatorId });
    expect(await closedPayloads(1)).toMatchObject([{ closedCause: 'device_released', deviceIds: [a.deviceId] }]);
    const [event] = await closedEvents(euid);
    expect(event).toMatchObject({ actorType: 'operator', actorId: w.operatorId, tenantId: w.tenantId });

    // The same machine signing in again is not back in support mode.
    const again = await w.signIn('one@example.com', 'fp-one-00000001');
    expect(again.deviceId).toBe(a.deviceId);
    expect(await w.support(again.accessToken)).toEqual(INACTIVE);
  });

  it('releasing one of two devices shrinks the case, and that device stays out when it comes back', async () => {
    const euid = await w.makeUser('two@example.com');
    const a = await w.signIn('two@example.com', 'fp-two-0000000a');
    const b = await w.signIn('two@example.com', 'fp-two-0000000b');
    const opened = (await w.open(euid, { deviceIds: [a.deviceId, b.deviceId] })).json().data as Json;
    await new Promise((r) => setTimeout(r, 5));

    // The end-user releases their own device.
    const released = await app.inject({
      method: 'DELETE',
      url: `/api/v1/users/me/devices/${a.deviceId}`,
      headers: { ...w.pk(), 'x-rekey-user-token': b.accessToken },
    });
    expect(released.statusCode, released.body).toBe(200);

    const open = (await w.read(euid)).open!;
    expect(open).toMatchObject({ id: opened.id, status: 'OPEN', scope: 'DEVICES', deviceIds: [b.deviceId] });
    expect(Date.parse(open.updatedAt as string)).toBeGreaterThan(Date.parse(opened.updatedAt as string));
    const [delivery] = await waitForDeliveries({ applicationId: w.appId, eventType: 'support.updated' }, 1);
    expect(((delivery!.payload as Json).data as Json).support).toMatchObject({ active: true, deviceIds: [b.deviceId] });
    const [event] = await prisma.securityEvent.findMany({
      where: { applicationId: w.appId, subjectEndUserId: euid, type: 'end_user.support_updated' },
    });
    expect(event).toMatchObject({ actorType: 'end_user', actorId: euid });
    expect(event!.metadata).toMatchObject({
      deviceIdsBefore: [a.deviceId, b.deviceId].sort(),
      deviceIdsAfter: [b.deviceId],
    });
    expect(await prisma.webhookDelivery.count({ where: { applicationId: w.appId, eventType: 'support.closed' } })).toBe(0);

    const back = await w.signIn('two@example.com', 'fp-two-0000000a');
    expect(back.deviceId).toBe(a.deviceId);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: a.deviceId! } })).status).toBe('ACTIVE');
    expect(await w.support(back.accessToken)).toEqual(INACTIVE);
    expect(await w.support(b.accessToken)).toMatchObject({ active: true, scope: 'device' });
  });

  it('blocking a device takes it out of the case, and unblocking and signing in again do not put it back', async () => {
    const euid = await w.makeUser('blocked@example.com');
    const d1 = await w.signIn('blocked@example.com', 'fp-blocked-0001');
    const d2 = await w.signIn('blocked@example.com', 'fp-blocked-0002');
    const opened = (await w.open(euid, { deviceIds: [d1.deviceId, d2.deviceId] })).json().data as Json;
    const act = (deviceId: string | null, verb: string) =>
      app.inject({ method: 'POST', url: `${w.base(euid)}/devices/${deviceId}/${verb}`, headers: w.op(), payload: {} });

    expect((await act(d2.deviceId, 'block')).statusCode).toBe(200);
    expect((await w.read(euid)).open).toMatchObject({ id: opened.id, scope: 'DEVICES', deviceIds: [d1.deviceId] });
    const [updated] = await prisma.securityEvent.findMany({
      where: { applicationId: w.appId, subjectEndUserId: euid, type: 'end_user.support_updated' },
    });
    expect(updated).toMatchObject({ actorType: 'operator', actorId: w.operatorId });

    expect((await act(d1.deviceId, 'block')).statusCode).toBe(200);
    const state = await w.read(euid);
    expect(state.open).toBeNull();
    expect(state.history[0]).toMatchObject({ id: opened.id, closedCause: 'device_released', closedBy: w.operatorId });
    expect(await closedPayloads(1)).toMatchObject([{ closedCause: 'device_released', deviceIds: [d1.deviceId] }]);

    expect((await act(d1.deviceId, 'unblock')).statusCode).toBe(200);
    const back = await w.signIn('blocked@example.com', 'fp-blocked-0001');
    expect(back.deviceId).toBe(d1.deviceId);
    expect((await prisma.device.findUniqueOrThrow({ where: { id: d1.deviceId! } })).status).toBe('ACTIVE');
    expect(await w.support(back.accessToken)).toEqual(INACTIVE);
    expect((await w.read(euid)).open).toBeNull();
  });

  it('a hard delete closes the open case, removes the reason from every case and frees its capabilities', async () => {
    const euid = await w.makeUser('gone@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    expect((await w.end(euid)).statusCode).toBe(200);
    const second = (await w.open(euid, { capabilities: ['beta-builds'] })).json().data as Json;
    const capabilityUrl = `${w.appBase}/support-capabilities/beta-builds`;
    expect(codeOf(await app.inject({ method: 'DELETE', url: capabilityUrl, headers: w.op() }))).toBe('SUPPORT_CAPABILITY_IN_USE');

    const deleted = await app.inject({ method: 'DELETE', url: w.base(euid), headers: w.op() });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await prisma.endUser.count({ where: { id: euid } })).toBe(0);

    const rows = await prisma.supportCase.findMany({ where: { endUserId: euid }, orderBy: { openedAt: 'asc' } });
    expect(rows.map((r) => [r.status, r.reason, r.closedCause, r.closedBy])).toEqual([
      ['CLOSED', null, 'operator', w.operatorId],
      ['CLOSED', null, 'erased', w.operatorId],
    ]);
    expect((await closedPayloads(2)).map((s) => [s.caseId, s.closedCause])).toContainEqual([second.id, 'erased']);
    const events = await closedEvents(euid);
    expect(events.find((e) => (e.metadata as Json).cause === 'erased')).toMatchObject({
      actorType: 'operator',
      actorId: w.operatorId,
      tenantId: w.tenantId,
    });

    const listed = await app.inject({ method: 'GET', url: `${w.appBase}/support-cases?status=closed`, headers: w.op() });
    expect((listed.json().data as { items: Json[] }).items.map((c) => [c.endUserEmail, c.reason])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect((await app.inject({ method: 'DELETE', url: capabilityUrl, headers: w.op() })).statusCode).toBe(200);
  });

  it('role gate: a viewer reads but cannot write, an app admin can, another workspace gets 404', async () => {
    const world = await operatorWorld(app, 'APP_VIEWER');
    const appBase = `/api/v1/tenant/applications/${world.appId}`;
    const asOwner = bearer(world.ownerToken);
    const asMember = bearer(world.memberToken);
    const created = await world.inject({
      method: 'POST',
      url: `${appBase}/end-users`,
      headers: asOwner,
      payload: { email: 'gate@example.com', password: PASSWORD },
    });
    const euid = (created.json().data as { id: string }).id;
    await world.inject({ method: 'POST', url: `${appBase}/support-capabilities`, headers: asOwner, payload: { name: 'diagnostics.debug' } });
    const base = `${appBase}/end-users/${euid}`;
    const body = { capabilities: ['diagnostics.debug'], reason: REASON };

    const writes: Array<[string, string, Json?]> = [
      ['POST', `${base}/support`, body],
      ['PATCH', `${base}/support`, { capabilities: ['diagnostics.debug'] }],
      ['POST', `${base}/support/end`],
      ['POST', `${appBase}/support-capabilities`, { name: 'viewer-made' }],
      ['DELETE', `${appBase}/support-capabilities/diagnostics.debug`],
    ];
    const reads = [`${base}/support`, `${appBase}/support-cases`, `${appBase}/support-capabilities`];

    for (const [method, url, payload] of writes) {
      const res = await world.inject({ method, url, headers: asMember, ...(payload && { payload }) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    for (const url of reads) {
      expect((await world.inject({ method: 'GET', url, headers: asMember })).statusCode, url).toBe(200);
    }
    expect(await prisma.supportCase.count({ where: { applicationId: world.appId } })).toBe(0);

    await world.grant('APP_ADMIN');
    expect((await world.inject({ method: 'POST', url: `${base}/support`, headers: asMember, payload: body })).statusCode).toBe(201);
    expect(
      (await world.inject({ method: 'PATCH', url: `${base}/support`, headers: asMember, payload: { deviceIds: null } })).statusCode,
    ).toBe(200);

    // A member restricted away from end-users loses both reads and writes.
    await world.setScopes(['overview:read']);
    expect((await world.inject({ method: 'GET', url: `${base}/support`, headers: asMember })).statusCode).toBe(403);
    expect((await world.inject({ method: 'POST', url: `${base}/support/end`, headers: asMember })).statusCode).toBe(403);
    await world.setScopes(null);

    const stranger = bearer(w.operator);
    for (const [method, url, payload] of writes) {
      const res = await world.inject({ method, url, headers: stranger, ...(payload && { payload }) });
      expect(res.statusCode, `stranger ${method} ${url}`).toBe(404);
    }
    for (const url of reads) {
      expect((await world.inject({ method: 'GET', url, headers: stranger })).statusCode, `stranger ${url}`).toBe(404);
    }
    expect(await prisma.supportCase.count({ where: { applicationId: world.appId, status: 'OPEN' } })).toBe(1);

    expect((await world.inject({ method: 'POST', url: `${base}/support/end`, headers: asMember })).statusCode).toBe(200);
  });

  it('catalogue: create, duplicate, invalid names, and delete only when no open case uses it', async () => {
    const dotted = await w.capability('logs.export-v2_raw', 'Raw log export');
    expect(dotted.statusCode, dotted.body).toBe(201);
    expect(dotted.json().data).toMatchObject({ name: 'logs.export-v2_raw', description: 'Raw log export', applicationId: w.appId });

    const duplicate = await w.capability('diagnostics.debug');
    expect([duplicate.statusCode, codeOf(duplicate)]).toEqual([409, 'SUPPORT_CAPABILITY_NAME_TAKEN']);
    for (const name of ['', 'Upper', 'two..dots', '.lead', 'trail-', 'sp ace', 'a'.repeat(65)]) {
      const res = await w.capability(name);
      expect([res.statusCode, codeOf(res)], name).toEqual([400, 'SUPPORT_CAPABILITY_NAME_INVALID']);
    }
    expect((await w.capability('a'.repeat(64))).statusCode).toBe(201);
    const longDescription = await w.capability('described', 'x'.repeat(241));
    expect([longDescription.statusCode, codeOf(longDescription)]).toEqual([400, 'BAD_REQUEST']);
    const nameless = await app.inject({ method: 'POST', url: `${w.appBase}/support-capabilities`, headers: w.op(), payload: {} });
    expect([nameless.statusCode, codeOf(nameless)]).toEqual([400, 'BAD_REQUEST']);

    const capabilityUrl = (name: string) => `${w.appBase}/support-capabilities/${name}`;
    const listed = await app.inject({ method: 'GET', url: `${w.appBase}/support-capabilities`, headers: w.op() });
    expect((listed.json().data as Json[]).map((c) => c.name)).toEqual(
      ['a'.repeat(64), 'beta-builds', 'diagnostics.debug', 'logs.export-v2_raw'].sort(),
    );

    const euid = await w.makeUser('cat@example.com');
    expect((await w.open(euid)).statusCode).toBe(201);
    const inUse = await app.inject({ method: 'DELETE', url: capabilityUrl('diagnostics.debug'), headers: w.op() });
    expect([inUse.statusCode, codeOf(inUse)]).toEqual([409, 'SUPPORT_CAPABILITY_IN_USE']);
    expect((inUse.json().error as Json).message).toContain('1 open support case');
    expect(await prisma.supportCapability.count({ where: { applicationId: w.appId, name: 'diagnostics.debug' } })).toBe(1);

    expect((await w.end(euid)).statusCode).toBe(200);
    const deleted = await app.inject({ method: 'DELETE', url: capabilityUrl('diagnostics.debug'), headers: w.op() });
    expect(deleted.statusCode, deleted.body).toBe(200);
    // The closed case keeps the name as history, and the name can no longer be used.
    expect((await w.read(euid)).history[0]).toMatchObject({ capabilities: ['diagnostics.debug'] });
    const stale = await w.open(euid);
    expect([stale.statusCode, codeOf(stale)]).toEqual([400, 'SUPPORT_CAPABILITY_UNKNOWN']);
    const gone = await app.inject({ method: 'DELETE', url: capabilityUrl('diagnostics.debug'), headers: w.op() });
    expect([gone.statusCode, codeOf(gone)]).toEqual([404, 'SUPPORT_CAPABILITY_NOT_FOUND']);
  });

  it('the export lists support cases, and the reason is in no export, webhook or security event', async () => {
    const euid = await w.makeUser('leak@example.com');
    const a = await w.signIn('leak@example.com', 'fp-leak-0000001');
    const opened = (await w.open(euid)).json().data as Json;
    expect((await w.patch(euid, { capabilities: ['beta-builds'], deviceIds: [a.deviceId] })).statusCode).toBe(200);
    expect((await w.end(euid)).statusCode).toBe(200);
    expect((await w.open(euid)).statusCode).toBe(201);
    expect((await release(euid, a.deviceId)).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `${w.base(euid)}/ban`, headers: w.op(), payload: { reason: 'unrelated' } });

    const exported = await app.inject({ method: 'GET', url: `${w.base(euid)}/export`, headers: w.op() });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).not.toContain('zebra-quartz');
    const document = JSON.parse(exported.body) as { supportCases: Json[] };
    expect(document.supportCases).toHaveLength(2);
    expect(document.supportCases[1]).toEqual({
      id: opened.id,
      status: 'CLOSED',
      capabilities: ['beta-builds'],
      scope: 'DEVICES',
      deviceIds: [a.deviceId],
      openedAt: opened.openedAt,
      updatedAt: expect.any(String),
      closedAt: expect.any(String),
      closedCause: 'operator',
    });
    expect(document.supportCases[0]).toMatchObject({ status: 'CLOSED', closedCause: 'banned' });

    await waitForDeliveries({ applicationId: w.appId, eventType: 'support.closed' }, 2);
    const deliveries = await prisma.webhookDelivery.findMany({ where: { applicationId: w.appId } });
    expect(deliveries.filter((d) => d.eventType.startsWith('support.')).map((d) => d.eventType).sort()).toEqual([
      'support.closed',
      'support.closed',
      'support.opened',
      'support.opened',
      'support.updated',
    ]);
    expect(JSON.stringify(deliveries)).not.toContain('zebra-quartz');
    const events = await prisma.securityEvent.findMany({ where: { applicationId: w.appId } });
    expect(events.filter((e) => e.type.startsWith('end_user.support_'))).toHaveLength(5);
    expect(JSON.stringify(events)).not.toContain('zebra-quartz');
    // The reason is where it belongs, and only there.
    expect((await w.read(euid)).history.map((c) => c.reason)).toEqual([REASON, REASON]);
  });

  it('operator MCP: list_support_cases and close_support_case are scoped, and close closes', async () => {
    expect(TOOL_SCOPES.list_support_cases).toBe('end-users:read');
    expect(TOOL_SCOPES.close_support_case).toBe('end-users:write');
    const tool = (name: string) => {
      const t = allOperatorTools.find((x) => x.name === name);
      if (!t) throw new Error(`tool ${name} missing`);
      return t;
    };
    expect(tool('close_support_case').write).toBe(true);
    expect(tool('close_support_case').minRole).toBeUndefined();
    expect(tool('list_support_cases').write).toBeFalsy();
    for (const name of ['open_support_case', 'update_support_case']) {
      expect(allOperatorTools.some((t) => t.name === name)).toBe(false);
    }

    const ctx = (): OperatorToolContext => ({
      tenantUserId: w.operatorId,
      tenantId: w.tenantId,
      role: 'OWNER',
      scopes: UNRESTRICTED,
      canWrite: true,
      canAdmin: false,
    });
    const euid = await w.makeUser('mcp@example.com');
    const s = await w.signIn('mcp@example.com');
    const opened = (await w.open(euid)).json().data as Json;

    const listed = (await tool('list_support_cases').handler(ctx(), { applicationId: w.appId })) as { total: number; cases: Json[] };
    expect(listed.total).toBe(1);
    expect(listed.cases[0]).toMatchObject({ id: opened.id, endUserId: euid, status: 'OPEN' });

    const stranger = { ...ctx(), tenantId: 'not-this-tenant', tenantUserId: 'nobody' };
    for (const name of ['list_support_cases', 'close_support_case']) {
      await expect(tool(name).handler(stranger, { applicationId: w.appId, endUserId: euid })).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(tool('close_support_case').handler(ctx(), { applicationId: w.appId })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await w.support(s.accessToken)).toMatchObject({ active: true });

    const closed = (await tool('close_support_case').handler(ctx(), { applicationId: w.appId, endUserId: euid })) as { case: Json };
    expect(closed.case).toMatchObject({ id: opened.id, status: 'CLOSED', closedCause: 'operator', closedBy: w.operatorId });
    expect(await w.support(s.accessToken)).toEqual(INACTIVE);
    const [event] = await closedEvents(euid);
    expect(event!.metadata).toMatchObject({ via: 'operator_mcp', cause: 'operator' });

    expect(await tool('close_support_case').handler(ctx(), { applicationId: w.appId, endUserId: euid })).toEqual({ case: null });
    const closedList = (await tool('list_support_cases').handler(ctx(), { applicationId: w.appId, status: 'closed' })) as { total: number };
    expect(closedList.total).toBe(1);
  });
});
