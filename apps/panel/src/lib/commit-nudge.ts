/**
 * Keeps poking React after a Server Action until the server render it caused
 * has actually been committed.
 *
 * ## The bug this exists for
 *
 * On a production build, a transition that re-renders the page the operator is
 * already on (an action's `redirect()` back to its own page, a
 * `revalidatePath`, a `router.refresh()`) can be left suspended for good. React
 * suspends on a Flight chunk that is still streaming in, the chunk resolves a
 * few milliseconds later, and the ping that should retry the render never
 * arrives. The root is left with the transition's lanes marked suspended, no
 * callback scheduled and nothing pending, so the old page stays on screen.
 * Nothing is wrong with the payload: every chunk it suspended on is fulfilled.
 *
 * Measured on this panel (Next 15.5.18, `next start`), reading the root's
 * lanes through a devtools hook:
 *
 *   - a bare `router.refresh()` wedged on /team, /workspace, /applications,
 *     the application overview and its Webhooks tab, and committed on the API
 *     keys and API tokens pages. No action involved at all.
 *   - an action on a wedging page answered 303 with the redirect and its
 *     payload, the payload was complete within 30 ms, and the URL never
 *     changed: no `pushState`, no new rows, no secret banner.
 *   - any unrelated state update afterwards (opening the command palette was
 *     enough) cleared it at once: React treats every update as a reason to
 *     retry suspended lanes, and by then every chunk was there.
 *
 * It is the same wedge as issue #567 (a pending flag that never cleared) and
 * issue #569 (a redirect that never landed), which were each worked around at
 * the symptom. Tab navigations do not hit it, because they suspend into a
 * `loading.tsx` fallback rather than holding the previous screen.
 *
 * ## The workaround
 *
 * An update of our own is the retry React forgot to schedule. After an action
 * settles, the caller hands us a `nudge` (a state update on a component that
 * renders nothing new) and a `committed` check. We nudge on a backing-off
 * schedule until `committed()` says a new server render has reached the screen
 * (`RenderStamp` in the authed layout changes on every one), or the schedule
 * runs out. Each nudge that lands while the payload is still streaming just
 * suspends again, and the next one retries.
 *
 * Cost: a handful of re-renders of one small client component per action, and
 * at most one retried transition render per nudge.
 */

/**
 * Delays between nudges, in ms. Front-loaded because the payload is usually
 * complete within tens of milliseconds, then backing off to cover a slow API
 * render. About 13 seconds end to end.
 */
export const NUDGE_DELAYS_MS: readonly number[] = [30, 60, 120, 250, 500, 1000, 2000, 4000, 5000];

export interface CommitNudgeDeps {
  /** Schedule a React update that retries whatever transition is suspended. */
  nudge: () => void;
  /** True once the render the action caused has been committed. */
  committed: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Nudge until committed or out of schedule. Returns a cancel function; safe to
 * call more than once.
 */
export function nudgeUntilCommitted(
  deps: CommitNudgeDeps,
  delays: readonly number[] = NUDGE_DELAYS_MS,
): () => void {
  let step = 0;
  let handle: unknown;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (deps.committed()) {
      stopped = true;
      return;
    }
    deps.nudge();
    step += 1;
    const next = delays[step];
    if (next === undefined) {
      stopped = true;
      return;
    }
    handle = deps.setTimer(tick, next);
  };

  const first = delays[0];
  if (first === undefined) return () => undefined;
  handle = deps.setTimer(tick, first);

  return () => {
    if (stopped) return;
    stopped = true;
    if (handle !== undefined) deps.clearTimer(handle);
  };
}
