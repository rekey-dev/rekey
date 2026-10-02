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
  const accent = readableAccent(safeCssColor(order?.merchant.primaryColor ?? undefined) ?? null);
  const bg = readableSurface(safeCssColor(order?.merchant.backgroundColor ?? undefined) ?? null);
  const surface = readableSurface(safeCssColor(order?.merchant.surfaceColor ?? undefined) ?? null);
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
      <main className="mx-auto max-w-md px-4 pt-20 pb-10">
        <div className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] p-6 text-center">
          <h1 className="text-lg font-semibold">{title}</h1>
          <p className="mt-3 text-sm text-[var(--ck-muted-fg)]">{body}</p>
          {returnUrl && (
            <p className="mt-5">
              <a className="ck-link inline-flex min-h-[44px] items-center text-sm font-medium" href={returnUrl}>
                {returnLabel}
              </a>
            </p>
          )}
        </div>
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
  if (support || email) {
    return (
      <>
        You can cancel any time by contacting{' '}
        <a className="ck-link" href={support ?? `mailto:${email}`}>
          {order.merchant.displayName}
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
              <a className="ck-link" href={`${basePath}/continue`}>
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
              <a className="ck-link" href={`${basePath}/continue`}>
                {fallbackLabel}
              </a>
            </p>
          </noscript>
        </>
      );
  }
}

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
  return (
    <dl className="divide-y divide-[var(--ck-border)] px-4 text-sm">
      <div className="flex justify-between gap-4 py-3">
        <dt>{order.plan.name}</dt>
        <dd>
          {price}
          {every ? ` / ${every}` : ''}
        </dd>
      </div>
      {order.discountAmount > 0 && (
        <div className="flex justify-between gap-4 py-3">
          <dt>Discount</dt>
          <dd>−{formatMoney(order.discountAmount, order.plan.currency, locale)}</dd>
        </div>
      )}
      <div className="flex justify-between gap-4 py-3 font-semibold">
        <dt>Total due today</dt>
        <dd>{total}</dd>
      </div>
    </dl>
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
      <div className="mx-auto max-w-5xl px-4 py-6 sm:py-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" className="h-8 w-8 flex-none rounded object-contain" />
            )}
            <span className="truncate text-base font-semibold">{m.displayName}</span>
          </div>
          <a className="ck-link inline-flex min-h-[44px] flex-none items-center text-sm" href={order.cancelUrl}>
            <span aria-hidden="true">←&nbsp;</span>Back to {m.displayName}
          </a>
        </header>

        <main className="mt-6 grid gap-8 md:mt-10 md:grid-cols-2 md:gap-12">
          <section aria-labelledby="summary-heading">
            <h1 id="summary-heading" className="text-sm font-medium text-[var(--ck-muted-fg)]">
              {order.plan.kind === 'recurring' ? 'Subscribe to' : 'Buy'} {order.plan.name}
            </h1>
            <p className="mt-2 text-3xl font-semibold tracking-tight">
              {price}
              {every && <span className="ml-1 text-base font-normal text-[var(--ck-muted-fg)]">per {every}</span>}
            </p>
            <details className="mt-6 rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] md:hidden">
              <summary className="flex min-h-[44px] cursor-pointer items-center justify-between px-4 text-sm font-medium">
                <span>Total due today</span>
                <span>{total}</span>
              </summary>
              <SummaryLines order={order} price={price} every={every} total={total} locale={locale} />
            </details>
            <div className="mt-6 hidden rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] md:block">
              <SummaryLines order={order} price={price} every={every} total={total} locale={locale} />
            </div>
          </section>

          <section aria-labelledby="payment-heading" className="rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface)] p-5 sm:p-6">
            <p className="text-sm text-[var(--ck-muted-fg)]">
              Paying as <span className="font-medium text-[var(--ck-fg)]">{order.buyerEmail}</span>
            </p>
            <h2 id="payment-heading" className="mt-5 text-base font-semibold">
              Payment
            </h2>
            {renewal && (
              <p className="mt-3 text-sm text-[var(--ck-muted-fg)]" id="renewal-disclosure">
                {renewal} <CancelSentence order={order} />
              </p>
            )}
            <div className="mt-4" aria-describedby={renewal ? 'renewal-disclosure' : undefined}>
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
          </section>
        </main>

        <footer className="mt-12 border-t border-[var(--ck-border)] pt-4 text-xs text-[var(--ck-muted-fg)]">
          <p>
            Payments are processed securely by {copy.name}. {m.displayName} never sees your full card number.
          </p>
          {footerLinks.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4">
              {footerLinks.map((l) => (
                <li key={l.label}>
                  <a className="ck-link inline-flex min-h-[44px] items-center" href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </footer>
      </div>
    </>
  );
}
