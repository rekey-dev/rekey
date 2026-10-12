/**
 * The billing log's words: every event type has a name, a line and a group,
 * and a real entry of every type parses through the API's schema and reads as
 * a sentence with labelled values.
 */

import { describe, expect, it } from 'vitest';
import {
  BILLING_EVENT_TYPES,
  BillingLogEntrySchema,
  BillingLogPageSchema,
  BillingLogQuerySchema,
  PriceFallbackSummarySchema,
  RECONCILIATION_FINDING_KINDS,
  ReconciliationReportSchema,
  type BillingEventType,
} from '@rekey.dev/shared-types';
import {
  EVENT_COPY,
  FINDING_COPY,
  actorLabel,
  eventFields,
  eventMoney,
  eventSentence,
  typesInGroups,
} from '@/lib/billing-events';
import {
  NO_LOG_ACTORS,
  actorPerson,
  customerLabel,
  logHrefQuery,
  logQuery,
  readEntry,
  readLogFilters,
  readLogPage,
  readPeriod,
} from '@/lib/billing-log';

const NBSP = ' ';

const ENVELOPE = {
  id: 'be_1',
  seq: '42',
  applicationId: 'app_1',
  tier: 'PERMANENT',
  occurredAt: '2026-10-12T10:00:00.000Z',
  recordedAt: '2026-10-12T10:00:01.000Z',
  actor: { type: 'system', id: null },
  endUserId: 'eu_1',
  subscriptionId: null,
  checkoutSessionId: null,
  paymentId: null,
  refundId: null,
  planId: null,
  planPriceId: null,
  couponId: null,
  provider: null,
  providerEventId: null,
  currency: 'USD',
  amount: 1900,
} as const;

const USD = { planPriceId: 'pp_usd', currency: 'USD', amount: 1900 };
const INR = { planPriceId: 'pp_inr', currency: 'INR', amount: 149900 };
const COUNTRY = { buyerCountry: 'IN', buyerCountrySource: 'vouched' };
const TERMS = { active: true, basisPoints: 1500, amounts: [], currencies: ['USD'], planSlugs: ['pro'] };

/** One valid `data` per event type, and the sentence the log shows for it. */
const CASES: Record<BillingEventType, { data: object; sentence: string; over?: object }> = {
  'checkout.opened': {
    data: { planSlug: 'pro', priceShown: USD, priceCharged: USD, reason: 'default', discountAmount: 0, ...COUNTRY },
    sentence: 'Checkout opened for pro at $19.00',
  },
  'checkout.price_fallback': {
    data: { planSlug: 'pro', requested: INR, charged: USD, reason: 'no_provider_for_currency', ...COUNTRY },
    sentence: 'Charged $19.00 because INR could not be charged',
  },
  'checkout.refused': {
    data: { planSlug: 'pro', code: 'BILLING_CURRENCY_CONFLICT', requestedCurrency: 'INR', ...COUNTRY },
    sentence: 'Checkout refused for pro: BILLING_CURRENCY_CONFLICT',
  },
  'checkout.completed': {
    data: { planSlug: 'pro', priceCharged: USD, discountAmount: 300, providerSessionId: 'cs_test_1' },
    sentence: 'Checkout completed for pro at $19.00',
  },
  'checkout.expired': { data: { planSlug: 'pro', reason: 'timed_out' }, sentence: 'Checkout ended unpaid because it timed out' },
  'payment.recorded': {
    data: { priceCharged: USD, discountAmount: 0, providerPaymentId: 'pi_1', verification: 'unverified' },
    sentence: 'Payment of $19.00 recorded as unverified',
  },
  'payment.failed': { data: { providerPaymentId: 'pi_1', failureCode: 'card_declined' }, sentence: 'Payment of $19.00 failed' },
  'payment.not_applied': {
    data: { reason: 'currency_mismatch', expected: INR, providerPaymentId: 'pi_1' },
    sentence: 'Payment of $19.00 was not applied because it was in another currency than the subscription pays in',
  },
  'payment.refunded': {
    data: { refundedAmount: 500, totalRefunded: 500, providerRefundId: 're_1', initiatedBy: 'operator', reasonCode: null },
    sentence: 'Refunded $5.00',
  },
  'payment.unapplied': {
    data: { unappliedPaymentId: 'up_1', reasonCode: 'currency_mismatch' },
    sentence: 'Payment of $19.00 could not be applied and needs a decision',
  },
  'payment.unapplied_resolved': {
    data: { unappliedPaymentId: 'up_1', resolution: 'entitlement_granted' },
    sentence: 'Unapplied payment applied to a subscription',
  },
  'payment.not_recorded': {
    data: { kind: 'refund', reason: 'payment_unknown', providerPaymentId: 'pi_9', providerRefundId: 're_9', reportedAmount: '500' },
    sentence: 'A provider reported a refund that was not recorded because it names a payment that is not on record',
  },
  'subscription.activated': {
    data: { planSlug: 'pro', price: USD, via: 'checkout', trial: true },
    sentence: 'Subscription to pro started in a trial',
  },
  'subscription.canceled': {
    data: { planSlug: 'pro', atPeriodEnd: true, cause: 'operator' },
    sentence: 'Subscription to pro canceled at the end of its period',
  },
  'subscription.granted': { data: { planSlug: 'pro', price: null }, sentence: 'Subscription to pro granted' },
  'subscription.imported': { data: { planSlug: 'pro', price: USD, importRunId: 'run_1' }, sentence: 'Subscription to pro imported' },
  'subscription.priced': {
    data: { planSlug: 'pro', before: USD, after: INR, cause: 'first_payment' },
    sentence: 'Subscription price changed from $19.00 to ₹1,499.00',
  },
  'coupon.redeemed': {
    data: { code: 'LAUNCH', planSlug: 'pro', discountAmount: 300, priceCharged: USD },
    sentence: 'Coupon LAUNCH took $3.00 off pro',
  },
  'coupon.refused': {
    data: { code: 'LAUNCH', planSlug: 'pro', reasonCode: 'COUPON_CURRENCY_NOT_COVERED', chargedCurrency: 'INR' },
    sentence: 'Coupon LAUNCH refused: COUPON_CURRENCY_NOT_COVERED',
  },
  'coupon.created': { data: { code: 'LAUNCH', discountType: 'PERCENT', terms: TERMS }, sentence: 'Coupon LAUNCH created' },
  'coupon.changed': {
    data: { code: 'LAUNCH', discountType: 'PERCENT', before: TERMS, after: { ...TERMS, active: false } },
    sentence: 'Coupon LAUNCH switched off',
  },
  'credits.granted': { data: { credits: 500, source: 'purchase', balanceAfter: 1500 }, sentence: '500 credits granted' },
  'plan.price_set': {
    data: { planSlug: 'pro', isDefault: true, before: { amount: 1900, countries: [] }, after: { amount: 2400, countries: [] } },
    sentence: 'Price of pro changed from $19.00 to $24.00',
    over: { amount: 2400 },
  },
  'plan.price_archived': {
    data: { planSlug: 'pro', amount: 1900, outcome: 'archived' },
    sentence: 'USD price of pro archived',
  },
  'plan.local_prices_changed': {
    data: { planSlug: 'pro', before: 'inherit', after: 'off' },
    sentence: 'Local prices on pro changed from inherit to off',
  },
  'provider.currencies_changed': {
    data: { before: ['USD'], after: ['USD', 'EUR'] },
    sentence: 'stripe now takes USD, EUR',
    over: { provider: 'stripe', currency: null, amount: null },
  },
  'settings.local_prices_changed': {
    data: { before: 'trusted', after: 'any' },
    sentence: 'Local prices setting changed from trusted to any',
  },
  'settings.unavailable_currency_changed': {
    data: { before: 'fallback', after: 'refuse' },
    sentence: 'A checkout that names a currency nobody can charge is now refused',
  },
  'settings.reporting_currency_changed': {
    data: { before: 'USD', after: 'EUR' },
    sentence: 'Reporting currency changed from USD to EUR',
  },
  'diagnostic.aggregated': {
    data: { eventType: 'checkout.refused', reason: 'BILLING_CURRENCY_CONFLICT', windowStart: '2026-10-12T10:00:00.000Z', suppressed: 40 },
    sentence: '40 more checkout refused entries (BILLING_CURRENCY_CONFLICT) counted and not listed',
  },
  'reconciliation.finding': {
    data: { kind: 'refund_mismatch', refundedOnPayment: 500, refundRowsTotal: 300, refundEventsTotal: 300 },
    sentence:
      'Reconciliation found that a payment’s refunds add up differently in the payment, the refund records and the log',
  },
};

function entryOf(type: BillingEventType) {
  const { data, over } = CASES[type];
  return BillingLogEntrySchema.parse({ ...ENVELOPE, ...over, type, data });
}

describe('every billing event type', () => {
  it('has a name, a one-line description and a group', () => {
    expect(Object.keys(EVENT_COPY).sort()).toEqual([...BILLING_EVENT_TYPES].sort());
    for (const type of BILLING_EVENT_TYPES) {
      expect(EVENT_COPY[type].title.length).toBeGreaterThan(3);
      expect(EVENT_COPY[type].description.endsWith('.')).toBe(true);
    }
  });

  it('carries no em dash in its words', () => {
    const text = JSON.stringify([EVENT_COPY, FINDING_COPY, Object.values(CASES).map((entry) => entry.sentence)]);
    expect(text).not.toContain('—');
  });

  it.each(BILLING_EVENT_TYPES)('%s parses through the schema and reads as a sentence with labelled values', (type) => {
    const entry = entryOf(type);
    expect(eventSentence(entry)).toBe(CASES[type].sentence);
    const fields = eventFields(entry);
    expect(fields.length).toBeGreaterThan(0);
    for (const item of fields) {
      expect(item.label).not.toBe('');
      expect(item.value).not.toContain('[object');
      expect(item.value).not.toBe('undefined');
    }
  });

  it('puts each type in exactly one view', () => {
    const grouped = [...typesInGroups(['money', 'refusal']), ...typesInGroups(['configuration']), ...typesInGroups(['diagnostic'])];
    expect(grouped.sort()).toEqual([...BILLING_EVENT_TYPES].sort());
  });
});

describe('event values', () => {
  it('writes each amount in its own currency, with no decimals where the currency has none', () => {
    expect(eventMoney(1500, 'JPY')).toBe('¥1,500');
    expect(eventMoney(500000, 'HUF')).toBe(`HUF${NBSP}5,000`);
    expect(eventMoney(1999, 'USD')).toBe('$19.99');
    expect(eventMoney(null, 'USD')).toBeNull();
    expect(eventMoney(12, null)).toBe('12');
  });

  it('says where the buyer was and how far that can be believed', () => {
    const fields = eventFields(entryOf('checkout.price_fallback'));
    expect(fields).toContainEqual({ label: 'Buyer country', value: 'IN, vouched for by a trusted proxy' });
    expect(fields).toContainEqual({ label: 'Price selected', value: '₹1,499.00' });
    expect(fields).toContainEqual({ label: 'Price charged', value: '$19.00' });
  });

  it('writes coupon terms before and after', () => {
    const fields = eventFields(entryOf('coupon.changed'));
    expect(fields).toContainEqual({ label: 'Before', value: '15% off, in USD; pro; active' });
    expect(fields).toContainEqual({ label: 'After', value: '15% off, in USD; pro; inactive' });
  });

  it('writes a coupon expiry and redemption limits before and after, when the entry carries them', () => {
    const limits = { endsAt: null, maxRedemptions: 50, maxRedemptionsPerUser: null };
    const entry = BillingLogEntrySchema.parse({
      ...entryOf('coupon.changed'),
      data: {
        code: 'LAUNCH',
        discountType: 'PERCENT',
        before: { ...TERMS, ...limits },
        after: { ...TERMS, ...limits, endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 20, maxRedemptionsPerUser: 2 },
      },
    });
    const fields = eventFields(entry);
    expect(fields).toContainEqual({
      label: 'Before',
      value: '15% off, in USD; pro; active; never expires; at most 50 redemptions; no limit per buyer',
    });
    expect(fields).toContainEqual({
      label: 'After',
      value: '15% off, in USD; pro; active; expires 2026-12-31 23:59 UTC; at most 20 redemptions; at most 2 per buyer',
    });
  });

  it('names the actor', () => {
    expect(actorLabel({ type: 'operator', id: 'op_1' })).toBe('Operator');
    expect(actorLabel({ type: 'system', id: null })).toBe('Rekey');
  });

  it('explains every reconciliation finding kind', () => {
    expect(Object.keys(FINDING_COPY).sort()).toEqual([...RECONCILIATION_FINDING_KINDS].sort());
  });
});

describe('reading a log page', () => {
  it('keeps an entry of a type this panel does not know, as one it cannot describe', () => {
    const page = BillingLogPageSchema.parse({ items: [entryOf('payment.refunded')], nextCursor: '41', actors: null });
    const read = readLogPage({ items: [...page.items, { ...ENVELOPE, seq: '40', type: 'payout.sent', data: {} }], nextCursor: '39' });
    expect(read.nextCursor).toBe('39');
    expect(read.entries.map((entry) => entry.known)).toEqual([true, false]);
    expect(readEntry({ seq: '7', type: 'payout.sent' })).toMatchObject({ known: false, seq: '7', type: 'payout.sent' });
  });

  it('answers a failed or malformed page with no entries', () => {
    expect(readLogPage(null)).toEqual({ entries: [], nextCursor: null, actors: NO_LOG_ACTORS });
    expect(readLogPage({ items: 'nope' })).toEqual({ entries: [], nextCursor: null, actors: NO_LOG_ACTORS });
  });
});

describe('who a log page names', () => {
  const actors = readLogPage(
    BillingLogPageSchema.parse({
      items: [],
      nextCursor: null,
      actors: {
        endUsers: [
          { id: 'eu_known', state: 'known', email: 'buyer@example.com' },
          { id: 'eu_erased', state: 'erased', email: null },
          { id: 'eu_deleted_0123456789', state: 'unknown', email: null },
        ],
        operators: [
          { id: 'op_named', state: 'known', name: 'Olga Owner', email: 'olga@example.com' },
          { id: 'op_unnamed', state: 'known', name: null, email: 'sam@example.com' },
          { id: 'op_gone', state: 'unknown', name: null, email: null },
        ],
      },
    }),
  ).actors;

  it('asks the API for them on every log read', () => {
    expect(logQuery(readLogFilters({}), 50).get('include')).toBe('actors');
  });

  it('writes a customer by email, an erased one as erased, and anyone else by id', () => {
    expect(customerLabel(actors, 'eu_known')).toEqual({ text: 'buyer@example.com', isId: false });
    expect(customerLabel(actors, 'eu_erased')).toEqual({ text: 'Erased end user', isId: false });
    expect(customerLabel(actors, 'eu_deleted_0123456789')).toEqual({ text: 'eu_del…6789', isId: true });
    expect(customerLabel(actors, 'eu_never_listed')).toEqual({ text: 'eu_nev…sted', isId: true });
    expect(customerLabel(NO_LOG_ACTORS, 'eu_known')).toEqual({ text: 'eu_known', isId: true });
  });

  it('writes an operator by name with their email, by email alone when unnamed, and not at all when unknown', () => {
    expect(actorPerson(actors, { type: 'operator', id: 'op_named' })).toEqual({ name: 'Olga Owner', email: 'olga@example.com' });
    expect(actorPerson(actors, { type: 'operator', id: 'op_unnamed' })).toEqual({ name: 'sam@example.com', email: null });
    expect(actorPerson(actors, { type: 'operator', id: 'op_gone' })).toBeNull();
    expect(actorPerson(NO_LOG_ACTORS, { type: 'operator', id: 'op_named' })).toBeNull();
  });

  it('writes an end user who acted by email, and nobody for the system or a provider', () => {
    expect(actorPerson(actors, { type: 'end_user', id: 'eu_known' })).toEqual({ name: 'buyer@example.com', email: null });
    expect(actorPerson(actors, { type: 'end_user', id: 'eu_deleted_0123456789' })).toBeNull();
    expect(actorPerson(actors, { type: 'system', id: null })).toBeNull();
    expect(actorPerson(actors, { type: 'provider', id: 'stripe' })).toBeNull();
  });

  it('reads a page whose end users were not resolved for this reader as naming none of them', () => {
    const page = readLogPage({ items: [], nextCursor: null, actors: { endUsers: null, operators: [] } });
    expect(customerLabel(page.actors, 'eu_known')).toEqual({ text: 'eu_known', isId: true });
  });
});

describe('log filters', () => {
  it('defaults to money and refusals, and sends them as types the API accepts', () => {
    const filters = readLogFilters({});
    expect(filters).toEqual({ view: 'activity' });
    const query = Object.fromEntries(logQuery(filters, 50));
    const parsed = BillingLogQuerySchema.parse(query);
    expect(parsed.type).toContain('checkout.price_fallback');
    expect(parsed.type).toContain('payment.not_applied');
    expect(parsed.type).not.toContain('plan.price_set');
    expect(parsed.type).not.toContain('checkout.opened');
    expect(parsed.limit).toBe(50);
  });

  it('every view and every single type makes a query the API schema accepts', () => {
    for (const view of ['activity', 'configuration', 'diagnostics', 'all']) {
      expect(() => BillingLogQuerySchema.parse(Object.fromEntries(logQuery(readLogFilters({ view }), 50)))).not.toThrow();
    }
    for (const type of BILLING_EVENT_TYPES) {
      const parsed = BillingLogQuerySchema.parse(Object.fromEntries(logQuery(readLogFilters({ type }), 50)));
      expect(parsed.type).toEqual([type]);
    }
  });

  it('includes the whole of the last day and carries the entity filters', () => {
    const filters = readLogFilters({ view: 'all', currency: 'inr', from: '2026-10-01', to: '2026-10-12', paymentId: 'pay_1', cursor: '99' });
    const query = BillingLogQuerySchema.parse(Object.fromEntries(logQuery(filters, 50)));
    expect(query).toMatchObject({
      currency: 'INR',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
      paymentId: 'pay_1',
      cursor: '99',
    });
    expect(query.type).toBeUndefined();
  });

  it('drops anything malformed instead of sending it', () => {
    const filters = readLogFilters({ view: 'nope', type: 'not.a.type', currency: 'RUPEE', from: '12/10/2026', cursor: 'abc', endUserId: 'a b' });
    expect(filters).toEqual({ view: 'activity' });
  });

  it('keeps the filters and drops the cursor in the link back to newest', () => {
    const filters = readLogFilters({ view: 'configuration', currency: 'EUR', cursor: '99' });
    expect(logHrefQuery(filters)).toBe('?view=configuration&currency=EUR');
    expect(logHrefQuery(filters, '77')).toBe('?view=configuration&currency=EUR&cursor=77');
    expect(logHrefQuery({ view: 'activity' })).toBe('');
  });
});

describe('the period of the fallbacks and reconciliation views', () => {
  const now = new Date('2026-10-12T09:30:00.000Z');

  it('is the last seven days by default, both days included', () => {
    const period = readPeriod({}, now);
    expect(period).toMatchObject({ ok: true, from: '2026-10-06', to: '2026-10-12' });
    if (!period.ok) throw new Error(period.reason);
    const query = new URLSearchParams(period.query);
    expect(query.get('from')).toBe('2026-10-06T00:00:00.000Z');
    expect(query.get('to')).toBe('2026-10-13T00:00:00.000Z');
  });

  it('takes 31 days and refuses 32, before the API would', () => {
    expect(readPeriod({ from: '2026-09-12', to: '2026-10-12' }, now).ok).toBe(true);
    const tooLong = readPeriod({ from: '2026-09-11', to: '2026-10-12' }, now);
    expect(tooLong).toMatchObject({ ok: false, reason: 'A period covers at most 31 days. Shorten it.' });
  });

  it('refuses a period that ends before it starts', () => {
    expect(readPeriod({ from: '2026-10-12', to: '2026-10-01' }, now)).toMatchObject({ ok: false });
  });
});

describe('the fallback summary and the reconciliation report', () => {
  it('parse through the schemas the views are typed by', () => {
    const summary = PriceFallbackSummarySchema.parse({
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
      total: 12,
      groups: [
        { planSlug: 'pro', requestedCurrency: 'INR', chargedCurrency: 'USD', country: 'IN', count: 12, lastOccurredAt: '2026-10-12T08:00:00.000Z' },
      ],
    });
    expect(summary.groups[0]?.count).toBe(12);

    const report = ReconciliationReportSchema.parse({
      applicationId: 'app_1',
      from: '2026-10-06T00:00:00.000Z',
      to: '2026-10-13T00:00:00.000Z',
      paymentsLoggedSince: '2026-10-01T00:00:00.000Z',
      subscriptionsLoggedSince: null,
      checked: { payments: 10, refunds: 2, subscriptions: 0, events: 40 },
      counts: { payment_without_event: 0, event_without_payment: 0, refund_mismatch: 1, subscription_without_event: 0 },
      findings: [
        {
          kind: 'refund_mismatch',
          paymentId: 'pay_1',
          subscriptionId: null,
          eventSeq: null,
          currency: 'USD',
          amount: 1900,
          refundedOnPayment: 500,
          refundRowsTotal: 300,
          refundEventsTotal: 300,
          at: '2026-10-10T00:00:00.000Z',
        },
      ],
      truncated: false,
    });
    expect(FINDING_COPY[report.findings[0]!.kind].title).toBe('Refund totals disagree');
  });
});
