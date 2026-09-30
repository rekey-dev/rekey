/**
 * `PATCH /api/v1/tenant/applications/:id/settings`: the reporting timezone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isIanaTimezone } from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { bearer, operatorWorld } from './operator-world.js';

describe('application settings: reporting timezone', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const patch = (w: Awaited<ReturnType<typeof operatorWorld>>, token: string, body: unknown) =>
    w.inject({ method: 'PATCH', url: `/api/v1/tenant/applications/${w.appId}/settings`, headers: bearer(token), payload: body });

  it('defaults to UTC, is set by the owner, shows on the Application and is audited', async () => {
    const w = await operatorWorld(app);
    const before = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}`, headers: bearer(w.ownerToken) });
    expect(before.json().data.reportingTimezone).toBe('UTC');

    const res = await patch(w, w.ownerToken, { reportingTimezone: 'Asia/Kolkata' });
    expect(res.statusCode, res.body).toBe(200);
    const kolkata = 'Asia/Kolkata';
    expect(res.json().data).toEqual({ reportingTimezone: kolkata });
    const after = await w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}`, headers: bearer(w.ownerToken) });
    expect(after.json().data.reportingTimezone).toBe(kolkata);

    await new Promise((r) => setTimeout(r, 50));
    const events = await prisma.securityEvent.findMany({ where: { applicationId: w.appId, type: 'app.settings_updated' } });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ reportingTimezone: { from: 'UTC', to: kolkata } });

    const same = await patch(w, w.ownerToken, { reportingTimezone: 'Asia/Kolkata' });
    expect(same.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(await prisma.securityEvent.count({ where: { applicationId: w.appId, type: 'app.settings_updated' } })).toBe(1);
  });

  it.each(['IST', 'Mars/Olympus_Mons', 'Europe/Berlin; DROP', '', 'EST5EDT'])('refuses %j', async (tz) => {
    const w = await operatorWorld(app);
    const res = await patch(w, w.ownerToken, { reportingTimezone: tz });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: w.appId } })).reportingTimezone).toBe('UTC');
  });

  it.each([
    ['Etc/UTC', 'UTC'],
    ['utc', 'UTC'],
    ['GMT', 'UTC'],
    ['Asia/Kolkata', 'Asia/Kolkata'],
    ['asia/kolkata', 'Asia/Kolkata'],
    ['Europe/Kyiv', 'Europe/Kyiv'],
    ['EUROPE/BERLIN', 'Europe/Berlin'],
  ])('stores %j as %j, a name both Intl and Postgres know', async (input, stored) => {
    const w = await operatorWorld(app);
    const res = await patch(w, w.ownerToken, { reportingTimezone: input });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.reportingTimezone).toBe(stored);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: w.appId } })).reportingTimezone).toBe(stored);
    const [row] = await prisma.$queryRaw<Array<{ ok: boolean }>>`SELECT (now() AT TIME ZONE ${stored}) IS NOT NULL AS ok`;
    expect(row?.ok).toBe(true);
  });

  it.each(['Asia/Calcutta', 'Europe/Kiev'])('refuses %j when the database does not know it', async (legacy) => {
    const [known] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_timezone_names WHERE name = ${legacy}`;
    const w = await operatorWorld(app);
    const res = await patch(w, w.ownerToken, { reportingTimezone: legacy });
    if (Number(known?.n) > 0) {
      expect(res.statusCode).toBe(200);
      return;
    }
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REPORTING_TIMEZONE_UNSUPPORTED');
    expect(res.json().error.fix).toMatch(/Asia\/Kolkata rather than Asia\/Calcutta/);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: w.appId } })).reportingTimezone).toBe('UTC');
  });

  it('refuses unknown keys', async () => {
    const w = await operatorWorld(app);
    const res = await patch(w, w.ownerToken, { timezone: 'Europe/Berlin' });
    expect(res.statusCode).toBe(400);
  });

  it('needs write access and overview:write', async () => {
    const w = await operatorWorld(app, 'APP_VIEWER');
    const viewer = await patch(w, w.memberToken, { reportingTimezone: 'Europe/Berlin' });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe('APP_ACCESS_DENIED');

    await w.grant('APP_ADMIN');
    expect((await patch(w, w.memberToken, { reportingTimezone: 'Europe/Berlin' })).statusCode).toBe(200);

    await w.setScopes(['overview:read', 'end-users:write']);
    const restricted = await patch(w, w.memberToken, { reportingTimezone: 'Europe/Paris' });
    expect(restricted.statusCode).toBe(403);
    expect(restricted.json().error.code).toBe('SCOPE_INSUFFICIENT');
    expect((await prisma.application.findUniqueOrThrow({ where: { id: w.appId } })).reportingTimezone).toBe('Europe/Berlin');
  });

  it('knows real zones', () => {
    for (const tz of ['UTC', 'Europe/Berlin', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'Etc/GMT+5']) {
      expect(isIanaTimezone(tz), tz).toBe(true);
    }
  });
});
