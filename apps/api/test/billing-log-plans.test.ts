/**
 * The plan guard for the billing log readers.
 *
 * `seq` is unique across the whole table, so Postgres can always answer
 * "this Application's events in seq order" by walking that global index and
 * discarding everyone else's rows. It prefers to whenever it guesses the
 * filter matches often, and when the guess is wrong (a filter that matches
 * nothing in this Application) the read visits every event of every
 * Application. Each reader statement is planned here against a table shaped
 * to provoke that, and has to stay on an index that starts with the
 * Application.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { readBillingLog, reconcileApplication, type BillingLogFilter } from '../src/modules/billing-log/index.js';
import { recordStatements } from './analytics-explain.js';

const TYPES = ['payment.recorded', 'checkout.completed', 'subscription.activated', 'payment.refunded', 'coupon.redeemed'] as const;
const APPLICATIONS = 8;
const ROWS = 6000;

const EXPLAIN_FUNCTION = `
CREATE OR REPLACE FUNCTION pg_temp.rk_explain_generic(q text) RETURNS json LANGUAGE plpgsql AS $fn$
DECLARE result json;
BEGIN
  EXECUTE 'EXPLAIN (GENERIC_PLAN, FORMAT JSON) ' || q INTO result;
  RETURN result;
END
$fn$`;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

/** How each statement reaches `billing_events`: the index it uses, or `Seq Scan`. */
function accessPaths(node: PlanNode, out: string[]): string[] {
  const index = node['Index Name'];
  if (index?.startsWith('billing_events')) out.push(index);
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'billing_events') out.push('Seq Scan');
  for (const child of node.Plans ?? []) accessPaths(child, out);
  return out;
}

async function pathsOf(fn: () => Promise<unknown>): Promise<string[]> {
  const statements = (await recordStatements(fn)).filter(
    (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) && sql.includes('"billing_events"'),
  );
  expect(statements.length).toBeGreaterThan(0);
  const paths: string[] = [];
  for (const sql of statements) {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(EXPLAIN_FUNCTION);
      return tx.$queryRawUnsafe<Array<{ plan: Array<{ Plan: PlanNode }> }>>('SELECT pg_temp.rk_explain_generic($1) AS plan', sql);
    });
    accessPaths(plan[0]!.plan[0]!.Plan, paths);
  }
  return paths;
}

describe('billing log reader plans', () => {
  /**
   * Eight Applications, 6,000 events. Each Application holds ONE event type,
   * so a filter on any other type is common in the table and absent here:
   * the case in which the table-wide `seq` index reads everything.
   */
  async function seed(): Promise<string[]> {
    const tenant = await prisma.tenant.create({ data: { name: 'Plans', ownerEmail: 'plans@example.com' } });
    const ids: string[] = [];
    for (let i = 0; i < APPLICATIONS; i += 1) {
      const suffix = randomUUID().slice(0, 8);
      const application = await prisma.application.create({
        data: {
          tenantId: tenant.id,
          name: `App ${suffix}`,
          slug: `plans-${suffix}`,
          publicKey: `rp_pub_plans-${suffix}_${randomUUID().slice(0, 12)}`,
          authConfig: { mfa: 'optional', methods: ['password'], tokenAlg: 'HS256' },
          billingConfig: {},
        },
      });
      ids.push(application.id);
    }
    await prisma.billingEvent.createMany({
      data: Array.from({ length: ROWS }, (_, g) => ({
        applicationId: ids[g % APPLICATIONS]!,
        type: TYPES[(g % APPLICATIONS) % TYPES.length]!,
        tier: 'PERMANENT' as const,
        occurredAt: new Date(Date.now() - g * 1000),
        dedupeKey: `seed-${g}`,
        actorType: 'SYSTEM' as const,
        endUserId: `eu_${g % 300}`,
        subscriptionId: `sub_${g % 500}`,
        paymentId: `pay_${g}`,
        currency: ['USD', 'INR', 'EUR'][g % 3]!,
        amount: 1000,
        data: {},
      })),
    });
    await prisma.$executeRawUnsafe('ANALYZE "billing_events"');
    return ids;
  }

  it('every reader statement reaches the log through an index that starts with the Application', async () => {
    const [applicationId] = await seed();
    const base = { applicationId: applicationId!, limit: 50 };
    const reads: Array<[string, BillingLogFilter]> = [
      ['whole log', base],
      ['next page', { ...base, cursor: '5000' }],
      ['one type, absent here', { ...base, types: ['checkout.completed'] }],
      ['several types', { ...base, types: ['checkout.completed', 'coupon.redeemed', 'payment.recorded'] }],
      ['tier', { ...base, tier: 'DIAGNOSTIC' }],
      ['currency', { ...base, currency: 'INR' }],
      ['end user', { ...base, endUserId: 'eu_8' }],
      ['subscription', { ...base, subscriptionId: 'sub_8' }],
      ['payment', { ...base, paymentId: 'pay_8' }],
      ['time range', { ...base, from: new Date(Date.now() - 3_600_000), to: new Date() }],
      ['everything at once', { ...base, types: ['payment.recorded'], endUserId: 'eu_8', currency: 'USD', tier: 'PERMANENT', cursor: '5000' }],
    ];
    const seen: Record<string, string[]> = {};
    for (const [name, filter] of reads) seen[name] = await pathsOf(() => readBillingLog(filter));
    seen.reconciliation = await pathsOf(() =>
      reconcileApplication(applicationId!, { from: new Date(Date.now() - 86_400_000), to: new Date() }),
    );

    for (const [name, paths] of Object.entries(seen)) {
      expect(paths.length, name).toBeGreaterThan(0);
      expect(paths.filter((path) => !path.startsWith('billing_events_application_id_')), `${name}: ${paths.join(', ')}`).toEqual([]);
    }
    // And the entity trails use the index built for them.
    expect(seen.subscription).toEqual(['billing_events_application_id_subscription_id_seq_idx']);
    expect(seen.payment).toEqual(['billing_events_application_id_payment_id_seq_idx']);
    expect(seen['end user']).toEqual(['billing_events_application_id_end_user_id_seq_idx']);
    expect(seen['one type, absent here']).toEqual(['billing_events_application_id_type_seq_idx']);
    expect(new Set(seen['several types'])).toEqual(new Set(['billing_events_application_id_type_seq_idx']));
  });

  it('a filter that matches nothing in one Application does not read the other Applications', async () => {
    const [applicationId] = await seed();
    const [row] = await prisma.$queryRawUnsafe<Array<{ plan: Array<{ Plan: { 'Actual Rows': number; Plans?: unknown[] } }> }>>(
      `EXPLAIN (ANALYZE, FORMAT JSON)
       SELECT * FROM "billing_events"
        WHERE "application_id" = ANY($1::text[]) AND "tier" = 'DIAGNOSTIC'::"BillingEventTier"
        ORDER BY "application_id" DESC, "seq" DESC LIMIT 51`,
      [applicationId],
    ).then((rows) => rows.map((r) => ({ plan: (r as unknown as { 'QUERY PLAN': typeof r.plan })['QUERY PLAN'] })));
    const text = JSON.stringify(row!.plan);
    const removed = [...text.matchAll(/"Rows Removed by Filter":\s*(\d+)/g)].map((m) => Number(m[1]));
    // Only this Application's own rows were looked at: an eighth of the table.
    expect(Math.max(0, ...removed)).toBeLessThanOrEqual(ROWS / APPLICATIONS);
    expect(text).not.toContain('billing_events_seq_key');
  });
});
