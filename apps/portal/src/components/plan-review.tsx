/**
 * One plan, reviewed before checkout: what this buyer will be charged, in
 * which currency, an optional coupon code, and the button that opens the
 * checkout.
 *
 * Every amount is the API's: the catalogue's resolved price, or the coupon
 * quote's price, discount and total. Nothing is added up or converted here.
 * The page works with no JavaScript: the code is applied by a plain GET form,
 * and the checkout by a server action.
 */

import * as React from 'react';
import type { BillingProviderInfoDto, ResolvedPriceDto } from '@rekey.dev/react';
import type { CouponQuote } from '@/lib/coupon-quote';
import { formatPlanPrice, type PricePlan } from '@/lib/format';
import { catalogueFallbackSentence, priceFallbackSentence } from '@/lib/price-notice';
import { Banner } from './banner';
import { Card } from './card';
import { ProviderRadios } from './provider-radios';
import { SubmitButton } from './submit-button';

export interface ReviewedPlan extends PricePlan {
  slug: string;
  name: string;
  price: Pick<ResolvedPriceDto, 'formatted' | 'currency' | 'reason' | 'requestedCurrency'> | null;
}

const INPUT =
  'min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]';
const QUIET_BUTTON =
  'rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]';

/** The sentence under a code that was not applied. The pay button below it still works, at full price. */
function refusalFollowUp(fullPrice: string): string {
  return `You can continue without the code and pay ${fullPrice}.`;
}

function CouponResult({
  coupon,
  fullPrice,
  reviewPath,
}: {
  coupon: CouponQuote | null;
  fullPrice: string;
  reviewPath: string;
}): React.JSX.Element | null {
  if (coupon === null) return null;
  if (coupon.kind === 'quote') {
    const { quote } = coupon;
    return (
      <dl className="mt-3 space-y-1 text-sm tabular-nums" aria-live="polite">
        <div className="flex justify-between gap-4 text-[var(--color-muted-fg)]">
          <dt>Price</dt>
          <dd>{quote.price?.formatted ?? fullPrice}</dd>
        </div>
        <div className="flex justify-between gap-4 text-[var(--color-muted-fg)]">
          <dt>
            Code {coupon.code}{' '}
            <a href={reviewPath} className="underline">
              Remove
            </a>
          </dt>
          <dd>−{quote.formatted.discount}</dd>
        </div>
        <div className="flex justify-between gap-4 font-medium text-[var(--color-fg)]">
          <dt>
            Price with this code <span className="font-normal text-[var(--color-muted-fg)]">({quote.currency.toUpperCase()})</span>
          </dt>
          <dd>{quote.formatted.total}</dd>
        </div>
      </dl>
    );
  }
  return (
    <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
      {coupon.kind === 'refused' ? coupon.message : 'That code could not be checked right now.'}{' '}
      <span className="text-[var(--color-muted-fg)]">{refusalFollowUp(fullPrice)}</span>
    </p>
  );
}

export function PlanReview({
  slug,
  plan,
  switching,
  team,
  coupon,
  providers,
  routedProvider,
  reviewPath,
  action,
}: {
  slug: string;
  plan: ReviewedPlan;
  /** The buyer already holds another plan. */
  switching: boolean;
  /** The team this checkout bills, on an Application that bills per organization. */
  team: string | null;
  coupon: CouponQuote | null;
  /** The providers that can charge this plan for this buyer. Offered as a choice only when there are several. */
  providers: BillingProviderInfoDto[];
  routedProvider: string | null;
  /** This page's own path, without a code. */
  reviewPath: string;
  action: (formData: FormData) => Promise<void>;
}): React.JSX.Element {
  const fullPrice = formatPlanPrice(plan);
  // The amount alone where a sentence names it: "pay $9.00", not "pay $9.00 · 500 credits".
  const fullAmount = plan.price?.formatted ?? fullPrice;
  const quoted = coupon?.kind === 'quote' ? coupon : null;
  const fallback = quoted?.quote.priceFallback
    ? priceFallbackSentence(quoted.quote.priceFallback)
    : catalogueFallbackSentence(plan.price);
  const verb = switching ? 'Switch to' : plan.kind === 'SUBSCRIPTION' ? 'Subscribe to' : 'Buy';

  return (
    <div className="space-y-6">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            {verb} {plan.name}
          </h2>
          {team && (
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-muted-fg)]">
              Team: {team}
            </span>
          )}
        </div>
        <p className="text-2xl font-semibold tracking-tight tabular-nums text-[var(--color-fg)]">{fullPrice}</p>
        {plan.price && (
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">Charged in {plan.price.currency.toUpperCase()}.</p>
        )}
        {fallback && (
          <div className="mt-3">
            <Banner tone="info">{fallback}</Banner>
          </div>
        )}

        {!plan.isFree && plan.price !== null && (
          <div className="mt-5 border-t border-[var(--color-border)] pt-4">
            <form method="get" action={reviewPath} className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs font-medium text-[var(--color-muted-fg)]">
                Coupon code
                <input
                  type="text"
                  name="coupon"
                  defaultValue={coupon?.code ?? ''}
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className={INPUT}
                />
              </label>
              <button type="submit" className={QUIET_BUTTON}>
                Apply
              </button>
            </form>
            <CouponResult coupon={coupon} fullPrice={fullAmount} reviewPath={reviewPath} />
          </div>
        )}

        <form action={action} className="mt-5 space-y-4">
          <input type="hidden" name="planSlug" value={plan.slug} />
          {/* Only a code the API priced goes to checkout. A refused one is left
              out, so the button below pays the full price instead of failing. */}
          {quoted && <input type="hidden" name="couponCode" value={quoted.code} />}
          {providers.length > 1 && <ProviderRadios providers={providers} routedProvider={routedProvider} />}
          <div className="flex items-center gap-3">
            <SubmitButton pendingLabel="Opening checkout…">Continue to checkout</SubmitButton>
            <a href={`/${slug}`} className="text-sm text-[var(--color-muted-fg)] underline hover:text-[var(--color-fg)]">
              Back
            </a>
          </div>
        </form>
      </Card>
    </div>
  );
}
