import type {
  BillingEventTier,
  BillingEventType,
  BillingLogEntry,
  BillingLogInclude,
  BillingLogPage,
  PriceFallbackSummary,
  ReconciliationReport,
} from '@rekey.dev/shared-types';
import { queryString, segment, type OperatorTransport } from './transport.js';

/** Paging and the filters every billing log read takes. */
export interface BillingLogTrailOptions {
  /** `nextCursor` of the previous page. Entries older than it are returned. */
  cursor?: string;
  /** 1 to 200, default 50. */
  limit?: number;
  /** One event type or several. */
  type?: BillingEventType | readonly BillingEventType[];
  /** `PERMANENT` for money and configuration, `DIAGNOSTIC` for opened checkouts and refusals. */
  tier?: BillingEventTier;
  /** ISO 4217, any case. */
  currency?: string;
  /** Events that happened at or after this instant. */
  from?: Date | string;
  /** Events that happened before this instant. */
  to?: Date | string;
  /**
   * `['actors']` fills the page's `actors`: the email of each end user its
   * entries name and the name and email of each operator who acted, as they
   * stand now. Left out, `actors` is null and the read is ids only. End users
   * are resolved only for a token holding `end-users:read`; without it
   * `actors.endUsers` is null.
   */
  include?: readonly BillingLogInclude[];
}

/** Filters for the whole Application's log: the trail filters, and one entity to narrow to. */
export interface BillingLogListOptions extends BillingLogTrailOptions {
  endUserId?: string;
  subscriptionId?: string;
  paymentId?: string;
}

/** A period of at most 31 days. Left out, the last 7 days. */
export interface BillingLogPeriod {
  from?: Date | string;
  to?: Date | string;
}

function logQuery(options: BillingLogListOptions): string {
  const { cursor, limit, type, tier, currency, from, to, endUserId, subscriptionId, paymentId, include } = options;
  return queryString({
    cursor,
    limit,
    type: typeof type === 'string' ? [type] : type,
    tier,
    currency,
    from,
    to,
    endUserId,
    subscriptionId,
    paymentId,
    include,
  });
}

/** The events of an Application's billing log. */
export class BillingLogEventsClient {
  constructor(private readonly transport: OperatorTransport) {}

  /**
   * One page of the log, newest first. Paged on a cursor, never an offset:
   * pass `nextCursor` back as `cursor`. An event written while you page never
   * repeats or displaces an entry. `nextCursor` is null on the last page.
   *
   * Narrow on `type` and `data` has that event's fields and no others.
   *
   * An entry names people by id. Pass `include: ['actors']` and the page's
   * `actors` says who those ids are now: looked up as the page is read, and
   * stored nowhere in the log. An erased end user has `state: 'erased'` and
   * no email.
   *
   * @example
   * ```ts
   * const page = await operator.billingLog.events.list({
   *   type: ['checkout.price_fallback', 'payment.not_applied'],
   *   from: new Date(Date.now() - 7 * 86_400_000),
   *   include: ['actors'],
   * });
   * const emails = new Map((page.actors?.endUsers ?? []).map((user) => [user.id, user.email]));
   * for (const entry of page.items) {
   *   if (entry.type === 'checkout.price_fallback') {
   *     const who = (entry.endUserId && emails.get(entry.endUserId)) ?? entry.endUserId;
   *     console.log(who, entry.data.requested.currency, 'charged as', entry.data.charged.currency);
   *   }
   * }
   * ```
   */
  list(options: BillingLogListOptions = {}): Promise<BillingLogPage> {
    return this.transport.send('GET', `${this.transport.base}/billing/events${logQuery(options)}`);
  }

  /**
   * Every page that matches, one request per page, newest first. Stop reading
   * and no further request is made.
   *
   * @example
   * ```ts
   * for await (const page of operator.billingLog.events.pages({ tier: 'PERMANENT', limit: 200 })) {
   *   await archive(page.items);
   * }
   * ```
   */
  async *pages(options: BillingLogListOptions = {}): AsyncGenerator<BillingLogPage, void, undefined> {
    let cursor = options.cursor;
    for (;;) {
      const page = await this.list({ ...options, ...(cursor !== undefined && { cursor }) });
      yield page;
      if (page.nextCursor === null) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * Every entry that matches, newest first, fetched a page at a time.
   *
   * @example
   * ```ts
   * for await (const entry of operator.billingLog.events.iterate({ type: 'payment.refunded' })) {
   *   console.log(entry.occurredAt, entry.amount, entry.currency);
   * }
   * ```
   */
  async *iterate(options: BillingLogListOptions = {}): AsyncGenerator<BillingLogEntry, void, undefined> {
    for await (const page of this.pages(options)) yield* page.items;
  }
}

/**
 * The billing log: every money change and every pricing decision of the
 * Application, as an append-only trail. Entries name people by id only;
 * `include: ['actors']` on any read adds who those ids are to the page.
 */
export class OperatorBillingLogClient {
  /** The log itself: one page, every page, or every entry. */
  public readonly events: BillingLogEventsClient;

  constructor(private readonly transport: OperatorTransport) {
    this.events = new BillingLogEventsClient(transport);
  }

  private trail(path: string, options: BillingLogTrailOptions): Promise<BillingLogPage> {
    return this.transport.send('GET', `${this.transport.base}${path}${logQuery(options)}`);
  }

  /**
   * Every entry that names one subscription: its checkout, activation, price,
   * payments and cancellation.
   *
   * @example
   * ```ts
   * const { items } = await operator.billingLog.forSubscription('sub_123');
   * ```
   */
  forSubscription(subscriptionId: string, options: BillingLogTrailOptions = {}): Promise<BillingLogPage> {
    return this.trail(`/billing/subscriptions/${segment(subscriptionId)}/events`, options);
  }

  /**
   * Every entry that names one payment, its refunds included.
   *
   * @example
   * ```ts
   * const { items } = await operator.billingLog.forPayment('pay_123');
   * const refunds = items.filter((entry) => entry.type === 'payment.refunded');
   * ```
   */
  forPayment(paymentId: string, options: BillingLogTrailOptions = {}): Promise<BillingLogPage> {
    return this.trail(`/billing/payments/${segment(paymentId)}/events`, options);
  }

  /**
   * Every entry about one end user. After the end user is erased the entries
   * remain, without the country they checked out from.
   *
   * @example
   * ```ts
   * const { items, nextCursor } = await operator.billingLog.forEndUser('eu_123', { limit: 100 });
   * ```
   */
  forEndUser(endUserId: string, options: BillingLogTrailOptions = {}): Promise<BillingLogPage> {
    return this.trail(`/end-users/${segment(endUserId)}/billing-events`, options);
  }

  /**
   * How often a buyer was charged a plan's default price because no enabled
   * provider could charge the price selected for them, grouped by plan, the
   * currency asked for, the currency charged and the buyer's country, most
   * frequent first. To stop a group recurring, add its `requestedCurrency`
   * to a provider that can charge it.
   *
   * @example
   * ```ts
   * const summary = await operator.billingLog.priceFallbacks();
   * for (const group of summary.groups) {
   *   console.log(`${group.count} buyers in ${group.country} paid ${group.chargedCurrency}, not ${group.requestedCurrency}`);
   * }
   * ```
   *
   * @throws {RekeyError} `BILLING_LOG_PERIOD_INVALID` (400) for a period that ends before it starts or is longer than 31 days.
   */
  priceFallbacks(period: BillingLogPeriod = {}): Promise<PriceFallbackSummary> {
    return this.transport.send(
      'GET',
      `${this.transport.base}/billing/price-fallbacks${queryString({ from: period.from, to: period.to })}`,
    );
  }

  /**
   * The log compared with the payments, refunds and subscriptions of one
   * period. It reads only. `counts` says how many of each kind of
   * disagreement there are and `findings` lists them:
   *
   * - `payment_without_event`: a payment the log does not mention.
   * - `event_without_payment`: a log entry naming a payment that does not exist.
   * - `refund_mismatch`: a payment whose refunds add up differently on the
   *   payment, in the refund records and in the log.
   * - `subscription_without_event`: a subscription with no activation entry.
   *
   * It compares Rekey's own records with each other, not with the provider's
   * list of charges.
   *
   * @example
   * ```ts
   * const report = await operator.billingLog.reconciliation({ from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z' });
   * const clean = Object.values(report.counts).every((count) => count === 0);
   * ```
   *
   * @throws {RekeyError} `BILLING_LOG_PERIOD_INVALID` (400).
   */
  reconciliation(period: BillingLogPeriod = {}): Promise<ReconciliationReport> {
    return this.transport.send(
      'GET',
      `${this.transport.base}/billing/reconciliation${queryString({ from: period.from, to: period.to })}`,
    );
  }
}
