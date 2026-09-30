/**
 * The operator end-user list's activity, audience and billing filters, and
 * the `lastActiveOn` sort the Users overview tables link into.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

describe('end-user list filters', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let users: SeedUser[];

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await operatorWorld(app);
    users = await seedUsers(w.appId, 80, 21);
  });

  const list = (qs: string, token = w.ownerToken) =>
    w.inject({ method: 'GET', url: `/api/v1/tenant/applications/${w.appId}/end-users${qs}`, headers: bearer(token) });
  const ids = async (qs: string): Promise<string[]> => {
    const r = await list(`${qs}${qs.includes('?') ? '&' : '?'}limit=100`);
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().data.items as Array<{ id: string }>).map((u) => u.id).sort();
  };
  const expected = (pred: (u: SeedUser) => boolean) => users.filter(pred).map((u) => u.id).sort();

  it('returns lastActiveOn and lastCountry, and sorts by lastActiveOn with never-active users last', async () => {
    const r = await list('?sort=lastActiveOn&order=desc&limit=100');
    const items = r.json().data.items as Array<{ lastActiveOn: string | null; lastCountry: string | null }>;
    const days = items.map((i) => i.lastActiveOn);
    const firstNull = days.indexOf(null);
    expect(firstNull).toBeGreaterThan(0);
    expect(days.slice(firstNull).every((d) => d === null)).toBe(true);
    const nonNull = days.slice(0, firstNull) as string[];
    expect([...nonNull].sort().reverse()).toEqual(nonNull);
    const asc = (await list('?sort=lastActiveOn&order=asc&limit=100')).json().data.items as Array<{ lastActiveOn: string | null }>;
    expect(asc.at(-1)!.lastActiveOn).toBeNull();
    expect(items.some((i) => i.lastCountry === 'DE')).toBe(true);
  });

  it.each<[string, string, (u: SeedUser) => boolean]>([
    ['platform', '?platform=ios,web', (u) => u.platform === 'ios' || u.platform === 'web'],
    ['country', '?country=de', (u) => u.country === 'DE'],
    ['lastSignInVia', '?lastSignInVia=passkey', (u) => u.via === 'passkey'],
    ['createdVia oauth', '?createdVia=oauth', (u) => (u.createdVia ?? '').startsWith('oauth')],
    ['createdVia unknown', '?createdVia=unknown,operator', (u) => u.createdVia === null || u.createdVia === 'operator'],
    ['onboarding skipped', '?onboarding=skipped', (u) => u.onboardingSkippedAt !== null && u.onboardingCompletedAt === null],
    ['onboarding pending', '?onboarding=pending', (u) => u.onboardingSkippedAt === null && u.onboardingCompletedAt === null],
    ['minSignIns', '?minSignIns=3', (u) => u.signInCount >= 3],
  ])('%s', async (_label, qs, pred) => {
    expect(await ids(qs)).toEqual(expected(pred));
  });

  it('activity window and inactivity (the at-risk table)', async () => {
    const today = utcToday();
    const from = shiftDay(today, -60);
    const recent = await ids(`?activeFrom=${shiftDay(today, -6)}`);
    expect(recent).toEqual(expected((u) => u.lastActiveOn !== null && u.lastActiveOn >= shiftDay(today, -6)));
    const atRisk = await ids(`?activeFrom=${from}&inactiveForDays=14&minSignIns=2`);
    expect(atRisk).toEqual(
      expected((u) => u.lastActiveOn !== null && u.lastActiveOn >= from && u.lastActiveOn <= shiftDay(today, -14) && u.signInCount >= 2),
    );
    const created = await ids(`?createdFrom=${shiftDay(today, -10)}&createdTo=${shiftDay(today, -3)}`);
    expect(created).toEqual(
      expected((u) => {
        const d = u.createdAt.toISOString().slice(0, 10);
        return d >= shiftDay(today, -10) && d <= shiftDay(today, -3);
      }),
    );
  });

  it('mfa, plan and org', async () => {
    const [a, b, c] = users;
    await prisma.mfaCredential.create({ data: { endUserId: a!.id, secretCiphertext: 'x', backupCodesCiphertext: 'x', enrolledAt: new Date() } });
    await prisma.mfaCredential.create({ data: { endUserId: b!.id, secretCiphertext: 'x', backupCodesCiphertext: 'x' } });
    expect(await ids('?mfa=true')).toEqual([a!.id]);
    expect((await ids('?mfa=false')).includes(b!.id)).toBe(true);
    const plan = await prisma.plan.create({
      data: { applicationId: w.appId, slug: 'p', name: 'P', amount: 100, currency: 'usd', interval: 'MONTH' },
    });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: c!.id, planId: plan.id, status: 'TRIALING' } });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: a!.id, planId: plan.id, status: 'CANCELED' } });
    expect(await ids(`?plan=${plan.id}`)).toEqual([c!.id]);
    const org = await prisma.organization.create({ data: { applicationId: w.appId, name: 'O', slug: 'o' } });
    await prisma.organizationMembership.create({ data: { organizationId: org.id, endUserId: b!.id, role: 'member' } as never });
    expect(await ids(`?org=${org.id}`)).toEqual([b!.id]);
  });

  it('refuses plan and org filters without their scopes, and foreign ids with 404', async () => {
    await w.setScopes(['end-users:read']);
    const plan = await list('?plan=any', w.memberToken);
    expect(plan.statusCode).toBe(403);
    expect(plan.json().error.code).toBe('SCOPE_INSUFFICIENT');
    const org = await list('?org=any', w.memberToken);
    expect(org.statusCode).toBe(403);
    const other = await operatorWorld(app);
    const foreignPlan = await prisma.plan.create({
      data: { applicationId: other.appId, slug: 'f', name: 'F', amount: 100, currency: 'usd', interval: 'MONTH' },
    });
    const foreignOrg = await prisma.organization.create({ data: { applicationId: other.appId, name: 'F', slug: 'f' } });
    expect((await list(`?plan=${foreignPlan.id}`)).json().error.code).toBe('PLAN_NOT_FOUND');
    expect((await list(`?org=${foreignOrg.id}`)).json().error.code).toBe('ORGANIZATION_NOT_FOUND');
  });

  it.each(['?activeFrom=2026-13-01', '?createdFrom=2026-02-30', '?activeFrom=2026-05-02&activeTo=2026-05-01', '?platform=amiga', '?inactiveForDays=0', '?mfa=maybe'])(
    '%s is a 400',
    async (qs) => {
      const r = await list(qs);
      expect(r.statusCode, r.body).toBe(400);
    },
  );
});
