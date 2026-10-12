import { RekeyError } from '../../../lib/error.js';

/**
 * The refusal for an amount a provider cannot be given, or cannot give back,
 * exactly. Converting it anyway would charge or record a rounded figure.
 *
 * @example
 * throw amountNotChargeable('PayPal', 'HUF', 'PayPal takes HUF in whole units, and 500050 is 5000.50.', 'Set a price that ends in 00.');
 */
export function amountNotChargeable(provider: string, currency: string, reason: string, fix: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_AMOUNT_NOT_CHARGEABLE',
    message: `${provider} cannot take this ${currency.trim().toUpperCase() || 'unnamed-currency'} amount exactly. ${reason}`,
    fix,
  });
}

/**
 * The refusal for a currency whose number of decimal places Rekey does not
 * know, so no amount in it can be scaled.
 *
 * @example
 * throw unknownCurrencyScale('Stripe', 'ABC');
 */
export function unknownCurrencyScale(provider: string, currency: string | null | undefined): RekeyError {
  const code = (currency ?? '').trim().toUpperCase();
  return amountNotChargeable(
    provider,
    code,
    code === ''
      ? 'No currency was named, so the amount has no scale.'
      : `Rekey has no record of how many decimal places ${code} has.`,
    'Use an ISO 4217 currency code a Rekey price can be in, for example USD, EUR or INR, with the amount as a whole number of its smallest unit.',
  );
}
