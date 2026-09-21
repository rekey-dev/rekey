'use client';

/**
 * What an error boundary shows when the API said 429 or 503: an honest "the
 * API is busy", a countdown to an automatic retry, and a button.
 *
 * Before this, a 429 anywhere in a render reached the generic "Something went
 * wrong" boundary, which reads as "the panel is broken" and offers support as
 * the next step, for a condition that clears on its own in seconds.
 *
 * ## Retrying without hammering
 *
 * The retry honours Retry-After and backs off (`autoRetryDelaySeconds`): never
 * sooner than the API asked, with a doubling floor, three times, then it stops
 * and leaves a button. A retry that fails again remounts this boundary, so the
 * attempt count lives in `tabRetryBudget` (module scope, one per tab), and it
 * resets after two quiet minutes or on "Retry now". That is the difference between "retries three times" and
 * "retries forever at the limiter's pace", which on a shared rate limit keeps
 * the bucket full for every other operator too.
 *
 * `useRetry` is `router.refresh()` plus `reset()` in one transition, the
 * combination that actually re-runs a Server Component: `reset()` alone
 * re-renders the boundary from the payload the router already has, which still
 * contains the error.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { tabRetryBudget, type ApiBusyInfo } from '@/lib/api-busy';

export function useRetry(reset: () => void): () => void {
  const router = useRouter();
  return React.useCallback(() => {
    React.startTransition(() => {
      router.refresh();
      reset();
    });
  }, [router, reset]);
}

export function ApiBusyNotice({
  busy,
  reset,
  className = '',
}: {
  busy: ApiBusyInfo;
  reset: () => void;
  className?: string;
}): React.JSX.Element {
  const retry = useRetry(reset);
  const [delay] = React.useState<number | null>(() => tabRetryBudget.nextDelay(busy.retryAfterSeconds));
  const [remaining, setRemaining] = React.useState<number | null>(delay);

  React.useEffect(() => {
    if (delay === null) return;
    const startedAt = Date.now();
    const tick = window.setInterval(() => {
      const left = Math.max(0, delay - Math.floor((Date.now() - startedAt) / 1000));
      setRemaining(left);
      if (left === 0) {
        window.clearInterval(tick);
        tabRetryBudget.recordAttempt();
        retry();
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [delay, retry]);

  const limited = busy.status === 429;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border border-amber-300 bg-amber-50 p-8 text-center space-y-3 dark:border-amber-900/60 dark:bg-amber-950/40 ${className}`}
    >
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        {limited ? 'The Rekey API is busy' : 'The Rekey API is temporarily unavailable'}
      </p>
      <p className="mx-auto max-w-md text-xs text-amber-900/80 dark:text-amber-200/80">
        {limited
          ? 'It is rate limiting requests from this panel, so this page could not load yet.'
          : 'A service it depends on is not answering, so this page could not load yet.'}{' '}
        If you had just saved something, it may or may not have been applied: check once this
        page loads before saving it again.{' '}
        {remaining !== null
          ? remaining > 0
            ? `Retrying in ${remaining}s.`
            : 'Retrying now.'
          : `It asked for ${busy.retryAfterSeconds}s between attempts; automatic retries have stopped.`}
      </p>
      <div className="pt-1">
        <button
          type="button"
          onClick={() => {
            tabRetryBudget.reset();
            retry();
          }}
          className="rounded-md border border-amber-400 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:border-amber-800 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          Retry now
        </button>
      </div>
    </div>
  );
}
