'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { createRearmGate, rearmRefresh, scheduleRefreshOnce, type RefreshOnceDeps } from '@/lib/refresh-once';
import { useCommitNudge } from './use-commit-nudge';

/**
 * One `router.refresh()` after a Server Action's redirect has landed, and never
 * another for the same action.
 *
 * Rendered by `(authed)/layout.tsx` only when the render is the destination of
 * an action redirect (see `lib/action-landing.ts`), with a fresh `actionId`
 * per action. The page itself is already fresh by then. What is not: the
 * router's cache. When an action does not revalidate, Next seeds the redirect
 * target into the EXISTING prefetch cache and keeps it, so every page visited
 * in the last `staleTimes.dynamic` seconds still holds its pre-write render. A
 * refresh is the only public way to drop those, and unlike a revalidation it
 * does not touch the redirect, so it cannot blank the page.
 *
 * The cost is one extra render of the whole tree (every layout plus the page),
 * so it matters that it happens once. The previous version re-ran its effect
 * on every `pathname` or `search` change. It stays mounted after the operator
 * clicks on, because client navigations do not re-render the authed layout,
 * so whenever its refresh had been discarded (a navigation or a
 * `history.replaceState` arriving while the refresh was in flight, both of
 * which Next lets win), the next tab click re-fired it, and that refresh
 * rendered the whole tree again on top of the click's own render.
 * `lib/refresh-once.ts` holds the rules: one refresh per action, retried only
 * after a refresh settled without committing (bounded), deferred until nothing
 * on the page is loading or submitting.
 */
export function RefreshAfterAction({ actionId }: { actionId: string }): null {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  const nudge = useCommitNudge();
  const deps = React.useMemo<RefreshOnceDeps>(
    () => ({
      // The refresh re-renders the page on screen, which is the transition that
      // can be left suspended for good (`lib/commit-nudge.ts`), so it gets the
      // same nudging as an action.
      refresh: () => {
        nudge.mark();
        startTransition(() => router.refresh());
        nudge.start();
      },
      isSettled: () => document.querySelector('[aria-busy="true"]') === null,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      now: () => Date.now(),
    }),
    [router, nudge],
  );

  React.useEffect(() => scheduleRefreshOnce(actionId, deps), [actionId, deps]);

  // Re-arm only when a fired refresh has settled and we are STILL mounted,
  // which means Next discarded it (a committed refresh unmounts this). Not on
  // URL changes: clicking tabs while one slow refresh is in flight must not
  // queue more whole-tree renders behind it. Bounded by MAX_REFRESH_ATTEMPTS.
  // Observed in an effect, not during render: a render may run twice, an
  // effect runs once per commit.
  const gate = React.useRef(createRearmGate());
  React.useEffect(() => {
    if (!gate.current.observe(isPending)) return;
    return rearmRefresh(actionId, deps);
  }, [isPending, actionId, deps]);

  return null;
}
