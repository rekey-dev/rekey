/**
 * The checkout page, rendered on the server from the API's view of one
 * session. Everything the buyer reads before paying is here and needs no
 * JavaScript; only the payment region waits on PayPal's script.
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
import { PaypalPayment } from './paypal-payment';

function brandCss(order: CheckoutPageOrder | null): string {
  const accent = readableAccent(safeCssColor(order?.merchant.primaryColor ?? undefined) ?? null);
  const bg = readableSurface(safeCssColor(order?.merchant.backgroundColor ?? undefined) ?? null);
  const surface = readableSurface(safeCssColor(order?.merchant.surfaceColor ?? undefined) ?? null);
  return `:root{--ck-accent:${accent};${bg ? `--ck-bg:${bg};` : ''}${surface ? `--ck-surface:${surface};` : ''}}`;
}

function TestBanner(): React.JSX.Element {
  return (
    <div role="note" className="bg-[#fef3c7] px-4 py-2 text-center text-sm font-medium text-[#78350f]">
      Test mode: no real money moves. Pay with a PayPal sandbox account.
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
}: {
  view: CheckoutPageView;
  order: CheckoutPageOrder;
  nonce: string;
  basePath: string;
  locale: CheckoutLocale;
}): React.JSX.Element {
  const testMode = view.paymentMode === 'test';
  const m = order.merchant;
  const logo = safeHttpUrl(m.logoUrl ?? undefined);
  const every = intervalWord(order.plan.interval);
  const price = formatMoney(order.plan.amount, order.plan.currency, locale);
  const total = formatMoney(order.totalDueToday, order.plan.currency, locale);
  const renewal = renewalSentence(order, locale);
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
      {testMode && <TestBanner />}
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
              Subscribe to {order.plan.name}
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
              <PaypalPayment
                nonce={nonce}
                clientId={order.client.clientId}
                subscriptionId={order.client.subscriptionId}
                basePath={basePath}
                successUrl={order.successUrl}
                initialPhase={view.status === 'confirming' ? 'confirming' : 'loading'}
              />
              <noscript>
                <p className="mt-2 text-sm">
                  <a className="ck-link" href={`${basePath}/continue`}>
                    Continue on PayPal
                  </a>
                </p>
              </noscript>
            </div>
          </section>
        </main>

        <footer className="mt-12 border-t border-[var(--ck-border)] pt-4 text-xs text-[var(--ck-muted-fg)]">
          <p>Payments are processed securely by PayPal. {m.displayName} never sees your full card number.</p>
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
