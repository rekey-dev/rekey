/**
 * The live sections after the KPI row: mix, onboarding, retention, security,
 * billing counts and usage, checked against the seeded rows.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { activeWithin, seedUsers, shiftDay, utcToday, type SeedUser } from './analytics-seed.js';
import { bearer, operatorWorld, type OperatorWorld } from './operator-world.js';

type Json = Record<string, any>;

describe('users analytics: live sections', () => {
  let app: FastifyInstance;
  let w: OperatorWorld;
  let users: SeedUser[];
  const today = utcToday();

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await operatorWorld(app);
    users = await seedUsers(w.appId, 200, 42, 70);
  });

  const get = async (qs: string, token = w.ownerToken): Promise<Json> => {
    const r = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users${qs}`,
      headers: bearer(token),
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().data as Json;
  };
  const count = <T>(xs: T[], pred: (x: T) => boolean): number => xs.filter(pred).length;
  const createdDay = (u: SeedUser): string => u.createdAt.toISOString().slice(0, 10);
  const rowsOf = (b: Json): Record<string, number> => Object.fromEntries(b.rows.map((r: Json) => [r.key, r.count]));

  it('mix: each breakdown over its population, never filtered on its own dimension', async () => {
    const from = shiftDay(today, -29);
    const data = await get('?range=30d&sections=mix&platform=ios');
    const mix = data.sections.mix.data;
    const active = users.filter((u) => u.lastActiveOn !== null && u.lastActiveOn >= from);
    for (const p of ['web', 'ios', 'android']) expect(rowsOf(mix.platform)[p] ?? 0, p).toBe(count(active, (u) => u.platform === p));
    expect(mix.platform.unknown).toBe(count(active, (u) => u.platform === null));
    const iosActive = active.filter((u) => u.platform === 'ios');
    expect(rowsOf(mix.country).DE ?? 0).toBe(count(iosActive, (u) => u.country === 'DE'));
    expect(mix.country.total).toBe(iosActive.length);
    const created = users.filter((u) => u.platform === 'ios' && createdDay(u) >= from);
    expect(rowsOf(mix.createdVia)['oauth:google'] ?? 0).toBe(count(created, (u) => u.createdVia === 'oauth:google'));
    expect(mix.createdVia.unknown).toBe(count(created, (u) => u.createdVia === null));
    expect(data.sections.mix.ignoredFilters).toEqual([]);
  });

  it('onboarding: funnel, counts (completed / skipped / pending) and median', async () => {
    const from = shiftDay(today, -29);
    const data = await get('?range=30d&sections=onboarding');
    const o = data.sections.onboarding.data;
    const cohort = users.filter((u) => createdDay(u) >= from);
    const steps = Object.fromEntries(o.funnel.steps.map((s: Json) => [s.key, s.count]));
    expect(steps.created).toBe(cohort.length);
    expect(steps.verified).toBe(count(cohort, (u) => u.verified));
    expect(steps.first_sign_in).toBe(count(cohort, (u) => u.firstSignedInAt !== null));
    expect(steps.onboarding_completed).toBe(count(cohort, (u) => u.onboardingCompletedAt !== null));
    expect(steps.active_7d).toBe(count(cohort, (u) => u.lastActiveOn !== null && u.lastActiveOn >= shiftDay(today, -6)));
    const completed = count(users, (u) => u.onboardingCompletedAt !== null);
    const skipped = count(users, (u) => u.onboardingCompletedAt === null && u.onboardingSkippedAt !== null);
    expect(o.counts).toEqual({ total: users.length, completed, skipped, pending: users.length - completed - skipped });
    expect(o.cohortCounts.total).toBe(cohort.length);
    const secs = cohort
      .filter((u) => u.onboardingCompletedAt)
      .map((u) => (u.onboardingCompletedAt!.getTime() - u.createdAt.getTime()) / 1000)
      .sort((a, b) => a - b);
    const mid = secs.length / 2;
    const median = secs.length % 2 ? secs[Math.floor(mid)]! : (secs[mid - 1]! + secs[mid]!) / 2;
    expect(o.medianSecondsToComplete).toBe(Math.round(median));
    expect(o.answers).toBeNull();
  });

  it('onboarding answers for a select field need end-users:read and a select or boolean field', async () => {
    await prisma.application.update({
      where: { id: w.appId },
      data: {
        profileSchema: [
          { key: 'team_size', label: 'Team size', type: 'select', options: ['1', '2-10'], requiredForOnboarding: false, writableBy: 'user', showInList: false, pii: false },
          { key: 'bio', label: 'Bio', type: 'text', requiredForOnboarding: false, writableBy: 'user', showInList: false, pii: false },
        ],
      },
    });
    for (const [i, u] of users.slice(0, 10).entries()) {
      await prisma.endUser.update({ where: { id: u.id }, data: { profile: { team_size: i < 7 ? '1' : '2-10' } } });
    }
    const cohort = users.slice(0, 10).filter((u) => createdDay(u) >= shiftDay(today, -29));
    const data = await get('?range=30d&sections=onboarding&profileField=team_size');
    const answers = data.sections.onboarding.data.answers;
    expect(answers.key).toBe('team_size');
    expect((rowsOf(answers.breakdown)['1'] ?? 0) + (rowsOf(answers.breakdown)['2-10'] ?? 0)).toBe(cohort.length);
    expect(data.sections.onboarding.data.fields).toEqual([{ key: 'team_size', label: 'Team size', type: 'select' }]);

    const text = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?sections=onboarding&profileField=bio`,
      headers: bearer(w.ownerToken),
    });
    expect(text.statusCode).toBe(400);
    expect(text.json().error.code).toBe('ANALYTICS_FILTER_UNSUPPORTED');
    expect(text.json().error.fix).toBe('Use one of: team_size.');

    await w.setScopes(['overview:read']);
    const denied = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?sections=onboarding&profileField=team_size`,
      headers: bearer(w.memberToken),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('SCOPE_INSUFFICIENT');
  });

  it('retention: an exact 8-week triangle against the oracle', async () => {
    const data = await get('?sections=retention');
    const cohorts = data.sections.retention.data.cohorts as Json[];
    expect(cohorts).toHaveLength(8);
    const firstStart = shiftDay(today, -55);
    cohorts.forEach((c, i) => {
      const start = shiftDay(firstStart, i * 7);
      expect(c.weekStart).toBe(start);
      const members = users.filter((u) => createdDay(u) >= start && createdDay(u) <= shiftDay(start, 6));
      expect(c.size, `size ${i}`).toBe(members.length);
      expect(c.retained).toHaveLength(8 - i);
      c.retained.forEach((n: number, k: number) => {
        const weekEnd = shiftDay(start, k * 7 + 6);
        expect(n, `cohort ${i} week ${k}`).toBe(count(members, (u) => activeWithin(u, weekEnd, 7)));
      });
    });
  });

  it('security: verified, mfa, passkeys and devices now', async () => {
    const [a, b] = users;
    await prisma.mfaCredential.create({ data: { endUserId: a!.id, secretCiphertext: 'x', backupCodesCiphertext: 'x', enrolledAt: new Date() } });
    await prisma.mfaCredential.create({ data: { endUserId: b!.id, secretCiphertext: 'x', backupCodesCiphertext: 'x' } });
    const s = (await get('?sections=security')).sections.security;
    expect(s.data.total).toBe(users.length);
    expect(s.data.verified.count).toBe(count(users, (u) => u.verified));
    expect(s.data.mfa.count).toBe(1);
    expect(s.data.passkeys.count).toBe(0);
    expect(s.data.devices).toEqual({ active: 0, blocked: 0, released: 0 });
    expect(s.data.lockouts.status).toBe('unavailable');
    const filtered = (await get('?sections=security&mfa=true')).sections.security.data;
    expect(filtered.total).toBe(1);
  });

  it('billing and usage: unavailable while billing is off, forbidden without billing:read, counts when on', async () => {
    const off = await get('?sections=billing,usage');
    expect(off.sections.billing).toMatchObject({ status: 'unavailable', reason: 'billing_disabled' });
    const current = await prisma.application.findUniqueOrThrow({ where: { id: w.appId } });
    await prisma.application.update({
      where: { id: w.appId },
      data: { billingConfig: { ...(current.billingConfig as object), enabled: true } },
    });
    const plan = await prisma.plan.create({
      data: { applicationId: w.appId, slug: 'pro', name: 'Pro', amount: 1000, currency: 'usd', interval: 'MONTH' },
    });
    const yesterday = new Date(Date.now() - 86_400_000);
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: users[0]!.id, planId: plan.id, status: 'ACTIVE', trialEndsAt: yesterday } });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: users[1]!.id, planId: plan.id, status: 'CANCELED', trialEndsAt: yesterday } });
    await prisma.subscription.create({ data: { applicationId: w.appId, endUserId: users[2]!.id, planId: plan.id, status: 'TRIALING' } });
    const meter = await prisma.usageMeter.create({ data: { applicationId: w.appId, slug: 'api', name: 'API calls', unit: 'call' } as never });
    await prisma.usageRecord.create({ data: { meterId: meter.id, endUserId: users[0]!.id, subjectKey: `u:${users[0]!.id}`, quantity: 42 } as never });

    const on = await get('?range=7d&sections=billing,usage');
    expect(on.sections.billing.data.plans).toEqual([
      { planId: plan.id, planName: 'Pro', status: 'ACTIVE', count: 1 },
      { planId: plan.id, planName: 'Pro', status: 'TRIALING', count: 1 },
    ]);
    expect(on.sections.billing.data.trialConversion).toEqual({ ended: 2, converted: 1, rate: 0.5 });
    expect(on.sections.usage.data.meters).toEqual([{ meterId: meter.id, slug: 'api', name: 'API calls', unit: 'call', units: 42 }]);
    expect(on.sections.usage.ignoredFilters).toEqual([]);
    expect((await get('?range=7d&sections=usage&platform=ios')).sections.usage.ignoredFilters).toEqual(['platform']);

    await w.setScopes(['overview:read']);
    const member = await get('', w.memberToken);
    expect(member.sections.billing).toEqual({ status: 'forbidden', scope: 'billing:read' });
    expect(member.sections.usage).toEqual({ status: 'forbidden', scope: 'billing:read' });
    expect(member.sections.kpis.status).toBe('ok');
    const named = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/analytics/users?sections=billing`,
      headers: bearer(w.memberToken),
    });
    expect(named.statusCode).toBe(403);
    expect(named.json().error.code).toBe('SCOPE_INSUFFICIENT');
  });
});
