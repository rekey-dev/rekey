/**
 * Two rules about where money is read and written, held by type-checking
 * `apps/api/src`:
 *
 *   - a subscription's price columns are written only by
 *     `billing/subscription-snapshot.ts`;
 *   - a plan's price columns are read and written only by
 *     `plans/default-price.ts`.
 *
 * No database constraint holds the first, and the second is what lets the
 * plan columns be dropped. The rules read types, so a column that arrives by
 * shorthand, by spread or in a variable is seen like one written out.
 */

import { describe, expect, it } from 'vitest';
import { sourceProgram } from './source-scan/program.js';
import {
  PLAN_PRICE_OWNER,
  SUBSCRIPTION_PRICE_WRITER,
  planPriceColumnUses,
  subscriptionPriceWrites,
} from './source-scan/money-rules.js';

const HEADER = `
import { Prisma, type Plan } from '@prisma/client';
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

  it('reads and writes a plan price column in one file', () => {
    expect(planPriceColumnUses(sourceProgram())).toEqual([]);
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

describe('the plan price rule catches', { timeout: 120_000 }, () => {
  const cases: Array<[string, string]> = [
    ['a property read', `export const f = (plan: Plan) => plan.amount;`],
    ['a read through a relation', `export const f = async (id: string) => (await prisma.subscription.findUniqueOrThrow({ where: { id }, include: { plan: true } })).plan.currency;`],
    ['destructuring', `export const f = (plan: Plan) => { const { pricePerUnitCents } = plan; return pricePerUnitCents; };`],
    ['a select on the plan', `export const f = () => prisma.plan.findMany({ select: { id: true, amount: true } });`],
    ['a select under another model', `export const f = () => prisma.subscription.findMany({ include: { plan: { select: { currency: true } } } });`],
    ['a filter on the column', `export const f = () => prisma.plan.findMany({ where: { amount: { gt: 0 } } });`],
    ['an ordering on the column', `export const f = () => prisma.plan.findMany({ orderBy: { amount: 'asc' } });`],
    ['a plan write', `export const f = (id: string) => prisma.plan.update({ where: { id }, data: { active: false } });`],
    [
      'raw SQL',
      'export const f = () => prisma.$queryRaw(Prisma.sql`SELECT p."amount" FROM "subscriptions" s JOIN "plans" AS p ON p."id" = s."plan_id"`);',
    ],
  ];
  const harmless = `
    export const a = () => prisma.plan.findMany({ where: { active: true }, include: { defaultPrice: true }, orderBy: { defaultPrice: { amount: 'asc' } } });
    export const b = async (id: string) => (await prisma.plan.findUniqueOrThrow({ where: { id }, include: { defaultPrice: true } })).defaultPrice?.amount;
    export const c = () => prisma.subscription.findMany({ include: { plan: { select: { slug: true, defaultPrice: { select: { amount: true, currency: true } } } } } });
  `;

  it('each of them, and leaves the default price row and a plan read that names no price column alone', () => {
    const all = [...cases, ['harmless', harmless] as const];
    const { program, fileOf } = plantAll(all);
    const findings = planPriceColumnUses(program);
    const caught = all.map(([label], index) => [label, findings.some((line) => line.startsWith(fileOf(index)))]);
    expect(caught).toEqual([...cases.map(([label]) => [label, true]), ['harmless', false]]);
  });
});
