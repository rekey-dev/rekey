'use client';

/**
 * After the provider has said yes: poll the session until its webhook has
 * completed it, then send the buyer to `successUrl`. Shared by every
 * provider's payment region.
 *
 * The provider has approved, so the page never falls back to a pay button.
 * A late webhook still sends the buyer on (the app shows "activates
 * shortly"); only a session the API calls expired stays on the page.
 *
 * `fromClaim` is for a poll started from an unverified claim (a query flag)
 * rather than a confirmation the API accepted: a session still open at the
 * end was never confirmed, so the buyer stays on the page with the
 * do-not-pay-again message instead of being sent on as if they had paid.
 */

import * as React from 'react';
import { afterPolling } from './approval-outcome';

export type PollPhase = 'confirming' | 'redirecting' | 'handing_off' | 'unconfirmed';

const POLL_EVERY_MS = 2_000;
const POLL_FOR_MS = 20_000;

/**
 * @example
 * const poll = usePollUntilComplete(basePath, successUrl, setPhase);
 * await poll(); // or poll({ fromClaim: true })
 */
export function usePollUntilComplete(
  basePath: string,
  successUrl: string,
  onPhase: (phase: PollPhase) => void,
): (options?: { fromClaim?: boolean }) => Promise<void> {
  return React.useCallback(async (options?: { fromClaim?: boolean }) => {
    const finish = (confirmed: boolean): void => {
      onPhase(confirmed ? 'redirecting' : 'handing_off');
      window.location.assign(successUrl);
    };
    onPhase('confirming');
    const deadline = Date.now() + POLL_FOR_MS;
    let last: string | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
      last = await readStatus(basePath);
      if (last === 'complete') return finish(true);
    }
    const unconfirmedClaim = options?.fromClaim === true && last === 'open';
    if (!unconfirmedClaim && afterPolling(last) === 'finish') return finish(false);
    onPhase('unconfirmed');
  }, [basePath, successUrl, onPhase]);
}

/**
 * The session's status from the portal's status route, or undefined.
 *
 * @example
 * await readStatus('/acme/checkout/chk_test_…'); // 'confirming'
 */
export async function readStatus(basePath: string): Promise<string | undefined> {
  const res = await fetch(`${basePath}/status`, { cache: 'no-store' }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { status?: string } | null;
  return body?.status;
}
