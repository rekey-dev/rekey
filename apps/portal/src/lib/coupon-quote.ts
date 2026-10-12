/**
 * What a coupon code is worth on one plan for the signed-in buyer, asked of
 * `POST /api/v1/billing/coupons/validate` before a checkout is opened.
 *
 * Every figure shown comes from the answer. A refusal carries the API's own
 * sentence, which names the buyer's currency and never the ones a code does
 * cover. Its `fix` is not shown: it tells an operator which panel screen and
 * which route repair the code.
 */

import 'server-only';
import { RekeyError, type RekeyBrowserClient } from '@rekey.dev/react';
import type { ValidateCouponResultDto } from '@rekey.dev/shared-types';

/** The longest code the API accepts. */
export const COUPON_CODE_MAX = 40;

export type CouponQuote =
  | { kind: 'quote'; code: string; quote: ValidateCouponResultDto }
  /** The API refused the code for this buyer and plan. `message` is its own. */
  | { kind: 'refused'; code: string; message: string }
  /** The answer could not be read. Nothing is known about the code. */
  | { kind: 'unavailable'; code: string };

/** A code as the buyer typed it, trimmed, or null when there is nothing to ask. */
export function couponCodeOf(raw: string | string[] | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  return code.length > 0 && code.length <= COUPON_CODE_MAX ? code : null;
}

/**
 * Whether a refusal is about the code. Anything else (a plan that is gone, a
 * session that ended) belongs to the page's own handling.
 */
export function isCouponRefusal(code: string | undefined): boolean {
  return (
    code !== undefined &&
    (code.startsWith('COUPON_') || code === 'BILLING_DISCOUNT_UNSUPPORTED')
  );
}

/**
 * @example
 * const result = await quoteCoupon(client, accessToken, { code: 'SPRING', planSlug: 'pro' });
 * if (result.kind === 'quote') show(result.quote.formatted.total);
 */
export async function quoteCoupon(
  client: RekeyBrowserClient,
  accessToken: string,
  input: { code: string; planSlug: string; organizationId?: string | null; provider?: string },
): Promise<CouponQuote> {
  const { code } = input;
  try {
    const quote = await client.validateCoupon(accessToken, {
      code,
      planSlug: input.planSlug,
      ...(input.organizationId && { organizationId: input.organizationId }),
      ...(input.provider && { provider: input.provider }),
    });
    return { kind: 'quote', code, quote };
  } catch (err) {
    if (!(err instanceof RekeyError)) return { kind: 'unavailable', code };
    if (isCouponRefusal(err.code) && err.message) return { kind: 'refused', code, message: err.message };
    return { kind: 'unavailable', code };
  }
}
