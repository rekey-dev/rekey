'use client';

/**
 * The dashboard after a checkout returns. The provider's webhook activates the
 * subscription a moment later, so the page re-reads itself until it has, then
 * drops `?checkout=success` from the address so a reload does not say it again.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from './banner';

export const REFRESH_EVERY_MS = 3_000;
export const REFRESH_FOR_MS = 60_000;

type Phase = 'waiting' | 'active' | 'slow';

const COPY: Record<Phase, string> = {
  waiting: 'Checkout complete. Your subscription will activate shortly.',
  active: 'Checkout complete. Your subscription is active.',
  slow: 'Checkout complete. Activation is taking longer than usual; reload this page in a few minutes to see it.',
};

/** The current address without the checkout flag, leaving any other parameter. */
function withoutCheckoutFlag(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('checkout');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function CheckoutActivation({ activated }: { activated: boolean }): React.JSX.Element {
  const router = useRouter();
  const startedAt = React.useRef(Date.now());
  const [slow, setSlow] = React.useState(false);
  const settled = activated || slow;

  React.useEffect(() => {
    if (settled) {
      window.history.replaceState(window.history.state, '', withoutCheckoutFlag(window.location.href));
      return;
    }
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt.current >= REFRESH_FOR_MS) {
        setSlow(true);
        return;
      }
      router.refresh();
    }, REFRESH_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [settled, router]);

  const phase: Phase = activated ? 'active' : slow ? 'slow' : 'waiting';
  return <Banner tone={phase === 'active' ? 'success' : 'info'}>{COPY[phase]}</Banner>;
}
