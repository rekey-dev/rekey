import type {
  CouponDto,
  CouponWithStatsDto,
  CreateCouponRequest,
  CreatePlanRequest,
  ListPage,
  Paged,
  PlanDto,
  PlanPriceDto,
  SetPlanPriceRequest,
  UpdateCouponRequest,
  UpdatePlanRequest,
} from '@rekey.dev/shared-types';
import { RekeyError } from '@rekey.dev/shared-types/error';
import { pageQuery, queryString, segment, type OperatorTransport } from './transport.js';

/** A plan's prices, one per currency. */
export class OperatorPlanPricesClient {
  constructor(private readonly transport: OperatorTransport) {}

  private path(plan: string, currency: string): string {
    return `${this.transport.base}/plans/${segment(plan)}/prices/${segment(currency.toUpperCase())}`;
  }

  /**
   * Every price a plan sells at, the default one first, each with where it
   * stands at the payment provider. Read from the Application's plan list.
   *
   * @example
   * ```ts
   * const prices = await operator.plans.prices.list('pro');
   * for (const price of prices) console.log(price.currency, formatMoney(price.amount, price.currency));
   * ```
   *
   * @throws {RekeyError} `PLAN_NOT_FOUND` when no plan of the Application has that id or slug.
   */
  async list(plan: string): Promise<PlanPriceDto[]> {
    for (let offset = 0; ; offset += 100) {
      const page = await this.transport.send<Paged<PlanDto>>(
        'GET',
        `${this.transport.base}/plans${queryString({ limit: 100, offset })}`,
      );
      const found = page.items.find((each) => each.id === plan || each.slug === plan);
      if (found) return found.prices;
      if (!page.page.hasMore) {
        throw new RekeyError({
          code: 'PLAN_NOT_FOUND',
          message: `No plan "${plan}" on this Application.`,
          fix: 'Call `operator.plans.list()` and use an `id` or `slug` from it.',
          statusCode: 404,
        });
      }
    }
  }

  /**
   * Add a price in a currency, or change the one the plan has.
   *
   * `amount` is an integer in the minor unit of `currency`: 149900 is
   * ₹1,499.00 and 5000 is ¥5,000. It is required to add a price, and can
   * change only until a provider has registered the price, which happens at
   * its first recurring checkout. `countries` (ISO 3166-1 alpha-2) can change
   * at any time; empty means wherever the currency is the local one.
   *
   * The change is written to the billing log as `plan.price_set`.
   *
   * @example
   * ```ts
   * const price = await operator.plans.prices.set('pro', 'INR', { amount: 149900, countries: ['IN'] });
   * console.log(price.registration.status); // 'PENDING' until its first recurring checkout
   * ```
   *
   * @throws {RekeyError} `PLAN_PRICE_CURRENCY_INVALID`, `PLAN_PRICE_CURRENCY_UNSUPPORTED`,
   * `PLAN_PRICE_AMOUNT_INVALID`, `PLAN_PRICE_COUNTRY_INVALID`, `PLAN_PRICE_IS_DEFAULT`,
   * `PLAN_PRICE_NOT_APPLICABLE` (400); `PLAN_PRICE_IMMUTABLE`, `PLAN_PRICE_REFERENCED` (409).
   */
  set(plan: string, currency: string, input: SetPlanPriceRequest): Promise<PlanPriceDto> {
    return this.transport.send('PUT', this.path(plan, currency), input);
  }

  /**
   * Take a price off sale. Refused with `PLAN_PRICE_IN_USE` (409) while a live
   * subscription or an open checkout is on it: a subscriber keeps their
   * currency for the life of the subscription. The plan's default price
   * cannot be removed here. Written to the billing log as `plan.price_archived`.
   *
   * @example
   * ```ts
   * await operator.plans.prices.archive('pro', 'INR');
   * ```
   */
  archive(plan: string, currency: string): Promise<{ deleted: boolean }> {
    return this.transport.send('DELETE', this.path(plan, currency));
  }
}

/** Plans as their operator reads them. */
export class OperatorPlansClient {
  /** A plan's prices in each currency. */
  public readonly prices: OperatorPlanPricesClient;

  constructor(private readonly transport: OperatorTransport) {
    this.prices = new OperatorPlanPricesClient(transport);
  }

  /**
   * Every plan of the Application, active or not, newest first. Each carries
   * `prices` (with where each stands at the provider), `price` (the default
   * price resolved), and `checkout`: whether a buyer would get a checkout,
   * and which provider refuses when not.
   *
   * Each price also says whether its amount can still change
   * (`amountEditable`, the rule `plans.prices.set` refuses by) and who is on
   * it (`liveSubscriptions`, `openCheckouts`: with either above 0,
   * `plans.prices.archive` is refused).
   *
   * @example
   * ```ts
   * const { items } = await operator.plans.list();
   * const broken = items.filter((plan) => plan.checkout && !plan.checkout.ready);
   * const removable = items.flatMap((plan) => plan.prices).filter((price) => !price.isDefault && price.liveSubscriptions + price.openCheckouts === 0);
   * ```
   */
  list(page?: ListPage): Promise<Paged<PlanDto>> {
    return this.transport.send('GET', `${this.transport.base}/plans${queryString(pageQuery(page))}`);
  }

  /**
   * Create a plan. `price` is its default price, with `amount` an integer in
   * the minor unit of `currency`: 1900 is $19.00 and 5000 is ¥5,000. Leave
   * `price` out for a free plan, or for a USAGE plan with no base fee. Prices
   * in other currencies are added afterwards with `plans.prices.set`.
   *
   * A plan has no `amount`, `currency` or `pricePerUnitCents` of its own: a
   * body that sends one is refused with `BILLING_FIELD_REMOVED`.
   *
   * @example
   * ```ts
   * const plan = await operator.plans.create({ slug: 'pro', name: 'Pro', price: { currency: 'USD', amount: 1900 } });
   * console.log(plan.price?.formatted); // '$19.00'
   * ```
   *
   * @throws {RekeyError} `PLAN_SLUG_INVALID`, `PLAN_PRICE_CURRENCY_INVALID`,
   * `PLAN_PRICE_CURRENCY_UNSUPPORTED`, `PLAN_PRICE_AMOUNT_INVALID`, `BILLING_FIELD_REMOVED` (400);
   * `PLAN_SLUG_TAKEN` (409).
   */
  create(input: CreatePlanRequest): Promise<PlanDto> {
    return this.transport.send('POST', `${this.transport.base}/plans`, input);
  }

  /**
   * Change a plan: any subset of the fields. `price` and `interval` are
   * accepted only until a provider has registered the plan
   * (`PLAN_PRICE_IMMUTABLE` after that). `price: null` makes the plan free.
   *
   * `localPrices` says whether a buyer's country may select one of the plan's
   * prices in another currency: `INHERIT` follows the Application's setting,
   * `TRUSTED` needs a country your server declared or a trusted proxy vouched
   * for, and `OFF` charges every buyer the default price unless your server
   * names a `currency` at checkout. It can change at any time, and a change is
   * written to the billing log as `plan.local_prices_changed`.
   *
   * @example
   * ```ts
   * await operator.plans.update('pro', { name: 'Pro', price: { currency: 'USD', amount: 2900 } });
   * await operator.plans.update('pro', { localPrices: 'OFF' }); // one price for every country
   * await operator.plans.update('pro', { active: false }); // retire it
   * ```
   *
   * @throws {RekeyError} `BILLING_FIELD_REMOVED`, `PLAN_PRICE_AMOUNT_INVALID` (400);
   * `PLAN_NOT_FOUND` (404); `PLAN_PRICE_IMMUTABLE`, `PLAN_PRICE_IS_DEFAULT` (409).
   */
  update(slug: string, input: UpdatePlanRequest): Promise<PlanDto> {
    return this.transport.send('PATCH', `${this.transport.base}/plans/${segment(slug)}`, input);
  }
}

/** Coupons: a percentage, or an amount per currency. */
export class OperatorCouponsClient {
  constructor(private readonly transport: OperatorTransport) {}

  /**
   * Every coupon, each with what it has taken off per currency. There is no
   * total: money in two currencies is never added together.
   *
   * @example
   * ```ts
   * const { items } = await operator.coupons.list({ limit: 100 });
   * for (const coupon of items) {
   *   for (const row of coupon.discountIssuedByCurrency) {
   *     console.log(coupon.code, formatMoney(row.amount, row.currency), row.redemptions);
   *   }
   * }
   * ```
   */
  list(page?: ListPage): Promise<Paged<CouponWithStatsDto>> {
    return this.transport.send('GET', `${this.transport.base}/coupons${queryString(pageQuery(page))}`);
  }

  /**
   * One coupon by its code. `coveredCurrencies` is every currency a checkout
   * may use it in, or null for any.
   *
   * @example
   * ```ts
   * const coupon = await operator.coupons.get('LAUNCH');
   * const worksInRupees = coupon.coveredCurrencies === null || coupon.coveredCurrencies.includes('INR');
   * ```
   *
   * @throws {RekeyError} `COUPON_NOT_FOUND` (404).
   */
  get(code: string): Promise<CouponDto> {
    return this.transport.send('GET', `${this.transport.base}/coupons/${segment(code)}`);
  }

  /**
   * Create a coupon.
   *
   * A PERCENT coupon takes `basisPoints` (hundredths of a percent: 1500 is
   * 15%) and works in every currency unless `currencies` limits it. An AMOUNT
   * coupon takes `amounts`, one per currency, each an integer in that
   * currency's minor unit, and works only in those currencies: an amount is
   * never converted. A checkout in a currency the coupon does not cover is
   * refused with `COUPON_CURRENCY_NOT_COVERED`.
   *
   * Pass `idempotencyKey` to make a retry safe.
   *
   * @example
   * ```ts
   * await operator.coupons.create({ code: 'LAUNCH', discountType: 'PERCENT', basisPoints: 1500 });
   *
   * await operator.coupons.create({
   *   code: 'FIVEOFF',
   *   discountType: 'AMOUNT',
   *   amounts: [
   *     { currency: 'USD', amountOff: 500 },
   *     { currency: 'INR', amountOff: 40000 },
   *   ],
   * });
   * ```
   *
   * @throws {RekeyError} `COUPON_DISCOUNT_SHAPE_INVALID`, `COUPON_AMOUNTS_REQUIRED`,
   * `COUPON_AMOUNT_INVALID`, `COUPON_CURRENCY_INVALID` (400); `BILLING_FIELD_REMOVED` (400)
   * for a body that still sends `amountOff` or `currency` at the top level.
   */
  create(input: CreateCouponRequest, options?: { idempotencyKey?: string }): Promise<CouponDto> {
    return this.transport.send(
      'POST',
      `${this.transport.base}/coupons`,
      input,
      options?.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
    );
  }

  /**
   * Change a coupon: `active`, `basisPoints`, `amounts`, `currencies`,
   * `planSlugs`, `endsAt`, `maxRedemptions` or `maxRedemptionsPerUser`.
   * `amounts` replaces the whole set, so send every currency the coupon
   * should keep. A coupon's `discountType` cannot change.
   *
   * `endsAt` and the two caps each take a value or `null`: null removes the
   * end date or the cap. A cap below the redemptions already held (settled
   * ones plus checkouts still open) is refused, and the error's
   * `details.redeemed` is the count. Every change is written to the billing
   * log as `coupon.changed`, with the terms before and after.
   *
   * @example
   * ```ts
   * await operator.coupons.update('FIVEOFF', {
   *   amounts: [
   *     { currency: 'USD', amountOff: 500 },
   *     { currency: 'EUR', amountOff: 450 },
   *   ],
   * });
   * await operator.coupons.update('LAUNCH', { active: false });
   * await operator.coupons.update('LAUNCH', { endsAt: '2026-12-31T23:59:59.000Z', maxRedemptions: 500 });
   * await operator.coupons.update('LAUNCH', { maxRedemptionsPerUser: null });
   * ```
   *
   * @throws {RekeyError} `COUPON_LIMIT_BELOW_REDEEMED` (409) for a cap below what is already redeemed;
   * `COUPON_NOT_FOUND` (404); the 400 codes {@link create} lists.
   */
  update(code: string, input: UpdateCouponRequest): Promise<CouponDto> {
    return this.transport.send('PATCH', `${this.transport.base}/coupons/${segment(code)}`, input);
  }
}
