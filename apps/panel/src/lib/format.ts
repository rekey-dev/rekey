/**
 * Format helpers, kept tiny. Tailwind handles styling; this module just turns
 * server data into display strings.
 */

import { describeClientUserAgent } from '@rekey.dev/shared-types';
import { formatMoney as formatRegistryMoney } from '@rekey.dev/shared-types/currency';

const DEFAULT_MONEY_LOCALE = 'en-US';

/**
 * The locale each currency is written in, where en-US would group its digits
 * wrongly: rupees are read in lakhs, 1,00,000 and not 100,000. English
 * locales only, since the panel is in English.
 *
 * Chosen by the currency and never by the runtime, so an amount rendered on
 * the server and the same amount rendered in a client component (the preview
 * in the add-price form) read the same whatever the operator's browser is set
 * to.
 */
const MONEY_LOCALE_BY_CURRENCY: Readonly<Record<string, string>> = {
  INR: 'en-IN',
};

function moneyLocale(currency: string): string {
  const code = currency.toUpperCase();
  return Object.hasOwn(MONEY_LOCALE_BY_CURRENCY, code)
    ? (MONEY_LOCALE_BY_CURRENCY[code] as string)
    : DEFAULT_MONEY_LOCALE;
}

/**
 * Format a stored minor-unit amount as a price, such as (999, 'USD') as
 * '$9.99', (1500, 'JPY') as '¥1,500', (500000, 'HUF') as 'HUF 5,000' and
 * (10000000, 'INR') as '₹1,00,000.00'.
 *
 * How many decimals the amount has is the currency registry's answer. This
 * only picks the locale. Throws a RangeError for an amount that is not a
 * whole number.
 */
export function formatMoney(amount: number, currency: string): string {
  return formatRegistryMoney(amount, currency, moneyLocale(currency));
}

export function formatPercent(basisPointsTimesTen: number): string {
  return `${(basisPointsTimesTen / 100).toFixed(2)}%`;
}

/** What `describeUserAgent` decided a session actually is. */
export interface DescribedUserAgent {
  /** Human label for the device row. */
  label: string;
  /**
   * Set when the row is NOT a device the operator owns, i.e. the panel's own
   * server-side fetch. The sessions list tells people to "revoke any you don't
   * recognize", so an unexplained `node` row invites them to revoke their own
   * working session.
   */
  note?: string;
}

/**
 * Turn a raw User-Agent into something an operator can act on.
 *
 * The one that matters is bare `node`/`undici`/`next`, that is the PANEL
 * itself calling the API server-side on the operator's behalf, not a second
 * machine someone signed in from. It looked identical to a real device on a
 * page whose instruction is "revoke any you don't recognize".
 */
export function describeUserAgent(ua: string | null): DescribedUserAgent {
  const raw = (ua ?? '').trim();
  if (raw === '') return { label: 'Unknown device' };

  // Server-side runtimes. Node's default fetch UA is literally `node`; undici
  // and Next's server fetch identify similarly.
  if (/^(node|undici|next)\b/i.test(raw) || /^node-fetch/i.test(raw)) {
    return {
      label: 'Rekey panel (server-side)',
      note: 'This is the panel itself calling the API for you, not another device. Revoking it signs you out of the panel.',
    };
  }

  const { os, browser } = describeClientUserAgent(raw);

  if (browser && os) return { label: `${browser} on ${os}` };
  if (browser) return { label: browser };
  if (os) return { label: os };
  // Unrecognised: show it, truncated, rather than inventing a label.
  return { label: raw.length > 60 ? `${raw.slice(0, 57)}…` : raw };
}

/** `plural(3, 'device')` is "3 devices"; pass `many` for irregular nouns. */
export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;
}
