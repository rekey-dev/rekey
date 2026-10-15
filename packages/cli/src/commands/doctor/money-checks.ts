/**
 * The money checks of `rekey doctor`, each a function of rows the operator
 * routes already returned. None of them sends a request.
 */

import {
  formatMoney,
  isSellableCurrency,
  validatePriceAmount,
  type BillingCredentialDto,
  type BillingStatsDto,
  type CouponWithStatsDto,
  type PlanDto,
  type ReconciliationReport,
  type BillingOutboxStatus,
} from '@rekey.dev/node';
import type { Finding } from './check.js';

/** One row of `GET /tenant/applications/:id/unapplied-payments`, as far as the check reads it. */
export interface UnappliedPaymentRow {
  /** Minor units of `currency`. */
  amount: number;
  currency: string;
  /** Minor units already refunded. */
  refundedAmount: number;
}

const PROVIDERS_PANEL = 'Panel, Application, Billing, Setup, Providers, Edit';

function selling(plans: readonly PlanDto[]): PlanDto[] {
  return plans.filter((plan) => plan.active);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A price in a currency that cannot be sold, or at an amount the currency
 * cannot be priced at.
 */
export function planCurrenciesCheck(applicationId: string, plans: readonly PlanDto[]): Finding {
  const active = selling(plans);
  const offenders = active.flatMap((plan) =>
    plan.prices.flatMap((price) => {
      if (!isSellableCurrency(price.currency)) return [`${plan.slug}: ${price.currency} is not a currency a price can be in`];
      const amount = validatePriceAmount(price.currency, price.amount);
      return amount.ok ? [] : [`${plan.slug}: ${formatMoney(price.amount, price.currency)} (${amount.message})`];
    }),
  );
  if (offenders.length === 0) {
    return { status: 'ok', message: `${plural(active.length, 'active plan')}, every price in a sellable currency` };
  }
  return {
    status: 'fail',
    message: `Cannot be sold as priced: ${offenders.join('; ')}`,
    fix:
      `Stop selling an additional price with \`rekey plans prices archive <plan> <currency> --app ${applicationId}\` and add one in a sellable currency. ` +
      `Change a default price with PATCH /api/v1/tenant/applications/${applicationId}/plans/<slug> and a body such as {"price": {"currency": "USD", "amount": 1900}}.`,
  };
}

/**
 * A provider storing a currency it does not offer at all, which routing
 * skips, or an enabled provider with no currency, which is used for no
 * checkout: an empty list means none.
 */
export function providerCurrenciesCheck(credentials: readonly BillingCredentialDto[]): Finding {
  const offenders = credentials
    .filter((row) => row.unsupportedCurrencies.length > 0)
    .map((row) => `${row.provider} stores ${row.unsupportedCurrencies.join(', ')}`);
  const unused = credentials.filter((row) => row.enabled && row.currencies.length === 0).map((row) => row.provider);
  if (offenders.length === 0 && unused.length > 0) {
    return {
      status: 'warn',
      message: `Enabled with no currency, so not used for any checkout: ${unused.join(', ')}`,
      fix: `Tick the currencies the account charges in ${PROVIDERS_PANEL}, or disable the provider there.`,
    };
  }
  if (offenders.length === 0) {
    return { status: 'ok', message: `${plural(credentials.length, 'provider')} configured, each storing only currencies it charges` };
  }
  return {
    status: 'fail',
    message: `A provider stores currencies it cannot charge: ${offenders.join('; ')}`,
    fix: `Remove them from the provider's currencies in ${PROVIDERS_PANEL}, and save.`,
  };
}

/** The currencies some enabled provider can charge. */
function chargeableCurrencies(credentials: readonly BillingCredentialDto[]): Set<string> {
  return new Set(
    credentials
      .filter((row) => row.enabled)
      .flatMap((row) => row.currencies.filter((currency) => !row.unsupportedCurrencies.includes(currency))),
  );
}

/**
 * A live price no enabled provider can charge. A default price is a failure:
 * a buyer with no local price is refused. An additional price is a warning:
 * its buyers fall back to the default price.
 */
export function priceProvidersCheck(
  applicationId: string,
  plans: readonly PlanDto[],
  credentials: readonly BillingCredentialDto[],
): Finding {
  const chargeable = chargeableCurrencies(credentials);
  const active = selling(plans);
  const unchargeable = active.flatMap((plan) =>
    plan.prices
      .filter((price) => !chargeable.has(price.currency))
      .map((price) => ({ label: `${plan.slug} ${price.currency}`, isDefault: price.isDefault, plan: plan.slug })),
  );
  const defaults = unchargeable.filter((price) => price.isDefault);
  const additional = unchargeable.filter((price) => !price.isDefault);
  const reportedByApi = active
    .filter((plan) => !defaults.some((price) => price.plan === plan.slug))
    .flatMap((plan) =>
      (plan.checkout?.blockers ?? [])
        .filter((blocker) => blocker.code === 'PLAN_CURRENCY_UNSUPPORTED')
        .map((blocker) => `${plan.slug}: ${blocker.code}: ${blocker.message}`),
    );

  if (defaults.length === 0 && additional.length === 0 && reportedByApi.length === 0) {
    return { status: 'ok', message: `every price of ${plural(active.length, 'active plan')} has an enabled provider that can charge it` };
  }
  const parts = [
    ...(defaults.length > 0 ? [`default prices: ${defaults.map((price) => price.label).join(', ')}`] : []),
    ...(additional.length > 0
      ? [`additional prices, whose buyers pay the default price instead: ${additional.map((price) => price.label).join(', ')}`]
      : []),
    ...reportedByApi,
  ];
  const noProvider = credentials.some((row) => row.enabled) ? '' : 'No billing provider is enabled. ';
  return {
    status: defaults.length > 0 || reportedByApi.length > 0 ? 'fail' : 'warn',
    message: `${noProvider}No enabled provider can charge ${parts.join('; ')}`,
    fix:
      `Add the currency to an enabled provider's currencies in ${PROVIDERS_PANEL}, or stop selling the price with ` +
      `\`rekey plans prices archive <plan> <currency> --app ${applicationId}\`. ` +
      `\`rekey billing preview --app ${applicationId} --country <code>\` shows what a buyer would get.`,
  };
}

/**
 * An active coupon that covers none of the currencies its plans are priced
 * in, so every checkout carrying it is refused.
 */
export function couponCoverageCheck(
  applicationId: string,
  coupons: readonly Pick<CouponWithStatsDto, 'code' | 'active' | 'endsAt' | 'coveredCurrencies' | 'planSlugs'>[],
  plans: readonly PlanDto[],
  now: Date,
): Finding {
  const active = selling(plans);
  const live = coupons.filter((coupon) => coupon.active && (coupon.endsAt === null || new Date(coupon.endsAt) > now));
  const offenders = live.flatMap((coupon) => {
    if (coupon.coveredCurrencies === null) return [];
    const scope = coupon.planSlugs.length === 0 ? active : active.filter((plan) => coupon.planSlugs.includes(plan.slug));
    const priced = [...new Set(scope.flatMap((plan) => plan.prices.map((price) => price.currency)))].sort();
    if (priced.length === 0 || priced.some((currency) => coupon.coveredCurrencies?.includes(currency))) return [];
    const where = coupon.planSlugs.length === 0 ? 'the plans are' : `its plans (${coupon.planSlugs.join(', ')}) are`;
    return [`${coupon.code} covers ${coupon.coveredCurrencies.join(', ') || 'no currency'}, but ${where} priced in ${priced.join(', ')}`];
  });
  if (offenders.length === 0) {
    return { status: 'ok', message: `${plural(live.length, 'active coupon')}, each covering a currency its plans are priced in` };
  }
  return {
    status: 'fail',
    message: `${plural(offenders.length, 'active coupon')} can never be redeemed: ${offenders.join('; ')}`,
    fix:
      `Give a fixed coupon an amount in a currency its plans are priced in with \`rekey coupons update <code> --app ${applicationId} --amount CUR=n\` ` +
      '(send every currency it should keep), widen a percentage coupon with `--currencies`, or retire it with `--active false`.',
  };
}

/**
 * Live subscriptions on a plan that has a price, recording no price of their
 * own. The API counts them; a subscription to a plan with no flat price is
 * not one of them.
 */
export function unpricedSubscriptionsCheck(applicationId: string, stats: Pick<BillingStatsDto, 'unpricedLiveSubscriptions'>): Finding {
  const count = stats.unpricedLiveSubscriptions;
  if (count === 0) return { status: 'ok', message: 'every live subscription on a plan that has a price records its own price' };
  return {
    status: 'warn',
    message:
      `${plural(count, 'live subscription')} on a plan that has a price ${count === 1 ? 'records' : 'record'} no price of ${count === 1 ? 'its' : 'their'} own. ` +
      `${count === 1 ? 'It shows' : 'Each shows'} no price and is not counted in MRR`,
    fix:
      'Grant the plan again to each subscriber, which gives a live subscription with no price the price granted and changes nothing else: ' +
      `POST /api/v1/tenant/applications/${applicationId}/end-users/<endUserId>/subscriptions with {"planSlug": "<slug>"} for the plan's default price, ` +
      'adding "currency" for another of its prices. In the panel: the subscriber\'s page, Subscriptions, Grant subscription. ' +
      'A subscription a checkout opened is left as it is: cancel it and grant it again. ' +
      'To find them, look for "No price recorded" on a subscriber\'s Subscriptions page, or query the database for subscriptions of this Application ' +
      "with status ACTIVE, TRIALING or PAST_DUE and a null currency whose plan has a default_price_id. " +
      'The count is read from billing stats, which the API caches for a minute.',
  };
}

/** Money a provider took that Rekey has not applied to anything, still waiting for an operator. */
export function unappliedPaymentsCheck(applicationId: string, open: readonly UnappliedPaymentRow[], total: number): Finding {
  if (total === 0) return { status: 'ok', message: 'no open unapplied payment' };
  const byCurrency = new Map<string, { held: number; payments: number }>();
  for (const row of open) {
    const sum = byCurrency.get(row.currency) ?? { held: 0, payments: 0 };
    byCurrency.set(row.currency, { held: sum.held + row.amount - row.refundedAmount, payments: sum.payments + 1 });
  }
  const held = [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sum]) => `${formatMoney(sum.held, currency)} (${sum.payments})`)
    .join(', ');
  const counted = open.length < total ? ` Of the first ${open.length}:` : ':';
  return {
    status: 'warn',
    message: `${plural(total, 'open unapplied payment')}, net of refunds${counted} ${held}`,
    fix:
      'A buyer paid for something they did not receive. Resolve each in Panel, Application, Billing, Unapplied payments: refund it, grant what was paid for, or dismiss it. ' +
      `GET /api/v1/tenant/applications/${applicationId}/unapplied-payments?status=OPEN lists them, oldest first.`,
  };
}

/** A disagreement between the billing log and the payment, refund and subscription rows. */
export function reconciliationCheck(applicationId: string, report: ReconciliationReport): Finding {
  const period = `${report.from} to ${report.to}`;
  const found = Object.entries(report.counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count}${report.truncated ? ' or more' : ''} ${kind}`);
  if (found.length === 0) {
    const { payments, refunds, subscriptions } = report.checked;
    return {
      status: 'ok',
      message: `the billing log agrees with ${plural(payments, 'payment')}, ${plural(refunds, 'refund')} and ${plural(subscriptions, 'subscription')}, ${period}`,
    };
  }
  return {
    status: 'fail',
    message: `The billing log and the records disagree, ${period}: ${found.join(', ')}`,
    fix:
      `\`rekey billing reconciliation --app ${applicationId}\` lists each row. A payment or subscription with no log entry is often an entry stuck in the billing outbox: ` +
      'run `rekey doctor` with SUPER_ADMIN_KEY for the billing-outbox check.',
  };
}

/** Billing events that keep failing to reach the log, across the deployment. */
export function billingOutboxCheck(status: BillingOutboxStatus): Finding {
  if (status.failing === 0) {
    return { status: 'ok', message: `${plural(status.pending, 'billing event')} waiting to reach the log, none failing` };
  }
  const perApplication = new Map<string, number>();
  for (const row of status.stuck) perApplication.set(row.applicationId, (perApplication.get(row.applicationId) ?? 0) + 1);
  const applications = [...perApplication].map(([id, count]) => `${id} (${count})`).join(', ');
  return {
    status: 'fail',
    message:
      `${plural(status.failing, 'billing event')} failed ${status.failingThreshold} times or more and ${status.failing === 1 ? 'is' : 'are'} missing from the billing log` +
      (applications === '' ? '' : `: ${applications}`) +
      (status.oldestPendingAt === null ? '' : `. Oldest waiting since ${status.oldestPendingAt}`),
    fix:
      'GET /api/v1/admin/metrics/billing-outbox lists each stuck row with the error of its last attempt (`stuck[].lastError`). ' +
      'A row whose payload does not match its schema is kept and never written by itself; the API logs name the field at fault.',
  };
}
