/**
 * Three rules about where money is read and written, held by type-checking
 * `apps/api/src`:
 *
 *   - a subscription's price columns are written only by
 *     `billing/subscription-snapshot.ts`;
 *   - a plan row is written only by `plans/default-price.ts`, which keeps
 *     the default price row and `isFree` with it;
 *   - no raw SQL names a money column the model dropped.
 *
 * The database holds that a subscription's three price columns are set
 * together; the first rule is what keeps them agreeing with each other. A
 * typed read of a dropped column no longer compiles, so only SQL strings need
 * the third. The rules read types, so a column that arrives by shorthand, by
 * spread or in a variable is seen like one written out.
 */

import { describe, expect, it } from 'vitest';
import { sourceProgram } from './source-scan/program.js';
import {
  PLAN_PRICE_OWNER,
  SUBSCRIPTION_PRICE_WRITER,
  droppedColumnsInSql,
  planWritesOutsideOwner,
  subscriptionPriceWrites,
} from './source-scan/money-rules.js';

const HEADER = `
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
`;

/** One program holding every planted case, each in a file of its own, because building a program takes seconds. */
function plantAll(cases: ReadonlyArray<readonly [string, string]>) {
  const fileOf = (index: number): string => `src/modules/billing/__planted_${index}__.ts`;
  const program = sourceProgram(Object.fromEntries(cases.map(([, body], index) => [fileOf(index), `${HEADER}\n${body}\n`])));
  return { program, fileOf };
}

describe('the source tree', { timeout: 120_000 }, () => {
  it('writes a subscription price in one file', () => {
    expect(subscriptionPriceWrites(sourceProgram())).toEqual([]);
  });

  it('writes a plan row in one file', () => {
    expect(planWritesOutsideOwner(sourceProgram())).toEqual([]);
  });

  it('names no dropped money column in raw SQL', () => {
    expect(droppedColumnsInSql(sourceProgram())).toEqual([]);
  });

  it('is really being read: both owners exist and the tree is the size it should be', () => {
    const files = sourceProgram().files.map((file) => sourceProgram().relative(file));
    expect(files).toContain(SUBSCRIPTION_PRICE_WRITER);
    expect(files).toContain(PLAN_PRICE_OWNER);
    expect(files.length).toBeGreaterThan(200);
  });
});

describe('the subscription price rule catches', { timeout: 120_000 }, () => {
  const cases: Array<[string, string]> = [
    ['a column written out', `export const f = (id: string) => prisma.subscription.update({ where: { id }, data: { unitAmount: 100 } });`],
    [
      'a shorthand property',
      `export const f = (id: string, currency: string) => prisma.subscription.update({ where: { id }, data: { status: 'ACTIVE', currency } });`,
    ],
    [
      'a spread',
      `export const f = (id: string, price: { planPriceId: string; currency: string; unitAmount: number }) =>
         prisma.subscription.updateMany({ where: { id }, data: { status: 'ACTIVE', ...price } });`,
    ],
    [
      'a variable passed as data',
      `export const f = (id: string) => {
         const data = { status: 'ACTIVE' as const, unitAmount: 5 };
         return prisma.subscription.update({ where: { id }, data });
       };`,
    ],
    [
      'the create half of an upsert',
      `export const f = (applicationId: string, endUserId: string, planId: string) =>
         prisma.subscription.upsert({
           where: { applicationId_endUserId_planId: { applicationId, endUserId, planId } },
           create: { applicationId, endUserId, planId, currency: 'USD' },
           update: {},
         });`,
    ],
    ['raw SQL', 'export const f = (id: string) => prisma.$executeRaw`UPDATE "subscriptions" SET "unit_amount" = 1 WHERE "id" = ${id}`;'],
  ];
  const harmless = `export const f = (id: string) => {
    const data = { status: 'ACTIVE' as const, cancelAt: null };
    return prisma.subscription.update({ where: { id }, data });
  };`;

  it('each of them, and leaves a write that carries no price column alone', () => {
    const all = [...cases, ['harmless', harmless] as const];
    const { program, fileOf } = plantAll(all);
    const findings = subscriptionPriceWrites(program);
    const caught = all.map(([label], index) => [label, findings.some((line) => line.startsWith(fileOf(index)))]);
    expect(caught).toEqual([...cases.map(([label]) => [label, true]), ['harmless', false]]);
  });
});

describe('the plan write rule catches', { timeout: 120_000 }, () => {
  const cases: Array<[string, string]> = [
    ['an update', `export const f = (id: string) => prisma.plan.update({ where: { id }, data: { active: false } });`],
    ['a create', `export const f = (applicationId: string) => prisma.plan.create({ data: { applicationId, slug: 'pro', name: 'Pro' } });`],
    ['an upsert', `export const f = (id: string, applicationId: string) => prisma.plan.upsert({ where: { id }, create: { applicationId, slug: 'pro', name: 'Pro' }, update: {} });`],
    ['raw SQL', 'export const f = (id: string) => prisma.$executeRaw`UPDATE "plans" SET "is_free" = true WHERE "id" = ${id}`;'],
  ];
  const harmless = `
    export const a = () => prisma.plan.findMany({ where: { active: true }, include: { defaultPrice: true }, orderBy: { defaultPrice: { amount: 'asc' } } });
    export const b = (id: string) => prisma.plan.delete({ where: { id } });
    export const c = () => prisma.$queryRaw\`SELECT "id" FROM "plans" WHERE "is_free"\`;
  `;

  it('each of them, and leaves a plan read and a delete alone', () => {
    const all = [...cases, ['harmless', harmless] as const];
    const { program, fileOf } = plantAll(all);
    const findings = planWritesOutsideOwner(program);
    const caught = all.map(([label], index) => [label, findings.some((line) => line.startsWith(fileOf(index)))]);
    expect(caught).toEqual([...cases.map(([label]) => [label, true]), ['harmless', false]]);
  });
});

describe('the dropped column rule catches', { timeout: 120_000 }, () => {
  const cases: Array<[string, string]> = [
    ['a plan column through an alias', 'export const f = () => prisma.$queryRaw(Prisma.sql`SELECT p."amount" FROM "subscriptions" s JOIN "plans" AS p ON p."id" = s."plan_id"`);'],
    ['a plan column in a filter', 'export const f = () => prisma.$queryRaw`SELECT "id" FROM "plans" WHERE "price_per_unit_cents" IS NULL`;'],
    ['a coupon column through an alias', 'export const f = () => prisma.$queryRaw`SELECT c."amount_off" FROM "coupons" c`;'],
    ['a coupon column in an update', 'export const f = (id: string) => prisma.$executeRaw`UPDATE "coupons" SET "currency" = NULL WHERE "id" = ${id}`;'],
  ];
  const harmless = `
    export const a = () => prisma.$queryRaw\`SELECT dp."amount", dp."currency" FROM "plans" AS p JOIN "plan_prices" AS dp ON dp."id" = p."default_price_id"\`;
    export const b = () => prisma.$queryRaw\`SELECT ca."amount_off", ca."currency" FROM "coupons" AS c JOIN "coupon_amounts" AS ca ON ca."coupon_id" = c."id"\`;
    export const c = () => prisma.$queryRaw\`SELECT "currency", "unit_amount" FROM "subscriptions"\`;
  `;

  it('each of them, and leaves the price row and the coupon amount row alone', () => {
    const all = [...cases, ['harmless', harmless] as const];
    const { program, fileOf } = plantAll(all);
    const findings = droppedColumnsInSql(program);
    const caught = all.map(([label], index) => [label, findings.some((line) => line.startsWith(fileOf(index)))]);
    expect(caught).toEqual([...cases.map(([label]) => [label, true]), ['harmless', false]]);
  });
});
