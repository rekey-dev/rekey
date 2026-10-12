/**
 * The checkout page, rendered on the server from the API's view of one
 * session. Everything the buyer reads before paying is here and needs no
 * JavaScript; only the payment region waits on the provider's script.
 *
 * Operator branding arrives already filtered by the API and is filtered again
 * here: colours through `safeCssColor` and a contrast check, URLs through
 * `safeHttpUrl`. Branding is applied as CSS custom properties in a nonce'd
 * style element, never as a style attribute, so the page works under a strict
 * style-src.
 */

import * as React from 'react';
import type { CheckoutPageOrder, CheckoutPageView } from '@rekey.dev/shared-types';
import { priceFallbackSentence } from '@/lib/price-notice';
import { safeCssColor, safeHttpUrl } from '@/lib/config';
import { formatMoney, intervalWord, readableAccent, readableSurface, type CheckoutLocale } from '@/lib/checkout-format';
import { checkoutProviderCopy } from '@/lib/checkout-provider-copy';
import type { RazorpayReturn } from '@/lib/checkout-razorpay-return';
import { portalBaseUrl } from '@/lib/env';
import { PaypalPayment } from './paypal-payment';
import { RazorpayFallback, type RazorpayFallbackTarget } from './razorpay-fallback';
import { RazorpayPayment } from './razorpay-payment';
import { stripeAppearance } from '@/lib/stripe-appearance';
import { payButtonLabel } from '@/lib/stripe-elements';
import { StripePayment } from './stripe-payment';

function brandCss(order: CheckoutPageOrder | null): string {
  const bg = readableSurface(safeCssColor(order?.merchant.backgroundColor ?? undefined) ?? null);
  const surface = readableSurface(safeCssColor(order?.merchant.surfaceColor ?? undefined) ?? null);
  const accent = readableAccent(safeCssColor(order?.merchant.primaryColor ?? undefined) ?? null, [bg, surface]);
  return `:root{--ck-accent:${accent};${bg ? `--ck-bg:${bg};` : ''}${surface ? `--ck-surface:${surface};` : ''}}`;
}

function TestBanner({ hint = '' }: { hint?: string }): React.JSX.Element {
  return (
    <div role="note" className="bg-[#fef3c7] px-4 py-2 text-center text-sm font-medium text-[#78350f]">
      Test mode: no real money moves.{hint && ` ${hint}`}
    </div>
  );
}

/** A page with no order on it: expired, already paid, invalid or unavailable. */
export function CheckoutNotice({
  title,
  body,
  returnUrl,
  returnLabel,
  testMode,
}: {
  title: string;
  body: string;
  returnUrl: string | null;
  returnLabel: string;
  testMode: boolean;
}): React.JSX.Element {
  return (
    <>
      {testMode && <TestBanner />}
      <main className="mx-auto max-w-sm px-5 pt-24 pb-10 text-center">
        <h1 className="text-balance text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-pretty text-sm leading-relaxed text-[var(--ck-muted-fg)]">{body}</p>
        {returnUrl && (
          <p className="mt-4">
            <a className="ck-link inline-flex min-h-[44px] items-center text-sm font-medium" href={returnUrl}>
              {returnLabel}
            </a>
          </p>
        )}
      </main>
    </>
  );
}

function renewalSentence(order: CheckoutPageOrder, locale: CheckoutLocale): string | null {
  const every = intervalWord(order.plan.interval);
  if (order.plan.kind !== 'recurring' || every === null) return null;
  const price = formatMoney(order.plan.amount, order.plan.currency, locale);
  return `Renews automatically at ${price} every ${every} until you cancel.`;
}

function CancelSentence({ order }: { order: CheckoutPageOrder }): React.JSX.Element {
  const manage = safeHttpUrl(order.manageUrl ?? undefined);
  const support = safeHttpUrl(order.merchant.supportUrl ?? undefined);
  const email = order.merchant.supportEmail;
  if (manage) {
    return (
      <>
        You can cancel any time from{' '}
        <a className="ck-link" href={manage}>
          your account
        </a>
        ; cancelling stops the next renewal.
      </>
    );
  }
  if (support) {
    return (
      <>
        You can cancel any time by contacting{' '}
        <a className="ck-link" href={support}>
          {order.merchant.displayName} support
        </a>
        ; cancelling stops the next renewal.
      </>
    );
  }
  if (email) {
    return (
      <>
        You can cancel any time by emailing{' '}
        <a className="ck-link [overflow-wrap:anywhere]" href={`mailto:${email}`}>
          {email}
        </a>
        ; cancelling stops the next renewal.
      </>
    );
  }
  return <>You can cancel any time from your {order.merchant.displayName} account; cancelling stops the next renewal.</>;
}

/**
 * Razorpay's fallback, which works with scripts blocked: a subscription's own
 * Razorpay page through the host-checked `continue` route, or the same order
 * posted to Razorpay Hosted Checkout. `prefill[contact]` is optional there and
 * Rekey holds no phone number, so the buyer enters one on Razorpay's page.
 */
function razorpayFallback(order: CheckoutPageOrder, basePath: string, logo: string | undefined): RazorpayFallbackTarget {
  const client = order.client;
  if (client.provider !== 'razorpay' || client.target.kind === 'subscription') return { kind: 'link', href: `${basePath}/continue` };
  const page = new URL(basePath, portalBaseUrl()).href;
  return {
    kind: 'hosted',
    fields: [
      ['key_id', client.keyId],
      ['order_id', client.target.orderId],
      ['amount', String(order.totalDueToday)],
      ['currency', order.plan.currency],
      ['name', order.merchant.displayName],
      ['description', order.plan.name],
      ...(logo ? [['image', logo] as const] : []),
      ['prefill[email]', order.buyerEmail],
      ['callback_url', `${page}/razorpay/return`],
      ['cancel_url', page],
    ],
  };
}

/** The one part of the page that differs per provider: its own payment component, and its no-script fallback. */
function PaymentRegion({
  order,
  nonce,
  basePath,
  fallbackLabel,
  providerName,
  initialPhase,
  razorpayReturn,
  total,
}: {
  order: CheckoutPageOrder;
  nonce: string;
  basePath: string;
  fallbackLabel: string;
  providerName: string;
  initialPhase: 'loading' | 'confirming';
  razorpayReturn: RazorpayReturn | null;
  total: string;
}): React.JSX.Element {
  const client = order.client;
  switch (client.provider) {
    case 'paypal':
      return (
        <>
          <PaypalPayment
            nonce={nonce}
            client={client}
            basePath={basePath}
            successUrl={order.successUrl}
            initialPhase={initialPhase}
            fallbackLabel={fallbackLabel}
          />
          <noscript>
            <p className="mt-2 text-sm">
              <a className="ck-link inline-flex min-h-[44px] items-center" href={`${basePath}/continue`}>
                {fallbackLabel}
              </a>
            </p>
          </noscript>
        </>
      );
    case 'razorpay': {
      const logo = safeHttpUrl(order.merchant.logoUrl ?? undefined);
      const fallback = razorpayFallback(order, basePath, logo);
      const returned = razorpayReturn === 'paid' ? 'claimed' : razorpayReturn;
      return (
        <>
          <RazorpayPayment
            nonce={nonce}
            keyId={client.keyId}
            target={client.target}
            basePath={basePath}
            successUrl={order.successUrl}
            initialPhase={initialPhase === 'confirming' ? 'confirming' : (returned ?? 'loading')}
            merchant={{
              name: order.merchant.displayName,
              image: logo ?? null,
              color: readableAccent(safeCssColor(order.merchant.primaryColor ?? undefined) ?? null),
            }}
            buyerEmail={order.buyerEmail}
            description={order.plan.name}
            upiFirst={client.target.kind === 'order' && order.plan.currency.toUpperCase() === 'INR'}
            payLabel={`Pay ${total}`}
            providerName={providerName}
            fallbackLabel={fallbackLabel}
            fallback={fallback}
          />
          <noscript>
            <div className="mt-2 text-sm">
              <RazorpayFallback target={fallback} label={fallbackLabel} />
            </div>
          </noscript>
        </>
      );
    }
    case 'stripe':
      return (
        <>
          <StripePayment
            nonce={nonce}
            client={client}
            appearance={stripeAppearance(order.merchant)}
            payLabel={payButtonLabel(order, total)}
            basePath={basePath}
            successUrl={order.successUrl}
            initialPhase={initialPhase}
            providerName={providerName}
            fallbackLabel={fallbackLabel}
          />
          <noscript>
            <p className="mt-2 text-sm">
              <a className="ck-link inline-flex min-h-[44px] items-center" href={`${basePath}/continue`}>
                {fallbackLabel}
              </a>
            </p>
          </noscript>
        </>
      );
  }
}

/** What is charged now. The plan line appears only beside a discount; without one the headline price already says it. */
function SummaryLines({
  order,
  price,
  every,
  total,
  locale,
}: {
  order: CheckoutPageOrder;
  price: string;
  every: string | null;
  total: string;
  locale: CheckoutLocale;
}): React.JSX.Element {
  const discounted = order.discountAmount > 0;
  return (
    <dl className="mt-6 border-t border-[var(--ck-border)] text-sm tabular-nums">
      {discounted && (
        <>
          <div className="flex justify-between gap-4 pt-3 text-[var(--ck-muted-fg)]">
            <dt>{order.plan.name}</dt>
            <dd className="whitespace-nowrap">
              {price}
              {every ? ` / ${every}` : ''}
            </dd>
          </div>
          <div className="flex justify-between gap-4 pt-2 text-[var(--ck-muted-fg)]">
            <dt>Discount</dt>
            <dd className="whitespace-nowrap">−{formatMoney(order.discountAmount, order.plan.currency, locale)}</dd>
          </div>
        </>
      )}
      <div className="flex justify-between gap-4 py-3 font-semibold">
        <dt>
          Total due today <span className="font-normal text-[var(--ck-muted-fg)]">({order.plan.currency.toUpperCase()})</span>
        </dt>
        <dd className="whitespace-nowrap">{total}</dd>
      </div>
    </dl>
  );
}

function BackChevron(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="mr-1 h-3.5 w-3.5 flex-none" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

function Padlock(): React.JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-px h-3.5 w-3.5 flex-none" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

export function CheckoutView({
  view,
  order,
  nonce,
  basePath,
  locale,
  razorpayReturn = null,
}: {
  view: CheckoutPageView;
  order: CheckoutPageOrder;
  nonce: string;
  basePath: string;
  locale: CheckoutLocale;
  /** What Razorpay Hosted Checkout reported on the way back, from the return route's flag. */
  razorpayReturn?: RazorpayReturn | null;
}): React.JSX.Element {
  const testMode = view.paymentMode === 'test';
  const m = order.merchant;
  const logo = safeHttpUrl(m.logoUrl ?? undefined);
  const every = intervalWord(order.plan.interval);
  const price = formatMoney(order.plan.amount, order.plan.currency, locale);
  const total = formatMoney(order.totalDueToday, order.plan.currency, locale);
  const renewal = renewalSentence(order, locale);
  const fallback = order.priceFallback
    ? priceFallbackSentence(order.priceFallback, formatMoney(order.priceFallback.charged.amount, order.priceFallback.charged.currency, locale))
    : null;
  const disclosures = [fallback && 'price-fallback', (renewal || order.plan.kind === 'one_time') && 'charge-disclosure']
    .filter((id): id is string => typeof id === 'string')
    .join(' ');
  const copy = checkoutProviderCopy(order.client.provider);
  const footerLinks = [
    { href: safeHttpUrl(m.termsUrl ?? undefined), label: 'Terms' },
    { href: safeHttpUrl(m.privacyUrl ?? undefined), label: 'Privacy' },
    { href: safeHttpUrl(m.refundUrl ?? undefined), label: 'Refund policy' },
    { href: safeHttpUrl(m.supportUrl ?? undefined) ?? (m.supportEmail ? `mailto:${m.supportEmail}` : undefined), label: 'Support' },
  ].filter((l): l is { href: string; label: string } => typeof l.href === 'string');

  return (
    <>
      {/* Every value in brandCss passed safeCssColor's allowlist and a contrast check. */}
      {/* eslint-disable-next-line react/no-danger */}
      <style nonce={nonce} dangerouslySetInnerHTML={{ __html: brandCss(order) }} />
      {testMode && <TestBanner hint={copy.testHint} />}
      <div className="mx-auto max-w-4xl px-5 py-5 sm:py-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-2.5">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-7 w-7 flex-none rounded object-contain" />
            )}
            <span className="truncate text-sm font-semibold">{m.displayName}</span>
          </div>
          <a className="ck-quiet-link inline-flex min-h-[44px] flex-none items-center text-sm" href={order.cancelUrl}>
            <BackChevron />
            Back<span className="hidden sm:inline">&nbsp;to {m.displayName}</span>
          </a>
        </header>

        <main className="mt-6 grid gap-8 md:mt-14 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-16">
          <section aria-labelledby="summary-heading">
            <h1 id="summary-heading" className="text-base text-[var(--ck-muted-fg)]">
              {order.plan.kind === 'recurring' ? 'Subscribe to' : 'Buy'} {order.plan.name}
            </h1>
            <p className="mt-1.5 text-4xl font-semibold tracking-tight tabular-nums">
              {every ? price : total}
              {every && <span className="ml-1.5 text-base font-normal tracking-normal text-[var(--ck-muted-fg)]">per {every}</span>}
            </p>
            {fallback && (
              <p
                id="price-fallback"
                role="note"
                className="mt-3 rounded-md border border-[var(--ck-border)] px-3 py-2 text-pretty text-sm leading-relaxed"
              >
                {fallback}
              </p>
            )}
            <SummaryLines order={order} price={price} every={every} total={total} locale={locale} />
          </section>

          <section aria-labelledby="payment-heading" className="rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] p-5 sm:p-7">
            <h2 id="payment-heading" className="sr-only">
              Payment
            </h2>
            <p className="text-sm text-[var(--ck-muted-fg)]">
              Paying as <span className="[overflow-wrap:anywhere] font-medium text-[var(--ck-fg)]">{order.buyerEmail}</span>
            </p>
            {renewal && (
              <p className="mt-3 text-pretty text-sm leading-relaxed text-[var(--ck-muted-fg)]" id="charge-disclosure">
                {renewal} <CancelSentence order={order} />
              </p>
            )}
            {order.plan.kind === 'one_time' && (
              <p className="mt-3 text-sm text-[var(--ck-muted-fg)]" id="charge-disclosure">
                One-time payment. Nothing renews.
              </p>
            )}
            <div role="group" aria-labelledby="payment-heading" className="mt-5" aria-describedby={disclosures || undefined}>
              <PaymentRegion
                order={order}
                nonce={nonce}
                basePath={basePath}
                fallbackLabel={`Continue on ${copy.name}`}
                providerName={copy.name}
                initialPhase={view.status === 'confirming' ? 'confirming' : 'loading'}
                razorpayReturn={razorpayReturn}
                total={total}
              />
            </div>
            <p className="mt-5 flex gap-2 text-xs leading-relaxed text-[var(--ck-muted-fg)]">
              <Padlock />
              <span>
                Payments are processed securely by {copy.name}. {m.displayName} never sees your full card number.
              </span>
            </p>
          </section>
        </main>

        {footerLinks.length > 0 && (
          <footer className="mt-8 text-sm md:mt-16">
            <nav aria-label={`${m.displayName} policies and support`}>
            <ul className="flex flex-wrap gap-x-6">
              {footerLinks.map((l) => (
                <li key={l.label}>
                  <a className="ck-quiet-link inline-flex min-h-[44px] min-w-[44px] items-center" href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
            </nav>
          </footer>
        )}
      </div>
    </>
  );
}
