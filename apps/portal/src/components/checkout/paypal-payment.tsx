'use client';

/**
 * The payment region: PayPal's own Buttons, unmodified, for a subscription or
 * a one-time order.
 *
 * The subscription or order already exists at PayPal, created by the API with
 * this checkout's price and `custom_id` (see `paypalButtonsPlan`), so nothing
 * on this page can change the price or the buyer. Card entry happens in
 * PayPal's own popup ("Debit or Credit Card"). No card data passes through
 * this code.
 *
 * When PayPal says yes in the browser the page asks the portal to verify it
 * with PayPal, then polls until the webhook has completed the purchase.
 * The browser's word never activates or captures anything.
 */

import * as React from 'react';
import type { PaypalCheckoutPageClient } from '@rekey.dev/shared-types';
import { afterApproval, unconfirmedMessage } from '@/lib/approval-outcome';
import { checkoutProviderCopy } from '@/lib/checkout-provider-copy';
import { usePollUntilComplete } from '@/lib/use-poll-until-complete';
import { paypalButtonsOptions, paypalSdkUrl, type PaypalButtonsOptions } from '@/lib/paypal-buttons';

type Phase =
  | 'loading'
  | 'ready'
  | 'processing'
  | 'cancelled'
  | 'failed'
  | 'unconfirmed'
  | 'script_failed'
  | 'confirming'
  | 'handing_off'
  | 'redirecting';

interface PaypalButtonsActions {
  render(container: HTMLElement): Promise<void>;
  isEligible(): boolean;
}

interface PaypalNamespace {
  Buttons(options: PaypalButtonsOptions): PaypalButtonsActions;
}

declare global {
  interface Window {
    paypal?: PaypalNamespace;
  }
}

const LOAD_TIMEOUT_MS = 10_000;

export const PAYMENT_MESSAGES: Partial<Record<Phase, string>> = {
  processing: 'Processing…',
  cancelled: 'Payment not completed. You have not been charged.',
  failed: 'PayPal could not complete this payment. You have not been charged. Try again, or continue on PayPal.',
  script_failed: 'The secure payment form did not load.',
  unconfirmed: unconfirmedMessage(checkoutProviderCopy('paypal').name),
  confirming: 'Payment approved. Confirming your payment…',
  // The webhook is late: PayPal approved, Rekey has not confirmed yet.
  handing_off: 'Payment approved and being processed. Taking you back…',
  redirecting: 'Payment confirmed. Taking you back…',
};

export function PaypalPayment({
  nonce,
  client,
  basePath,
  successUrl,
  initialPhase,
  fallbackLabel,
}: {
  nonce: string;
  client: PaypalCheckoutPageClient;
  /** The provider-keyed "Continue on …" label, from the page's copy lookup. */
  fallbackLabel: string;
  /** `/<slug>/checkout/<token>` on this portal. */
  basePath: string;
  successUrl: string;
  initialPhase: 'loading' | 'confirming';
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>(initialPhase);
  const resourceId = client.sdk === 'v5-order' ? client.orderId : client.subscriptionId;
  const currency = client.sdk === 'v5-order' ? client.currency : null;
  const container = React.useRef<HTMLDivElement>(null);
  const rendered = React.useRef(false);

  const poll = usePollUntilComplete(basePath, successUrl, setPhase);

  React.useEffect(() => {
    if (initialPhase === 'confirming') {
      void poll();
      return;
    }
    const timer = window.setTimeout(() => {
      if (!rendered.current) setPhase('script_failed');
    }, LOAD_TIMEOUT_MS);

    const mount = async (): Promise<void> => {
      const paypal = window.paypal;
      if (!paypal || !container.current) return setPhase('script_failed');
      const buttons = paypal.Buttons(
        paypalButtonsOptions(client, {
          onApprove: async (approval) => {
            setPhase('processing');
            const res = await fetch(`${basePath}/approved`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(approval),
            }).catch(() => null);
            const body = res && !res.ok ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
            const next = afterApproval(res === null ? null : { ok: res.ok, errorCode: body?.error ?? null });
            // PayPal has approved: never send the buyer back to the buttons.
            if (next === 'unconfirmed') return setPhase('unconfirmed');
            await poll();
          },
          onCancel: () => setPhase('cancelled'),
          onError: () => setPhase('failed'),
        }),
      );
      if (!buttons.isEligible()) return setPhase('script_failed');
      await buttons.render(container.current);
      rendered.current = true;
      setPhase('ready');
    };

    const script = document.createElement('script');
    script.src = paypalSdkUrl(client);
    script.nonce = nonce;
    // PayPal puts this nonce on the style tags it injects, so a strict
    // style-src does not break its buttons.
    script.setAttribute('data-csp-nonce', nonce);
    script.async = true;
    script.onload = () => {
      mount().catch(() => setPhase('script_failed'));
    };
    script.onerror = () => setPhase('script_failed');
    document.head.appendChild(script);
    return () => window.clearTimeout(timer);
    // Keyed on the values, not the object: a re-render with an equal client
    // must not load PayPal's script a second time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.sdk, client.clientId, resourceId, currency, basePath, nonce, initialPhase, poll]);

  const message = PAYMENT_MESSAGES[phase];
  const showFallback = phase === 'script_failed' || phase === 'failed';
  const busy =
    phase === 'loading' || phase === 'processing' || phase === 'confirming' || phase === 'handing_off' || phase === 'redirecting';

  return (
    <div aria-busy={busy}>
      <div
        ref={container}
        id="paypal-buttons"
        className={phase === 'loading' ? 'min-h-[150px] animate-pulse rounded-lg bg-[var(--ck-muted)]' : 'min-h-[150px]'}
        hidden={
          phase === 'confirming' || phase === 'handing_off' || phase === 'redirecting' || phase === 'script_failed' || phase === 'unconfirmed'
        }
      />
      <p id="payment-status" role="status" aria-live="polite" className="mt-3 min-h-[1.25rem] text-sm text-[var(--ck-fg)]">
        {message ?? ''}
      </p>
      {showFallback && (
        <p className="mt-2 text-sm">
          <a className="ck-link inline-flex min-h-[44px] items-center" href={`${basePath}/continue`}>
            {fallbackLabel}
          </a>
        </p>
      )}
    </div>
  );
}
