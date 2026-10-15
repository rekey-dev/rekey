/**
 * Each provider's wire scale: a stored amount is an integer at the ISO 4217
 * exponent, and what Stripe, PayPal and Razorpay take and report for the same
 * money is not always that integer. Both directions, the refusals for an
 * amount that cannot be converted exactly, and what each webhook translator
 * hands the applier.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { isSellableCurrency, minorUnitExponent, sellableCurrencies, validatePriceAmount } from '@rekey.dev/shared-types';
import { RekeyError } from '../src/lib/error.js';
import * as stripeMoney from '../src/modules/billing/providers/stripe-money.js';
import * as paypalMoney from '../src/modules/billing/providers/paypal-money.js';
import * as razorpayMoney from '../src/modules/billing/providers/razorpay-money.js';
import { paymentPurchase } from '../src/modules/billing/providers/stripe-session-params.js';
import { stripeModule } from '../src/modules/billing/providers/modules/stripe/index.js';
import { paypalModule } from '../src/modules/billing/providers/modules/paypal/index.js';
import { razorpayModule } from '../src/modules/billing/providers/modules/razorpay/index.js';
import { externalModule } from '../src/modules/billing/providers/modules/external/index.js';
import type { CheckoutSessionInput } from '../src/modules/billing/providers/types.js';
import type { DomainBillingEvent, TranslateCtx } from '../src/modules/billing/providers/module-types.js';

const APP_ID = 'app_wire';

function ctx(): TranslateCtx {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger,
    applicationId: APP_ID,
    providerEventId: 'evt_wire',
  } as never;
}

function refusalOf(run: () => void): RekeyError {
  try {
    run();
  } catch (e) {
    if (e instanceof RekeyError) return e;
    throw e;
  }
  throw new Error('expected a refusal, and the conversion went through');
}

function expectNotChargeable(run: () => void): void {
  const refusal = refusalOf(run);
  expect(refusal.code).toBe('BILLING_AMOUNT_NOT_CHARGEABLE');
  expect(refusal.statusCode).toBe(400);
  expect(refusal.fix ?? '').not.toBe('');
}

/** The amount the first payment-bearing event of a translation carries. */
function amountOf(events: DomainBillingEvent[] | null): number | null | undefined {
  for (const event of events ?? []) {
    if (event.type === 'payment.succeeded' || event.type === 'payment.failed' || event.type === 'payment.refunded') {
      return event.amount;
    }
    if (event.type === 'checkout.completed' && event.payment) return event.payment.amount;
  }
  throw new Error('no payment in the translated events');
}

describe('Stripe wire scale', () => {
  const { toProviderAmount, fromProviderAmount, stripeWebhookAmount } = stripeMoney;

  it('refuses an amount Stripe cannot take exactly', () => {
    expectNotChargeable(() => toProviderAmount('MGA', 150050));
    expectNotChargeable(() => toProviderAmount('USD', 19.99));
    expectNotChargeable(() => toProviderAmount('ABC', 100));
    expectNotChargeable(() => toProviderAmount('', 100));
    expectNotChargeable(() => toProviderAmount('KWD', 1001));
  });

  it('refuses a reported amount that is not a whole number of stored units', () => {
    expectNotChargeable(() => fromProviderAmount('ISK', 550));
    expectNotChargeable(() => fromProviderAmount('UGX', 12345));
    expectNotChargeable(() => fromProviderAmount('ABC', 100));
  });

  it('takes every currency it lists, and back, in whole units', () => {
    for (const currency of stripeModule.display.supportedCurrencies as string[]) {
      const stored = 1234 * 10 ** (minorUnitExponent(currency) ?? 0);
      expect(fromProviderAmount(currency, toProviderAmount(currency, stored)), currency).toBe(stored);
    }
  });

  it('a one-time checkout sends the scaled unit amount', () => {
    const input = {
      application: { id: APP_ID, slug: 'wire' },
      endUser: { id: 'eu_1', email: 'buyer@example.com' },
      plan: { id: 'pl_1', name: 'Pack', amount: 5000, currency: 'ISK' },
    } as unknown as CheckoutSessionInput;
    expect(paymentPurchase(input, undefined).line_items?.[0]?.price_data).toMatchObject({
      currency: 'isk',
      unit_amount: 500000,
    });
  });

  const translate = stripeModule.webhook.translate.bind(stripeModule.webhook);
  const invoicePaid = (currency: string, amountPaid: number) => ({
    id: 'evt_inv',
    type: 'invoice.paid',
    data: {
      object: {
        id: 'in_1',
        subscription: 'sub_1',
        amount_paid: amountPaid,
        currency,
        billing_reason: 'subscription_cycle',
        metadata: { applicationId: APP_ID },
      },
    },
  });

  it.each([
    ['usd', 1999, 1999],
    ['jpy', 5000, 5000],
    ['isk', 500000, 5000],
    ['ugx', 500000, 5000],
    ['huf', 500000, 500000],
    ['mga', 1500, 150000],
  ])('invoice.paid in %s carrying %i is normalised to stored %i', async (currency, wire, stored) => {
    expect(amountOf(await translate(invoicePaid(currency, wire), ctx()))).toBe(stored);
  });

  it('a one-time session, a failed invoice and a refund are normalised too', async () => {
    const session = {
      id: 'evt_cs',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          mode: 'payment',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 500000,
          currency: 'ugx',
          metadata: { applicationId: APP_ID },
        },
      },
    };
    expect(amountOf(await translate(session, ctx()))).toBe(5000);

    const failed = { ...invoicePaid('isk', 0), type: 'invoice.payment_failed' };
    (failed.data.object as { amount_due?: number }).amount_due = 700000;
    expect(amountOf(await translate(failed, ctx()))).toBe(7000);

    const refunded = {
      id: 'evt_re',
      type: 'charge.refunded',
      data: {
        object: { id: 'ch_1', invoice: 'in_1', amount_refunded: 250000, currency: 'isk', metadata: { applicationId: APP_ID } },
      },
    };
    const events = await translate(refunded, ctx());
    expect(events?.[0]).toMatchObject({ type: 'payment.refunded', amount: 2500, refundedTotal: 2500 });
  });

  it('an inexact webhook amount is handed over as NaN for the applier gate to drop, never rounded', async () => {
    expect(amountOf(await translate(invoicePaid('isk', 550), ctx()))).toBeNaN();
    expect(stripeWebhookAmount('isk', null)).toBeNull();
    expect(stripeWebhookAmount(null, 1999)).toBe(1999);
  });
});

describe('PayPal wire scale', () => {
  const { toProviderAmount, fromProviderAmount, paypalMinorFromMajor } = paypalMoney;

  it.each([
    ['USD', 1999, '19.99'],
    ['USD', 5, '0.05'],
    ['USD', 5000, '50.00'],
    ['JPY', 5000, '5000'],
    ['HUF', 500000, '5000'],
    ['TWD', 120000, '1200'],
  ])('%s stored %i goes out as "%s" and comes back', (currency, stored, wire) => {
    expect(toProviderAmount(currency, stored)).toBe(wire);
    expect(fromProviderAmount(currency, wire)).toBe(stored);
    expect(paypalMinorFromMajor(wire, currency.toLowerCase())).toBe(stored);
  });

  it('reads the trailing zeros PayPal sometimes writes on a no-decimals currency', () => {
    expect(fromProviderAmount('HUF', '5000.00')).toBe(500000);
    expect(fromProviderAmount('JPY', '5000.0')).toBe(5000);
  });

  it('refuses an amount PayPal cannot take exactly', () => {
    expectNotChargeable(() => toProviderAmount('HUF', 500050));
    expectNotChargeable(() => toProviderAmount('TWD', 1));
    expectNotChargeable(() => toProviderAmount('USD', 19.99));
    expectNotChargeable(() => toProviderAmount('USD', -100));
    expectNotChargeable(() => toProviderAmount('KWD', 1000));
    expectNotChargeable(() => toProviderAmount('ABC', 100));
  });

  it('refuses a reported amount that is not exactly a stored amount', () => {
    expectNotChargeable(() => fromProviderAmount('HUF', '5000.50'));
    expectNotChargeable(() => fromProviderAmount('JPY', '50.5'));
    expectNotChargeable(() => fromProviderAmount('USD', '19.999'));
    expectNotChargeable(() => fromProviderAmount('USD', 'abc'));
    expectNotChargeable(() => fromProviderAmount('USD', '-5.00'));
    expectNotChargeable(() => fromProviderAmount('ABC', '5.00'));
    expect(paypalMinorFromMajor('5000.50', 'HUF')).toBeNull();
    expect(paypalMinorFromMajor('', 'USD')).toBeNull();
    expect(paypalMinorFromMajor('5.00', undefined)).toBeNull();
  });

  const translate = (payload: unknown): DomainBillingEvent[] | null =>
    paypalModule.webhook.translate(payload, ctx()) as DomainBillingEvent[] | null;
  const sale = (total: string, currency: string) => ({
    id: 'WH-1',
    event_type: 'PAYMENT.SALE.COMPLETED',
    resource: { id: 'SALE-1', amount: { total, currency } },
  });

  it.each([
    ['USD', '49.99', 4999],
    ['JPY', '5000', 5000],
    ['HUF', '5000', 500000],
    ['TWD', '1200', 120000],
  ])('a %s sale of "%s" is normalised to stored %i', (currency, total, stored) => {
    expect(amountOf(translate(sale(total, currency)))).toBe(stored);
  });

  it('a refund on a no-decimals currency is normalised the same way', () => {
    const events = translate({
      id: 'WH-2',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REF-1', custom_id: `${APP_ID}:eu_1`, amount: { value: '2500', currency_code: 'HUF' } },
    });
    expect(amountOf(events)).toBe(250000);
  });

  // The report is passed on, not dropped: the applier refuses an amount that
  // is not a number and writes `payment.not_recorded` quoting PayPal's own
  // string (paypal-webhook.test.ts holds that no payment row is written).
  it.each([
    ['5000.50', 'HUF'],
    ['50.5', 'JPY'],
  ])('a sale of "%s" %s, not exact in its currency, carries no storable amount and keeps the amount as PayPal wrote it', (total, currency) => {
    const events = translate(sale(total, currency));
    expect(events).toHaveLength(1);
    expect(events?.[0]).toMatchObject({ type: 'payment.succeeded', currency, reportedAmount: total });
    expect(amountOf(events)).toBeNaN();
  });
});

describe('Razorpay wire scale', () => {
  const { toProviderAmount, fromProviderAmount, razorpayWebhookAmount } = razorpayMoney;

  it('refuses a fractional amount and a currency of unknown scale', () => {
    expectNotChargeable(() => toProviderAmount('INR', 499.5));
    expectNotChargeable(() => toProviderAmount('ABC', 100));
    expectNotChargeable(() => toProviderAmount('', 100));
    expectNotChargeable(() => fromProviderAmount('INR', 499.5));
    expectNotChargeable(() => fromProviderAmount('ABC', 100));
  });

  const translate = (payload: unknown): DomainBillingEvent[] | null =>
    razorpayModule.webhook.translate(payload, ctx()) as DomainBillingEvent[] | null;

  it.each([
    ['INR', 19900],
    ['USD', 1999],
    ['JPY', 5000],
    ['HUF', 500000],
  ])('payment_link.paid in %s carries stored %i', (currency, amount) => {
    const events = translate({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1' } },
        payment: { entity: { id: 'pay_1', amount, currency } },
      },
    });
    expect(amountOf(events)).toBe(amount);
  });

  it('a fractional webhook amount is handed over as NaN for the applier gate to drop', () => {
    expect(razorpayWebhookAmount('INR', 12.5)).toBeNaN();
    expect(razorpayWebhookAmount('INR', undefined)).toBeUndefined();
    expect(razorpayWebhookAmount(undefined, 49900)).toBe(49900);
  });
});

/**
 * The same money as each provider's documentation says to write it. Literal
 * on both sides: a round trip passes for any exponent that is wrong the same
 * way in both directions, and these do not.
 *
 * Stored amounts are integers at the ISO 4217 exponent: USD 19.99 is 1999,
 * JPY 5,000 is 5000, HUF 5,000 is 500000, MGA 1,500 is 150000.
 */
describe('what each provider is sent, per its own documentation', () => {
  // https://docs.stripe.com/currencies#zero-decimal lists JPY, KRW, VND, MGA
  // and UGX among the zero-decimal currencies ("to charge 500 JPY, provide an
  // amount value of 500"). #special-cases: ISK and UGX are "represented as a
  // two-decimal value, where the decimal amount is always 00" ("to charge 5
  // ISK, provide an amount value of 500"); HUF and TWD are charged as
  // two-decimal amounts. Everything else is in the currency's minor unit.
  const STRIPE: Array<[string, number, number]> = [
    ['USD', 1999, 1999],
    ['JPY', 5000, 5000],
    ['HUF', 500000, 500000],
    ['ISK', 5000, 500000],
    ['UGX', 5000, 500000],
    ['MGA', 150000, 1500],
  ];
  it.each(STRIPE)('Stripe: %s stored %i is sent as %i, and read back', (currency, stored, wire) => {
    expect(stripeMoney.toProviderAmount(currency, stored)).toBe(wire);
    expect(stripeMoney.fromProviderAmount(currency, wire)).toBe(stored);
    expect(stripeMoney.fromProviderAmount(currency.toLowerCase(), wire)).toBe(stored);
    expect(stripeMoney.stripeWebhookAmount(currency.toLowerCase(), wire)).toBe(stored);
  });

  // https://developer.paypal.com/api/rest/reference/currency-codes/ : amounts
  // are decimal strings in major units, and HUF, JPY and TWD "do not support
  // decimals". CZK does: 150.00, not 15000 and not 150.
  const PAYPAL: Array<[string, number, string]> = [
    ['CZK', 15000, '150.00'],
  ];
  it.each(PAYPAL)('PayPal: %s stored %i is sent as "%s", and read back', (currency, stored, wire) => {
    expect(paypalMoney.toProviderAmount(currency, stored)).toBe(wire);
    expect(paypalMoney.fromProviderAmount(currency, wire)).toBe(stored);
  });

  // https://razorpay.com/docs/payments/international-payments/#supported-currencies
  // gives an exponent per currency, and the amount is in that subunit: INR
  // and USD at 2 (paise, cents), JPY, KRW, VND, ISK and UGX at 0, HUF, TWD
  // and MGA at 2. That is the ISO exponent each time, so the stored integer
  // is the integer sent. KRW 5,000 is 5000, never 500000.
  const RAZORPAY: Array<[string, number, number]> = [
    ['INR', 149900, 149900],
    ['JPY', 5000, 5000],
    ['ISK', 5000, 5000],
    ['HUF', 500000, 500000],
    ['MGA', 150000, 150000],
  ];
  it.each(RAZORPAY)('Razorpay: %s stored %i is sent as %i, and read back', (currency, stored, wire) => {
    expect(razorpayMoney.toProviderAmount(currency, stored)).toBe(wire);
    expect(razorpayMoney.fromProviderAmount(currency, wire)).toBe(stored);
    expect(razorpayMoney.fromProviderAmount(currency.toLowerCase(), wire)).toBe(stored);
    expect(razorpayMoney.razorpayWebhookAmount(currency, wire)).toBe(stored);
  });

  it('KWD is refused before it reaches any of them: three decimals, and no provider takes the third', () => {
    expect(validatePriceAmount('KWD', 1005)).toMatchObject({ ok: false, rule: 'currency_not_sellable' });
    expectNotChargeable(() => stripeMoney.toProviderAmount('KWD', 1005));
    expectNotChargeable(() => paypalMoney.toProviderAmount('KWD', 1005));
    for (const module of [stripeModule, paypalModule, razorpayModule]) {
      expect(module.display.supportedCurrencies, module.name).not.toContain('KWD');
    }
  });
});

describe('provider currency lists', () => {
  it('Stripe lists the currencies it publishes, not every currency there is, and preselects all of them', () => {
    const listed = stripeModule.display.supportedCurrencies;
    expect(Array.isArray(listed)).toBe(true);
    expect(stripeModule.display.preselectedCurrencies).toEqual(listed);
    // Pinned: a change to this list is a change to what an operator may promise.
    // Every presentment currency on https://docs.stripe.com/currencies as read on 2026-10-11, less the
    // three-decimal ones (BHD, JOD, KWD, OMR, TND) and STD, which ISO 4217 has withdrawn.
    expect([...(listed as string[])].sort()).toEqual([
      'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BIF', 'BMD', 'BND',
      'BOB', 'BRL', 'BSD', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC', 'CVE', 'CZK', 'DJF',
      'DKK', 'DOP', 'DZD', 'EGP', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD',
      'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JMD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KRW', 'KYD', 'KZT',
      'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MUR', 'MVR', 'MWK', 'MXN',
      'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
      'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SZL', 'THB', 'TJS',
      'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG',
      'XOF', 'XPF', 'YER', 'ZAR', 'ZMW',
    ]);
    for (const absent of ['IRR', 'KPW', 'SYP', 'CUP', 'SDG', 'VES', 'KWD', 'BHD', 'XAU', 'BGN', 'STD']) expect(listed).not.toContain(absent);
  });

  it('the external module takes every sellable currency: the sale happened somewhere else', () => {
    expect(externalModule.display.supportedCurrencies).toBe('all-sellable');
    expect(externalModule.display.preselectedCurrencies).toEqual(sellableCurrencies());
    expect(sellableCurrencies()).toEqual(expect.arrayContaining(['USD', 'IRR', 'INR']));
  });

  it('Razorpay lists only sellable currencies and preselects INR', () => {
    const { supportedCurrencies, preselectedCurrencies } = razorpayModule.display;
    expect(preselectedCurrencies).toEqual(['INR']);
    expect(Array.isArray(supportedCurrencies)).toBe(true);
    expect(supportedCurrencies).toEqual(expect.arrayContaining(['INR', 'USD', 'JPY', 'ISK']));
    for (const code of ['KWD', 'BHD', 'HRK', 'SLL']) expect(supportedCurrencies).not.toContain(code);
  });

  it('every module preselects at least one currency: a row saved without a list must not charge nothing', () => {
    for (const module of [stripeModule, paypalModule, razorpayModule, externalModule]) {
      expect(module.display.preselectedCurrencies.length, module.name).toBeGreaterThan(0);
    }
  });

  it('every listed currency is one a price may be in', () => {
    for (const module of [stripeModule, paypalModule, razorpayModule]) {
      const listed = module.display.supportedCurrencies;
      if (listed === 'all-sellable') throw new Error(`${module.name} should list its currencies`);
      expect(listed.filter((code) => !isSellableCurrency(code))).toEqual([]);
      expect(module.display.preselectedCurrencies.filter((code) => !listed.includes(code))).toEqual([]);
    }
  });
});
