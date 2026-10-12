/**
 * Every DIAGNOSTIC event type is handled by the hourly bound. The set is
 * derived from `BILLING_EVENT_TIER`, so a diagnostic type added by anyone
 * fails here until the bound counts it under a reason and aggregates it.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  BILLING_EVENT_DATA,
  BILLING_EVENT_TIER,
  BillingLogEntrySchema,
  diagnosticReasonOf,
  type BillingEventType,
} from '@rekey.dev/shared-types';
import { buildApp } from '../src/app.js';
import { admitDiagnosticEvent } from '../src/modules/billing-log/diagnostic-bound.js';
import { DIAGNOSTIC_PER_REASON_PER_HOUR, flushDiagnosticAggregates } from '../src/modules/billing-log/index.js';
import { bearer, operatorWorld } from './operator-world.js';

const BOUNDS_OWN_RECORD = 'diagnostic.aggregated';
const DIAGNOSTIC_TYPES = (Object.keys(BILLING_EVENT_TIER) as BillingEventType[]).filter(
  (type) => BILLING_EVENT_TIER[type] === 'DIAGNOSTIC' && type !== BOUNDS_OWN_RECORD,
);
/** Whichever field a type keeps its reason in, this fills it. */
const reasoned = (reason: string) => ({ code: reason, reasonCode: reason, reason, kind: reason });

describe('every diagnostic event type is bounded', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('knows the diagnostic types of all three builders', () => {
    expect([...DIAGNOSTIC_TYPES].sort()).toEqual(
      ['checkout.expired', 'checkout.opened', 'checkout.refused', 'coupon.refused', 'reconciliation.finding'].sort(),
    );
  });

  it.each(DIAGNOSTIC_TYPES)('%s is counted under its own reason and named by the aggregate schema', (type) => {
    const marker = `R_${randomUUID().slice(0, 8).toUpperCase()}`;
    expect(diagnosticReasonOf({ type, data: reasoned(marker) })).toBe(marker);
    const aggregated = BILLING_EVENT_DATA[BOUNDS_OWN_RECORD].safeParse({
      eventType: type,
      reason: 'SOME_REASON',
      windowStart: new Date().toISOString(),
      suppressed: 1,
    });
    expect(aggregated.success, JSON.stringify(aggregated.error?.issues)).toBe(true);
  });

  it('writes one aggregate row per type for what the bound left out, readable in the log', async () => {
    const w = await operatorWorld(app, 'APP_ADMIN');
    const now = new Date();
    for (const type of DIAGNOSTIC_TYPES) {
      const row = { applicationId: w.appId, type, tier: 'DIAGNOSTIC', data: reasoned('SAME_REASON') };
      const admitted: boolean[] = [];
      for (let i = 0; i < DIAGNOSTIC_PER_REASON_PER_HOUR + 3; i += 1) admitted.push(await admitDiagnosticEvent(row, now));
      expect(admitted.filter(Boolean)).toHaveLength(DIAGNOSTIC_PER_REASON_PER_HOUR);
    }
    await flushDiagnosticAggregates(now);

    const res = await w.inject({
      method: 'GET',
      url: `/api/v1/tenant/applications/${w.appId}/billing/events?type=${BOUNDS_OWN_RECORD}&limit=50`,
      headers: bearer(w.ownerToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    const items = (res.json().data as { items: unknown[] }).items.map((entry) => BillingLogEntrySchema.parse(entry));
    const left = items.map((entry) => {
      if (entry.type !== BOUNDS_OWN_RECORD) throw new Error(`unexpected ${entry.type}`);
      return { eventType: entry.data.eventType, reason: entry.data.reason, suppressed: entry.data.suppressed };
    });
    expect(left.sort((a, b) => a.eventType.localeCompare(b.eventType))).toEqual(
      [...DIAGNOSTIC_TYPES].sort().map((eventType) => ({ eventType, reason: 'SAME_REASON', suppressed: 3 })),
    );
  });
});
