'use client';

/**
 * What a buyer is told about the price before they pay: that the default
 * price is charged because theirs could not be, and what a coupon takes off.
 * Both render text the API wrote; neither computes an amount.
 */

import * as React from 'react';
import { Themed, useCx, type AppearanceProp } from './theme.js';
import type { ValidateCouponResultDto } from '@rekey.dev/shared-types';
import { priceFallbackMessage, type PriceFallbackSides } from '@rekey.dev/shared-types/currency';

export interface PriceFallbackNoticeProps {
  /**
   * `priceFallback` from `createCheckout()` or `validateCoupon()`. Null when
   * the price selected is the price charged, and nothing is rendered.
   */
  fallback: PriceFallbackSides | null | undefined;
  /** Your own wording, in place of the default sentence. */
  children?: React.ReactNode;
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * Tells the buyer, before they pay, that the price in their own currency
 * cannot be charged and what they will pay instead. Renders nothing when
 * there was no fallback, so it can sit in the page unconditionally.
 *
 * @example
 * ```tsx
 * // Server action: const checkout = await rekey.billing.createCheckout(token, input);
 * // Show this, then send the buyer to checkout.url.
 * <PriceFallbackNotice fallback={checkout.priceFallback} />
 * // "Prices in INR are not available yet. You will pay $19.00."
 * ```
 */
export function PriceFallbackNotice({
  fallback, children, appearance, className,
}: PriceFallbackNoticeProps): React.JSX.Element | null {
  if (!fallback) return null;
  return (
    <Themed appearance={appearance} className={className}>
      <PriceFallbackLine fallback={fallback}>{children}</PriceFallbackLine>
    </Themed>
  );
}

function PriceFallbackLine({
  fallback, children,
}: { fallback: PriceFallbackSides; children?: React.ReactNode }): React.JSX.Element {
  const cx = useCx();
  return (
    <div role="status" className={cx('rekey-alert rekey-alert-info rekey-price-fallback', 'alert')}>
      {children ?? priceFallbackMessage(fallback)}
    </div>
  );
}

export interface CouponQuoteProps {
  /** What `validateCoupon()` resolved to. */
  quote: Pick<ValidateCouponResultDto, 'coupon' | 'formatted' | 'priceFallback'>;
  appearance?: AppearanceProp;
  className?: string;
}

/**
 * The result of a coupon preview: what the code takes off and what the buyer
 * pays, in the currency their checkout charges. When the quote is for the
 * plan's default price because the price selected could not be charged, it
 * says that first.
 *
 * A refused code throws from `validateCoupon()`. Show that error's `message`
 * in place of this component: for `COUPON_CURRENCY_NOT_COVERED` it reads
 * "This code does not work for prices in INR", and the buyer can continue
 * without the code.
 *
 * @example
 * ```tsx
 * // const quote = await client.validateCoupon(accessToken, { code, planSlug: 'pro' });
 * <CouponQuote quote={quote} />
 * // "LAUNCH50 takes ₹750.00 off. You pay ₹749.00."
 * ```
 */
export function CouponQuote({ quote, appearance, className }: CouponQuoteProps): React.JSX.Element {
  return (
    <Themed appearance={appearance} className={className}>
      {quote.priceFallback && <PriceFallbackLine fallback={quote.priceFallback} />}
      <CouponQuoteLine quote={quote} />
    </Themed>
  );
}

function CouponQuoteLine({ quote }: { quote: CouponQuoteProps['quote'] }): React.JSX.Element {
  const cx = useCx();
  return (
    <div role="status" className={cx('rekey-alert rekey-alert-info rekey-coupon-quote', 'alert')}>
      {quote.coupon.code} takes {quote.formatted.discount} off. You pay {quote.formatted.total}.
    </div>
  );
}
