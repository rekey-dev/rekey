'use client';

/**
 * The payment region for Razorpay: our own "Pay" button opening Razorpay
 * Standard Checkout, Razorpay's modal in Razorpay's iframe. Never Custom
 * Checkout, which would put card fields in this page's DOM.
 *
 * The subscription or order already exists at Razorpay, created by the API
 * with this checkout's plan and amount; the modal only gets its id, so nothing
 * here can change what is charged. When Razorpay says paid, the page asks the
 * portal to verify Razorpay's signature, then polls until the webhook has
 * completed the purchase. The browser's word never activates anything.
 */

import * as React from 'react';
import { afterApproval, unconfirmedMessage } from '@/lib/approval-outcome';
import { readStatus, usePollUntilComplete, type PollPhase } from '@/lib/use-poll-until-complete';
import { RazorpayFallback, type RazorpayFallbackTarget } from './razorpay-fallback';

type Phase = 'idle' | 'open' | 'processing' | 'cancelled' | 'failed' | 'script_failed' | PollPhase;

export type RazorpayTarget = { kind: 'subscription'; subscriptionId: string } | { kind: 'order'; orderId: string };

interface RazorpayHandlerResponse {
  razorpay_payment_id?: string;
  razorpay_signature?: string;
  razorpay_subscription_id?: string;
  razorpay_order_id?: string;
}

interface RazorpayOptions {
  key: string;
  subscription_id?: string;
  order_id?: string;
  name: string;
  description: string;
  image?: string;
  prefill: { email: string };
  theme: { color: string };
  config?: {
    display: {
      blocks: Record<string, { name: string; instruments: Array<{ method: string }> }>;
      sequence: string[];
      preferences: { show_default_blocks: boolean };
    };
  };
  handler: (response: RazorpayHandlerResponse) => void;
  modal: { ondismiss: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open(): void };
  }
}

export const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
const LOAD_TIMEOUT_MS = 10_000;

/** UPI first, then Razorpay's own default blocks. Razorpay applies `config.display` to one-time payments only. */
const UPI_FIRST: NonNullable<RazorpayOptions['config']> = {
  display: {
    blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } },
    sequence: ['block.upi'],
    preferences: { show_default_blocks: true },
  },
};

const MESSAGES: Partial<Record<Phase, string>> = {
  processing: 'Processing…',
  // A UPI collect request can still be approved in the buyer's app after the
  // modal closes, so this never says nothing was charged.
  cancelled: 'Payment not completed. If you approved it in your UPI app, wait a moment before trying again.',
  failed: 'The payment failed. You have not been charged. You can try again.',
  script_failed: 'The secure payment form did not load.',
  confirming: 'Payment received. Confirming your payment…',
  handing_off: 'Payment received and being processed. Taking you back…',
  redirecting: 'Payment confirmed. Taking you back…',
};

const BUTTON_PHASES = new Set<Phase>(['idle', 'open', 'processing', 'cancelled', 'failed']);

function firstPhase(initial: 'loading' | 'confirming' | 'claimed' | 'unconfirmed' | 'failed'): Phase {
  if (initial === 'loading') return 'idle';
  if (initial === 'claimed') return 'confirming';
  return initial;
}

export function RazorpayPayment({
  nonce,
  keyId,
  target,
  basePath,
  successUrl,
  initialPhase,
  merchant,
  buyerEmail,
  description,
  upiFirst,
  payLabel,
  providerName,
  fallbackLabel,
  fallback,
}: {
  nonce: string;
  keyId: string;
  target: RazorpayTarget;
  /** `/<slug>/checkout/<token>` on this portal. */
  basePath: string;
  successUrl: string;
  /**
   * `confirming`: the session is already confirming. The rest come from
   * Razorpay Hosted Checkout's return: `claimed`, Razorpay said paid but the
   * API did not confirm it yet; `unconfirmed`, the API refused it; `failed`,
   * the payment failed.
   */
  initialPhase: 'loading' | 'confirming' | 'claimed' | 'unconfirmed' | 'failed';
  /** Already filtered: a safe https logo URL and a contrast-checked colour. */
  merchant: { name: string; image: string | null; color: string };
  buyerEmail: string;
  description: string;
  upiFirst: boolean;
  payLabel: string;
  /** From the shared provider copy, for the unconfirmed message. */
  providerName: string;
  /** The provider-keyed "Continue on …" label, from the page's copy lookup. */
  fallbackLabel: string;
  fallback: RazorpayFallbackTarget;
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>(firstPhase(initialPhase));
  const [loaded, setLoaded] = React.useState(false);
  const poll = usePollUntilComplete(basePath, successUrl, setPhase);

  React.useEffect(() => {
    if (initialPhase === 'unconfirmed') return;
    if (initialPhase === 'confirming' || initialPhase === 'claimed') {
      void poll({ fromClaim: initialPhase === 'claimed' });
      return;
    }
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) setPhase('script_failed');
    }, LOAD_TIMEOUT_MS);
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT;
    script.nonce = nonce;
    script.async = true;
    script.onload = () => {
      done = true;
      if (window.Razorpay) setLoaded(true);
      else setPhase('script_failed');
    };
    script.onerror = () => {
      done = true;
      setPhase('script_failed');
    };
    document.head.appendChild(script);
    return () => window.clearTimeout(timer);
  }, [nonce, initialPhase, poll]);

  const onApproved = React.useCallback(
    async (response: RazorpayHandlerResponse) => {
      setPhase('processing');
      const id =
        target.kind === 'order'
          ? { orderId: response.razorpay_order_id ?? '' }
          : { subscriptionId: response.razorpay_subscription_id ?? '' };
      const res = await fetch(`${basePath}/razorpay/approved`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: response.razorpay_payment_id ?? '', signature: response.razorpay_signature ?? '', ...id }),
      }).catch(() => null);
      const body = res && !res.ok ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
      // Razorpay has taken the payment: never send the buyer back to the button.
      if (afterApproval(res === null ? null : { ok: res.ok, errorCode: body?.error ?? null }) === 'unconfirmed') {
        return setPhase('unconfirmed');
      }
      await poll();
    },
    [basePath, poll, target.kind],
  );

  const onDismiss = React.useCallback(async () => {
    setPhase((p) => (p === 'open' ? 'cancelled' : p));
    // The payment may have gone through (a UPI approval racing the close).
    const status = await readStatus(basePath);
    if (status === 'confirming' || status === 'complete') await poll();
  }, [basePath, poll]);

  const pay = (): void => {
    const Razorpay = window.Razorpay;
    if (!Razorpay) return setPhase('script_failed');
    try {
      new Razorpay({
        key: keyId,
        ...(target.kind === 'order' ? { order_id: target.orderId } : { subscription_id: target.subscriptionId }),
        name: merchant.name,
        description,
        ...(merchant.image !== null && { image: merchant.image }),
        prefill: { email: buyerEmail },
        theme: { color: merchant.color },
        ...(upiFirst && { config: UPI_FIRST }),
        handler: (response) => void onApproved(response),
        modal: { ondismiss: () => void onDismiss() },
      }).open();
      setPhase('open');
    } catch {
      setPhase('script_failed');
    }
  };

  const message = phase === 'unconfirmed' ? unconfirmedMessage(providerName) : MESSAGES[phase];
  const busy = (!loaded && BUTTON_PHASES.has(phase)) || phase === 'processing' || phase === 'confirming' || phase === 'handing_off' || phase === 'redirecting';

  return (
    <div aria-busy={busy}>
      {BUTTON_PHASES.has(phase) &&
        (loaded ? (
          <button type="button" className="ck-button" onClick={pay} disabled={phase === 'open' || phase === 'processing'}>
            {payLabel}
          </button>
        ) : (
          <div className="ck-button-skeleton animate-pulse" aria-hidden="true" />
        ))}
      <p id="payment-status" role="status" aria-live="polite" className="mt-3 min-h-[1.25rem] text-sm text-[var(--ck-fg)]">
        {message ?? ''}
      </p>
      {phase === 'script_failed' && (
        <div className="mt-2 text-sm">
          <RazorpayFallback target={fallback} label={fallbackLabel} />
        </div>
      )}
    </div>
  );
}
