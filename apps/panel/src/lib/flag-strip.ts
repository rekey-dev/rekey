/**
 * When `SavedBanner` may take its success flag (`?saved=1`, `?disabled=1`, ...)
 * out of the address bar.
 *
 * Not on mount. An action's redirect lands with the flag, and the authed
 * layout then fires one `router.refresh()` (`RefreshAfterAction`). Next 15
 * copies a native `history.replaceState` into the router's own URL, so a flag
 * stripped on mount is also gone from the URL that refresh renders: the page
 * comes back without it, stops rendering its banner, and the operator sees the
 * success message for about 100 ms. So the flag stays until a newer server
 * render than the landing one has committed (the refresh, which still carried
 * it), or until the banner is hidden, whichever comes first. The second covers
 * a flag that arrived without an action, where no refresh follows.
 */

export interface FlagStripDeps {
  /** Id of the server render on screen now (`lib/render-stamp.ts`). */
  committedRender: () => string | null;
  /** Called whenever a new server render commits. Returns an unsubscribe. */
  subscribe: (listener: () => void) => () => void;
  /** Remove the flag from the address bar. */
  strip: () => void;
}

/**
 * Strip once a server render newer than the one on screen now has committed.
 * Returns a cancel function, safe to call more than once.
 *
 * @example
 *   React.useEffect(
 *     () => stripAfterNextRender({ committedRender, subscribe: subscribeCommittedRender, strip }),
 *     [],
 *   );
 */
export function stripAfterNextRender(deps: FlagStripDeps): () => void {
  const landing = deps.committedRender();
  let done = false;
  const unsubscribe = deps.subscribe(() => {
    if (done || deps.committedRender() === landing) return;
    done = true;
    unsubscribe();
    deps.strip();
  });
  return () => {
    if (done) return;
    done = true;
    unsubscribe();
  };
}

/**
 * `search` without `params`, or null when none of them is present, so a caller
 * can skip the history write entirely.
 *
 * @example
 *   withoutParams('?disabled=1&tab=a', ['disabled']); // '?tab=a'
 */
export function withoutParams(search: string, params: readonly string[]): string | null {
  const next = new URLSearchParams(search);
  let changed = false;
  for (const p of params) {
    if (next.has(p)) {
      next.delete(p);
      changed = true;
    }
  }
  if (!changed) return null;
  const qs = next.toString();
  return qs ? `?${qs}` : '';
}
