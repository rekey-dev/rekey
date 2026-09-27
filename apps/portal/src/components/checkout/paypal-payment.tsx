'use client';

/**
 * The payment region: PayPal's own subscription Buttons, unmodified.
 *
 * The subscription already exists at PayPal, created by the API with this
 * checkout's plan and `custom_id`; `createSubscription` only hands its id back,
 * so nothing on this page can change the plan, the price or the buyer. Card
 * entry happens in PayPal's own popup ("Debit or Credit Card"). No card data
 * passes through this code.
 *
 * When PayPal says yes in the browser the page asks the portal to verify it
 * with PayPal, then polls until the webhook has activated the subscription.
 * The browser's word never activates anything.
 */

import * as React from 'react';
import { afterApproval, afterPolling, UNCONFIRMED_MESSAGE } from '@/lib/approval-outcome';

type Phase =
  | 'loading'
  | 'ready'
  | 'processing'
  | 'cancelled'
  | 'failed'
  | 'unconfirmed'
  | 'script_failed'
  | 'confirming'
  | 'redirecting';

interface PaypalButtonsActions {
  render(container: HTMLElement): Promise<void>;
  isEligible(): boolean;
}

interface PaypalNamespace {
  Buttons(options: {
    style: { layout: 'vertical'; label: 'subscribe'; shape: 'rect'; color: 'gold' };
    createSubscription: () => Promise<string>;
    onApprove: (data: { subscriptionID?: string | null }) => Promise<void>;
    onCancel: () => void;
    onError: () => void;
  }): PaypalButtonsActions;
}

declare global {
  interface Window {
    paypal?: PaypalNamespace;
  }
}

const LOAD_TIMEOUT_MS = 10_000;
const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 20_000;

const MESSAGES: Partial<Record<Phase, string>> = {
  processing: 'Processing…',
  cancelled: 'Payment not completed. You have not been charged.',
  failed: 'PayPal could not complete this payment. You have not been charged. Try again, or continue on PayPal.',
  script_failed: 'The secure payment form did not load.',
  unconfirmed: UNCONFIRMED_MESSAGE,
  confirming: 'Payment approved. Confirming your payment…',
  redirecting: 'Payment confirmed. Taking you back…',
};

export function PaypalPayment({
  nonce,
  clientId,
  subscriptionId,
  basePath,
  successUrl,
  initialPhase,
}: {
  nonce: string;
  clientId: string;
  subscriptionId: string;
  /** `/<slug>/checkout/<token>` on this portal. */
  basePath: string;
  successUrl: string;
  initialPhase: 'loading' | 'confirming';
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>(initialPhase);
  const container = React.useRef<HTMLDivElement>(null);
  const rendered = React.useRef(false);

  const finish = React.useCallback(() => {
    setPhase('redirecting');
    window.location.assign(successUrl);
  }, [successUrl]);

  const poll = React.useCallback(async () => {
    setPhase('confirming');
    const deadline = Date.now() + POLL_FOR_MS;
    let last: string | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
      const res = await fetch(`${basePath}/status`, { cache: 'no-store' }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { status?: string } | null;
      last = body?.status;
      if (last === 'complete') return finish();
    }
    // PayPal approved, so this page never reloads into an "expired" notice.
    setPhase(afterPolling(last) === 'finish' ? 'redirecting' : 'unconfirmed');
    if (afterPolling(last) === 'finish') finish();
  }, [basePath, finish]);

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
      const buttons = paypal.Buttons({
        style: { layout: 'vertical', label: 'subscribe', shape: 'rect', color: 'gold' },
        createSubscription: async () => subscriptionId,
        onApprove: async (data) => {
          setPhase('processing');
          const res = await fetch(`${basePath}/approved`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ subscriptionId: data.subscriptionID ?? '' }),
          }).catch(() => null);
          const body = res && !res.ok ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
          const next = afterApproval(res === null ? null : { ok: res.ok, errorCode: body?.error ?? null });
          // PayPal has approved: never send the buyer back to the buttons.
          if (next === 'unconfirmed') return setPhase('unconfirmed');
          await poll();
        },
        onCancel: () => setPhase('cancelled'),
        onError: () => setPhase('failed'),
      });
      if (!buttons.isEligible()) return setPhase('script_failed');
      await buttons.render(container.current);
      rendered.current = true;
      setPhase('ready');
    };

    const script = document.createElement('script');
    const params = new URLSearchParams({
      'client-id': clientId,
      vault: 'true',
      intent: 'subscription',
      components: 'buttons',
    });
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
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
  }, [clientId, subscriptionId, basePath, nonce, initialPhase, poll]);

  const message = MESSAGES[phase];
  const showFallback = phase === 'script_failed' || phase === 'failed';
  const busy = phase === 'loading' || phase === 'processing' || phase === 'confirming' || phase === 'redirecting';

  return (
    <div aria-busy={busy}>
      <div
        ref={container}
        id="paypal-buttons"
        className={phase === 'loading' ? 'min-h-[150px] animate-pulse rounded-lg bg-[var(--ck-muted)]' : 'min-h-[150px]'}
        hidden={phase === 'confirming' || phase === 'redirecting' || phase === 'script_failed' || phase === 'unconfirmed'}
      />
      <p id="payment-status" role="status" aria-live="polite" className="mt-3 min-h-[1.25rem] text-sm text-[var(--ck-fg)]">
        {message ?? ''}
      </p>
      {showFallback && (
        <p className="mt-2 text-sm">
          <a className="ck-link inline-flex min-h-[44px] items-center" href={`${basePath}/continue`}>
            Continue on PayPal
          </a>
        </p>
      )}
    </div>
  );
}
