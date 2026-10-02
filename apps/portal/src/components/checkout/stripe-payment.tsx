'use client';

/**
 * The payment region for Stripe: the Payment Element, unmodified, inside
 * Stripe's own frames, and our Pay button below it.
 *
 * The Checkout Session already exists at Stripe, created by the API with this
 * checkout's price, discount, trial and buyer; the client secret only opens
 * it, so nothing on this page can change what is charged. Card numbers and
 * wallets (Apple Pay, Google Pay, Link) stay inside Stripe's iframes.
 *
 * The Pay button shows Stripe's own session total and is enabled only when
 * Stripe says the session can be confirmed: Stripe refuses `confirm()` on a
 * page that has not read the total. When `confirm()` succeeds the page asks
 * the portal to check the session with Stripe, then polls until the webhook
 * has completed the purchase. A payment method that redirects (3-D Secure,
 * bank redirects) comes back to this page with the session id, and the
 * page's server does the same check before rendering. The browser's word
 * never activates anything.
 */

import * as React from 'react';
import type { CheckoutPageClient } from '@rekey.dev/shared-types';
import { afterApproval, unconfirmedMessage } from '@/lib/approval-outcome';
import { usePollUntilComplete } from '@/lib/use-poll-until-complete';
import {
  sessionPayLabel,
  STRIPE_CONFIRMED_PATH,
  STRIPE_JS_URL,
  type StripeAppearance,
  type StripeCheckoutSessionView,
  type StripeConfirmResult,
} from '@/lib/stripe-elements';

type Phase =
  | 'loading'
  | 'ready'
  | 'processing'
  | 'failed'
  | 'unconfirmed'
  | 'script_failed'
  | 'moved'
  | 'confirming'
  | 'redirecting'
  | 'handing_off';

type StripeClient = Extract<CheckoutPageClient, { provider: 'stripe' }>;

const LOAD_TIMEOUT_MS = 10_000;

function messageFor(phase: Phase, providerName: string): string | undefined {
  switch (phase) {
    case 'processing':
      return 'Processing…';
    case 'script_failed':
      return 'The secure payment form did not load.';
    case 'moved':
      return `This payment continues on ${providerName}'s own page.`;
    case 'unconfirmed':
      return unconfirmedMessage(providerName);
    case 'confirming':
      return 'Payment received. Confirming your payment…';
    case 'redirecting':
      return 'Payment confirmed. Taking you back…';
    case 'handing_off':
      return 'Payment received. Taking you back; your purchase completes shortly.';
    default:
      return undefined;
  }
}

/** Load Stripe.js once per page, even when React mounts this twice. */
function loadStripeJs(nonce: string, onLoad: () => void, onError: () => void): void {
  if (window.Stripe) return onLoad();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_URL}"]`);
  const script = existing ?? document.createElement('script');
  script.addEventListener('load', onLoad);
  script.addEventListener('error', onError);
  if (existing) return;
  script.src = STRIPE_JS_URL;
  script.nonce = nonce;
  script.async = true;
  document.head.appendChild(script);
}

export function StripePayment({
  nonce,
  client,
  appearance,
  payLabel,
  basePath,
  successUrl,
  initialPhase,
  providerName,
  fallbackLabel,
}: {
  nonce: string;
  client: StripeClient;
  /** The Payment Element's theme, built on the server from the Application's colours. */
  appearance: StripeAppearance;
  /** Shown until Stripe's own session total has loaded. */
  payLabel: string;
  /** `/<slug>/checkout/<token>` on this portal. */
  basePath: string;
  successUrl: string;
  initialPhase: 'loading' | 'confirming';
  /** The processor's name, from the page's provider copy. */
  providerName: string;
  /** "Continue on Stripe", from the page's provider copy. */
  fallbackLabel: string;
}): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>(initialPhase);
  const [error, setError] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState(payLabel);
  const [canConfirm, setCanConfirm] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);
  const confirm = React.useRef<(() => Promise<StripeConfirmResult>) | null>(null);
  // Held in a ref: a new but equal object on a re-render must not remount the Payment Element.
  const theme = React.useRef(appearance);
  const poll = usePollUntilComplete(basePath, successUrl, setPhase);

  React.useEffect(() => {
    if (initialPhase === 'confirming') {
      void poll();
      return;
    }
    // Per effect run, so a StrictMode re-run never mounts twice from the
    // first run's script listener.
    let active = true;
    let elementReady = false;
    let actionsReady = false;
    let element: { destroy(): void } | null = null;
    const becomeReady = (): void => {
      if (elementReady && actionsReady && active) setPhase((p) => (p === 'loading' ? 'ready' : p));
    };
    const applySession = (session: StripeCheckoutSessionView): void => {
      if (!active) return;
      setLabel(sessionPayLabel(session));
      setCanConfirm(session.canConfirm);
    };
    const fail = (next: Phase) => () => {
      if (active) setPhase(next);
    };
    const timer = window.setTimeout(() => {
      if (!(elementReady && actionsReady)) fail('script_failed')();
    }, LOAD_TIMEOUT_MS);

    const mount = async (): Promise<void> => {
      const target = container.current;
      if (!active) return;
      if (!window.Stripe || !target) return fail('script_failed')();
      const checkout = window.Stripe(client.publishableKey).initCheckoutElementsSdk({
        clientSecret: client.clientSecret,
        elementsOptions: { appearance: theme.current, loader: 'never' },
      });
      const payment = checkout.createPaymentElement({ layout: 'tabs' });
      element = payment;
      payment.on('loaderror', fail('script_failed'));
      payment.on('ready', () => {
        elementReady = true;
        becomeReady();
      });
      payment.mount(target);
      checkout.on('change', applySession);
      const loaded = await checkout.loadActions();
      // An expired or replaced session cannot be paid here: the buyer used
      // "Continue on Stripe" (or the link ran out), and that link reaches it.
      if (loaded.type === 'error') return fail('moved')();
      const { actions } = loaded;
      applySession(actions.getSession());
      confirm.current = () => actions.confirm({ redirect: 'if_required' });
      actionsReady = true;
      becomeReady();
    };

    loadStripeJs(
      nonce,
      () => {
        mount().catch(fail('script_failed'));
      },
      fail('script_failed'),
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
      element?.destroy();
    };
  }, [client.publishableKey, client.clientSecret, nonce, initialPhase, poll]);

  const pay = async (): Promise<void> => {
    if (!confirm.current || phase === 'processing') return;
    setError(null);
    setPhase('processing');
    let result: StripeConfirmResult;
    try {
      result = await confirm.current();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : `${providerName} could not complete this payment. Try again, or use the link below.`);
      return setPhase('failed');
    }
    if (result.type === 'error') {
      setError(result.error.message);
      return setPhase('failed');
    }
    const res = await fetch(`${basePath}/${STRIPE_CONFIRMED_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: result.session.id }),
    }).catch(() => null);
    const body = res && !res.ok ? ((await res.json().catch(() => null)) as { error?: string } | null) : null;
    // Stripe has taken the payment: never show the form again.
    if (afterApproval(res === null ? null : { ok: res.ok, errorCode: body?.error ?? null }) === 'unconfirmed') {
      return setPhase('unconfirmed');
    }
    await poll();
  };

  const settled = phase === 'confirming' || phase === 'redirecting' || phase === 'handing_off' || phase === 'unconfirmed';
  const showForm = !settled && phase !== 'script_failed' && phase !== 'moved';
  const busy = phase === 'loading' || phase === 'processing' || phase === 'confirming' || phase === 'redirecting' || phase === 'handing_off';
  const message = phase === 'failed' ? error : messageFor(phase, providerName);
  const payable = (phase === 'ready' || phase === 'failed') && canConfirm;

  return (
    <div aria-busy={busy}>
      {showForm && (
        <div className="relative min-h-[220px]">
          {phase === 'loading' && (
            <div data-testid="stripe-skeleton" aria-hidden="true" className="absolute inset-0 animate-pulse rounded-lg bg-[var(--ck-muted)]" />
          )}
          <div ref={container} id="stripe-payment-element" className={phase === 'loading' ? 'opacity-0' : undefined} />
        </div>
      )}
      {showForm && (
        <button
          type="button"
          onClick={() => void pay()}
          disabled={!payable}
          className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[var(--ck-accent)] px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {phase === 'processing' ? 'Processing…' : label}
        </button>
      )}
      <p
        id="payment-status"
        role={phase === 'failed' ? 'alert' : 'status'}
        aria-live="polite"
        className={`mt-3 min-h-[1.25rem] text-sm ${phase === 'failed' ? 'text-[#b91c1c]' : 'text-[var(--ck-fg)]'}`}
      >
        {message ?? ''}
      </p>
      {(phase === 'script_failed' || phase === 'failed' || phase === 'moved') && (
        <p className="mt-2 text-sm">
          <a className="ck-link inline-flex min-h-[44px] items-center" href={`${basePath}/continue`}>
            {phase === 'moved' ? `${fallbackLabel}'s page` : fallbackLabel}
          </a>
        </p>
      )}
    </div>
  );
}
