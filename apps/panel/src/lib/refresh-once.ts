/**
 * The scheduling half of `<RefreshAfterAction>`, kept free of React so the
 * rules can be tested without a DOM.
 *
 * The rules, each one a bug an earlier shape had:
 *
 *   1. **One refresh per action that lands, and a bounded number of tries.**
 *      Each action landing carries its own id (a UUID minted by the render the
 *      action streamed back). The first schedule for an id fires once. The
 *      version before re-ran on every `pathname` or `search` change for as long
 *      as it stayed mounted, which could be for many clicks.
 *   2. **Always refresh, even if the operator has moved on.** Skipping it when
 *      the pathname changed left every tab visited in the last
 *      `staleTimes.dynamic` seconds serving its pre-write render from the
 *      router cache, with nothing coming to replace it.
 *   3. **A discarded refresh is retried, and only a discarded one.** Next
 *      discards a pending refresh when a navigation or a `history.replaceState`
 *      (how `SavedBanner` tidies its flag) arrives first. A refresh that
 *      COMMITS re-renders the authed layout without `x-action-redirect`, which
 *      unmounts the component, so "still mounted once the transition we fired
 *      has stopped pending" means the refresh was dropped. The component then
 *      calls
 *      `rearmRefresh`, up to `MAX_REFRESH_ATTEMPTS` in total.
 *   4. **Not while anything is still in flight.** A schedule waits until the
 *      document has no `[aria-busy="true"]` element: no `loading.tsx` skeleton
 *      still streaming (whose `SavedBanner` would then discard the refresh),
 *      no pending submit (`SubmitButton`, `ConfirmButton`,
 *      `TypedConfirmButton`, the email editor). An earlier version gave up
 *      waiting after 3 s, which under load meant a refresh fired in the middle
 *      of a second, slower action. The only ceiling now is `maxWaitMs`
 *      (default 30 s), for a marker that never clears.
 *   5. **One re-arm at a time.** `createRearmGate` lets the component re-arm
 *      only once a fired refresh has SETTLED (its transition stopped pending)
 *      while the component is still mounted. Re-arming on every URL change
 *      instead stacked up to three whole-tree renders when the operator
 *      clicked tabs during one slow refresh.
 *
 * Cancelling (the effect cleanup) stops a pending schedule without counting it,
 * so React Strict Mode's mount, unmount, mount still ends in one refresh.
 */

export interface RefreshOnceDeps {
  refresh: () => void;
  /** True once nothing on the page is still loading or submitting. */
  isSettled: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

export interface RefreshOnceOptions {
  pollMs?: number;
  maxWaitMs?: number;
}

export const MAX_REFRESH_ATTEMPTS = 3;
/** Hard ceiling on waiting for busy markers to clear. */
export const DEFAULT_MAX_WAIT_MS = 30_000;

/** Refreshes fired per action id. Module state: one per browser tab. */
const fired = new Map<string, number>();
/** Ids with a schedule waiting to fire. */
const pending = new Set<string>();
const MAX_REMEMBERED = 100;

function recordFired(id: string): void {
  fired.set(id, (fired.get(id) ?? 0) + 1);
  if (fired.size > MAX_REMEMBERED) {
    // Maps iterate in insertion order, so this drops the oldest.
    const oldest = fired.keys().next().value;
    if (oldest !== undefined) fired.delete(oldest);
  }
}

function schedule(
  actionId: string,
  deps: RefreshOnceDeps,
  opts: RefreshOnceOptions,
  onFire?: () => void,
): () => void {
  if (pending.has(actionId)) return () => undefined;
  const pollMs = opts.pollMs ?? 50;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const startedAt = deps.now();
  let handle: unknown;
  let cancelled = false;
  pending.add(actionId);

  const tick = (): void => {
    if (cancelled) return;
    if (deps.isSettled() || deps.now() - startedAt >= maxWaitMs) {
      pending.delete(actionId);
      recordFired(actionId);
      deps.refresh();
      onFire?.();
      return;
    }
    handle = deps.setTimer(tick, pollMs);
  };

  // Never synchronously: the redirect's own navigation is dispatched by an
  // effect in the same commit that mounted us, and it has to be queued first.
  // A refresh that ran ahead of it would empty the prefetch cache, drop the
  // seeded redirect payload, and bring back the blank page (see
  // `(authed)/layout.tsx`).
  handle = deps.setTimer(tick, pollMs);

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (pending.delete(actionId) && handle !== undefined) deps.clearTimer(handle);
  };
}

/** The first refresh for an action that just landed. A no-op for an id that has fired. */
export function scheduleRefreshOnce(
  actionId: string,
  deps: RefreshOnceDeps,
  opts: RefreshOnceOptions = {},
  onFire?: () => void,
): () => void {
  if ((fired.get(actionId) ?? 0) > 0) return () => undefined;
  return schedule(actionId, deps, opts, onFire);
}

/**
 * Try again after a refresh was discarded. A no-op until the first refresh has
 * fired, and after `MAX_REFRESH_ATTEMPTS`.
 */
export function rearmRefresh(
  actionId: string,
  deps: RefreshOnceDeps,
  opts: RefreshOnceOptions = {},
  onFire?: () => void,
): () => void {
  const count = fired.get(actionId) ?? 0;
  if (count === 0 || count >= MAX_REFRESH_ATTEMPTS) return () => undefined;
  return schedule(actionId, deps, opts, onFire);
}

/**
 * Decides when the component may re-arm. Feed it the refresh transition's
 * `isPending` on every render; it answers true exactly when a pending refresh
 * has just settled. A refresh that COMMITS unmounts the component in the same
 * render, so its effects never see that answer; one still mounted after
 * settling was discarded, and is the only case worth retrying.
 */
export function createRearmGate(): { observe: (isPending: boolean) => boolean } {
  let wasPending = false;
  return {
    observe(isPending) {
      const settled = wasPending && !isPending;
      wasPending = isPending;
      return settled;
    },
  };
}

/** Test seam. */
export function resetRefreshOnceState(): void {
  fired.clear();
  pending.clear();
}
