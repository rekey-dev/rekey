/**
 * `rekey coupons …`, an Application's discount coupons.
 *
 *   rekey coupons list --app <id>
 *   rekey coupons show <code> --app <id>
 *   rekey coupons create --app <id> --code X
 *       (--percent 15 | --basis-points 1500 | --amount USD=500 --amount INR=40000)
 *       [--currencies USD,EUR] [--plans pro,team] [--starts-at ISO] [--ends-at ISO]
 *       [--max-redemptions n] [--max-redemptions-per-user n]
 *   rekey coupons update <code> --app <id> [--active true|false] [--basis-points n]
 *       [--amount CUR=n ...] [--currencies ...] [--plans ...] [--ends-at ISO|none]
 *       [--max-redemptions n|none] [--max-redemptions-per-user n|none]
 *
 * A percentage coupon works in any currency unless `--currencies` limits it. A
 * fixed coupon carries one amount per currency and works only in those: an
 * amount is never converted. These call the operator routes, so they need
 * REKEY_OPERATOR_TOKEN.
 */

import type { Command } from 'commander';
import {
  formatMoney,
  type CouponDto,
  type CouponWithStatsDto,
  type CreateCouponRequest,
  type Paged,
  type UpdateCouponRequest,
} from '@rekey.dev/node';
import { ok, fail, readGlobalOpts, type OutputContext } from '../lib/output.js';
import { listQuery, operatorRequest, readListOpts, withListOptions } from '../lib/api.js';
import {
  MINOR_UNITS_HELP,
  appPath,
  readCurrencies,
  readCurrency,
  readInstant,
  readInteger,
  readList,
  readMinorUnits,
} from '../lib/input.js';

const INT4_MAX = 2_147_483_647;
/** What `coupons update` takes in place of a value to remove an end date or a cap. */
const REMOVE = 'none';
const AMOUNT = { code: 'CLI_COUPONS_AMOUNT_INVALID', what: '--amount' };
const CURRENCIES = { code: 'CLI_COUPONS_CURRENCIES_INVALID', what: '--currencies' };
const BASIS_POINTS = { code: 'CLI_COUPONS_BASIS_POINTS_INVALID', what: '--basis-points' };

const AMOUNT_HELP = `CUR=n, an integer in ${MINOR_UNITS_HELP}. Repeat it, once per currency`;
const CURRENCIES_HELP = 'Percentage coupons only: comma list of ISO 4217 codes the coupon is limited to. "" means any currency';
const PLANS_HELP = 'Comma list of plan slugs the coupon is limited to. "" means any plan';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readAmounts(ctx: OutputContext, raw: string[]): CreateCouponRequest['amounts'] {
  const amounts = raw.map((entry) => {
    const [currencyPart, amountPart, ...rest] = entry.split('=');
    if (currencyPart === undefined || amountPart === undefined || rest.length > 0) {
      fail(ctx, {
        code: AMOUNT.code,
        message: `--amount takes CUR=n, a currency and an integer amount. Got "${entry}".`,
        fix: 'Pass it as --amount USD=500 (which is $5.00) or --amount JPY=500 (which is ¥500), once per currency.',
      });
    }
    const currency = readCurrency(ctx, currencyPart, AMOUNT);
    return { currency, amountOff: readMinorUnits(ctx, amountPart, currency, { ...AMOUNT, what: `--amount ${currency}` }) };
  });
  const repeated = amounts.find((each, index) => amounts.findIndex((other) => other.currency === each.currency) !== index);
  if (repeated !== undefined) {
    fail(ctx, {
      code: AMOUNT.code,
      message: `--amount names ${repeated.currency} more than once.`,
      fix: 'Pass one --amount per currency.',
    });
  }
  return amounts;
}

/** `15` or `12.5` as basis points, read from the text so no float is rounded. */
function readPercent(ctx: OutputContext, raw: string): number {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  const basisPoints = match === null ? Number.NaN : Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (basisPoints >= 1 && basisPoints <= 10000) return basisPoints;
  fail(ctx, {
    code: 'CLI_COUPONS_PERCENT_INVALID',
    message: `--percent must be above 0 and at most 100, with at most two decimals. Got "${raw}".`,
    fix: 'Pass a percentage such as 15 or 12.5.',
  });
}

function readActive(ctx: OutputContext, raw: string): boolean {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  fail(ctx, {
    code: 'CLI_COUPONS_ACTIVE_INVALID',
    message: `--active must be "true" or "false". Got "${raw}".`,
    fix: 'Pass --active true or --active false.',
  });
}

/** Basis points as a percentage, written from the digits: 1500 is '15', 1250 is '12.5'. */
function percentOf(basisPoints: number): string {
  const digits = String(basisPoints).padStart(3, '0');
  const fraction = digits.slice(-2).replace(/0+$/, '');
  return fraction === '' ? digits.slice(0, -2) : `${digits.slice(0, -2)}.${fraction}`;
}

/**
 * What a coupon takes off, for a person.
 *
 * @example
 * couponDiscount(coupon); // '15% off', or '$5.00, ₹400.00 off'
 */
export function couponDiscount(coupon: Pick<CouponDto, 'basisPoints' | 'amounts'>): string {
  if (coupon.basisPoints !== null) return `${percentOf(coupon.basisPoints)}% off`;
  return `${coupon.amounts.map((each) => formatMoney(each.amountOff, each.currency)).join(', ')} off`;
}

function couponLine(coupon: CouponDto): string {
  return [
    coupon.code,
    couponDiscount(coupon),
    coupon.coveredCurrencies === null ? 'any currency' : coupon.coveredCurrencies.join(','),
    coupon.planSlugs.length === 0 ? 'any plan' : `plans: ${coupon.planSlugs.join(',')}`,
    coupon.active ? 'active' : 'inactive',
  ].join('  ');
}

function redemptionsLine(coupon: CouponWithStatsDto): string {
  const issued = coupon.discountIssuedByCurrency
    .map((each) => `${formatMoney(each.amount, each.currency)} (${each.redemptions})`)
    .join(', ');
  const count = `${coupon.redemptionCount} redemption${coupon.redemptionCount === 1 ? '' : 's'}`;
  return issued === '' ? count : `${count}: ${issued}`;
}

/** When a coupon runs and how often it may be redeemed, one line per limit it has. */
function printLimits(coupon: CouponDto): void {
  if (coupon.startsAt !== null) process.stdout.write(`    starts ${coupon.startsAt}\n`);
  if (coupon.endsAt !== null) process.stdout.write(`    ends ${coupon.endsAt}\n`);
  if (coupon.maxRedemptions !== null) process.stdout.write(`    at most ${coupon.maxRedemptions} redemptions\n`);
  if (coupon.maxRedemptionsPerUser !== null) process.stdout.write(`    at most ${coupon.maxRedemptionsPerUser} per user\n`);
}

function printCoupon(coupon: CouponDto): void {
  process.stdout.write(`✓ ${couponLine(coupon)}\n`);
}

/**
 * Attach `rekey coupons`.
 *
 * @example
 * registerCouponsCommand(program);
 */
export function registerCouponsCommand(program: Command): void {
  const coupons = program.command('coupons').description("An Application's coupons (uses REKEY_OPERATOR_TOKEN)");

  withListOptions(
    coupons
      .command('list')
      .description('List coupons, active and inactive, with what each has taken off per currency')
      .requiredOption('--app <id>', 'Application id'),
  ).action(async function (this: Command, opts: { app: string; limit?: string; offset?: string }) {
    const ctx = readGlobalOpts(this);
    const data = await operatorRequest<Paged<CouponWithStatsDto>>({
      ctx,
      method: 'GET',
      path: appPath(opts.app, `/coupons${listQuery(readListOpts(ctx, opts))}`),
      scope: 'billing:read',
    });
    ok(ctx, { coupons: data.items, page: data.page }, (d) => {
      if (d.coupons.length === 0) {
        process.stdout.write('(no coupons)\n');
        return;
      }
      for (const coupon of d.coupons) {
        process.stdout.write(`${couponLine(coupon)}\n    ${redemptionsLine(coupon)}\n`);
      }
      if (d.page.hasMore) {
        process.stdout.write(
          `\nShowing ${d.coupons.length} of ${d.page.total}. Pass --offset ${d.page.offset + d.page.limit} for the next page.\n`,
        );
      }
    });
  });

  coupons
    .command('show')
    .description('Show one coupon')
    .argument('<code>', 'Coupon code')
    .requiredOption('--app <id>', 'Application id')
    .action(async function (this: Command, code: string, opts: { app: string }) {
      const ctx = readGlobalOpts(this);
      const data = await operatorRequest<CouponDto>({
        ctx,
        method: 'GET',
        path: appPath(opts.app, `/coupons/${encodeURIComponent(code)}`),
        scope: 'billing:read',
      });
      ok(ctx, data, (coupon) => {
        process.stdout.write(`${couponLine(coupon)}\n`);
        printLimits(coupon);
      });
    });

  coupons
    .command('create')
    .description('Create a coupon: a percentage (--percent or --basis-points), or fixed amounts (--amount, one per currency)')
    .requiredOption('--app <id>', 'Application id')
    .requiredOption('--code <code>', 'The code a buyer enters. Stored lower-case')
    .option('--percent <n>', 'Percentage off, e.g. 15 or 12.5')
    .option('--basis-points <n>', 'Percentage off in hundredths of a percent: 1500 is 15%')
    .option('--amount <CUR=n>', `Fixed amount off: ${AMOUNT_HELP}`, collect, [])
    .option('--currencies <list>', CURRENCIES_HELP)
    .option('--plans <list>', PLANS_HELP)
    .option('--starts-at <instant>', 'ISO 8601, e.g. 2026-11-01 or 2026-11-01T09:00:00Z')
    .option('--ends-at <instant>', 'ISO 8601, e.g. 2026-12-01 or 2026-12-01T00:00:00Z')
    .option('--max-redemptions <n>', 'Redemptions allowed in total, across every currency')
    .option('--max-redemptions-per-user <n>', 'Redemptions allowed per end user')
    .action(async function (
      this: Command,
      opts: {
        app: string;
        code: string;
        percent?: string;
        basisPoints?: string;
        amount: string[];
        currencies?: string;
        plans?: string;
        startsAt?: string;
        endsAt?: string;
        maxRedemptions?: string;
        maxRedemptionsPerUser?: string;
      },
    ) {
      const ctx = readGlobalOpts(this);
      const given = [opts.percent !== undefined, opts.basisPoints !== undefined, opts.amount.length > 0].filter(Boolean);
      if (given.length !== 1) {
        fail(ctx, {
          code: 'CLI_COUPONS_DISCOUNT_REQUIRED',
          message: 'A coupon takes exactly one of --percent, --basis-points and --amount.',
          fix: 'Pass --percent 15 for a percentage, or --amount USD=500 (repeated per currency) for a fixed amount.',
        });
      }
      const fixed = opts.amount.length > 0;
      if (fixed && opts.currencies !== undefined) {
        fail(ctx, {
          code: 'CLI_COUPONS_CURRENCIES_NOT_APPLICABLE',
          message: '--currencies limits a percentage coupon. A fixed coupon works in the currencies of its --amount flags.',
          fix: 'Drop --currencies, and pass one --amount per currency the coupon should work in.',
        });
      }
      const basisPoints = fixed
        ? undefined
        : opts.percent !== undefined
          ? readPercent(ctx, opts.percent)
          : readInteger(ctx, opts.basisPoints ?? '', BASIS_POINTS, 1, 10000);
      const limit = (raw: string | undefined, what: string) =>
        raw === undefined ? undefined : readInteger(ctx, raw, { code: 'CLI_COUPONS_LIMIT_INVALID', what }, 1, INT4_MAX);
      const maxRedemptions = limit(opts.maxRedemptions, '--max-redemptions');
      const maxRedemptionsPerUser = limit(opts.maxRedemptionsPerUser, '--max-redemptions-per-user');
      const instant = (raw: string | undefined, what: string) =>
        raw === undefined ? undefined : readInstant(ctx, raw, { code: 'CLI_COUPONS_DATE_INVALID', what });
      const startsAt = instant(opts.startsAt, '--starts-at');
      const endsAt = instant(opts.endsAt, '--ends-at');

      const body: CreateCouponRequest = {
        code: opts.code,
        discountType: fixed ? 'AMOUNT' : 'PERCENT',
        ...(basisPoints !== undefined && { basisPoints }),
        ...(fixed && { amounts: readAmounts(ctx, opts.amount) }),
        ...(opts.currencies !== undefined && { currencies: readCurrencies(ctx, opts.currencies, CURRENCIES) }),
        ...(opts.plans !== undefined && { planSlugs: readList(opts.plans) }),
        ...(startsAt !== undefined && { startsAt }),
        ...(endsAt !== undefined && { endsAt }),
        ...(maxRedemptions !== undefined && { maxRedemptions }),
        ...(maxRedemptionsPerUser !== undefined && { maxRedemptionsPerUser }),
      };
      const data = await operatorRequest<CouponDto>({
        ctx,
        method: 'POST',
        path: appPath(opts.app, '/coupons'),
        body,
        scope: 'billing:write',
      });
      ok(ctx, data, printCoupon);
    });

  coupons
    .command('update')
    .description("Change a coupon. Its type cannot change: --basis-points is for a percentage coupon, --amount for a fixed one")
    .argument('<code>', 'Coupon code')
    .requiredOption('--app <id>', 'Application id')
    .option('--active <bool>', 'true | false')
    .option('--basis-points <n>', 'Percentage off in hundredths of a percent: 1500 is 15%')
    .option(
      '--amount <CUR=n>',
      `${AMOUNT_HELP}. Replaces the whole set: a currency you leave out stops working`,
      collect,
      [],
    )
    .option('--currencies <list>', CURRENCIES_HELP)
    .option('--plans <list>', PLANS_HELP)
    .option('--ends-at <instant>', 'ISO 8601, e.g. 2026-12-01 or 2026-12-01T00:00:00Z. "none" removes the end date')
    .option(
      '--max-redemptions <n>',
      'Redemptions allowed in total, across every currency. "none" removes the cap. Refused below what is already redeemed',
    )
    .option(
      '--max-redemptions-per-user <n>',
      'Redemptions allowed per end user. "none" removes the cap. Refused when one end user already holds more',
    )
    .action(async function (
      this: Command,
      code: string,
      opts: {
        app: string;
        active?: string;
        basisPoints?: string;
        amount: string[];
        currencies?: string;
        plans?: string;
        endsAt?: string;
        maxRedemptions?: string;
        maxRedemptionsPerUser?: string;
      },
    ) {
      const ctx = readGlobalOpts(this);
      const cap = (raw: string, what: string) =>
        raw === REMOVE ? null : readInteger(ctx, raw, { code: 'CLI_COUPONS_LIMIT_INVALID', what }, 1, INT4_MAX);
      const body: UpdateCouponRequest = {
        ...(opts.active !== undefined && { active: readActive(ctx, opts.active) }),
        ...(opts.basisPoints !== undefined && { basisPoints: readInteger(ctx, opts.basisPoints, BASIS_POINTS, 1, 10000) }),
        ...(opts.amount.length > 0 && { amounts: readAmounts(ctx, opts.amount) }),
        ...(opts.currencies !== undefined && { currencies: readCurrencies(ctx, opts.currencies, CURRENCIES) }),
        ...(opts.plans !== undefined && { planSlugs: readList(opts.plans) }),
        ...(opts.endsAt !== undefined && {
          endsAt: opts.endsAt === REMOVE ? null : readInstant(ctx, opts.endsAt, { code: 'CLI_COUPONS_DATE_INVALID', what: '--ends-at' }),
        }),
        ...(opts.maxRedemptions !== undefined && { maxRedemptions: cap(opts.maxRedemptions, '--max-redemptions') }),
        ...(opts.maxRedemptionsPerUser !== undefined && {
          maxRedemptionsPerUser: cap(opts.maxRedemptionsPerUser, '--max-redemptions-per-user'),
        }),
      };
      if (Object.keys(body).length === 0) {
        fail(ctx, {
          code: 'CLI_COUPONS_NO_CHANGE',
          message: 'Nothing to change: no field was given.',
          fix: 'Pass at least one of --active, --basis-points, --amount, --currencies, --plans, --ends-at, --max-redemptions and --max-redemptions-per-user.',
        });
      }
      const data = await operatorRequest<CouponDto>({
        ctx,
        method: 'PATCH',
        path: appPath(opts.app, `/coupons/${encodeURIComponent(code)}`),
        body,
        scope: 'billing:write',
      });
      ok(ctx, data, (coupon) => {
        printCoupon(coupon);
        printLimits(coupon);
      });
    });
}
