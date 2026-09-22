/**
 * The id of the last server render of the authed layout that reached the
 * screen. `RenderStamp` writes it in a layout effect, so it changes exactly
 * when React commits a new server render (an action's redirect or revalidation,
 * a refresh), and not when the payload merely arrives. `lib/commit-nudge.ts`
 * reads it to know when to stop.
 *
 * Module state, one per browser tab. `null` outside the authed area, where
 * nothing renders a stamp and a nudge simply runs its schedule out.
 */
let committed: string | null = null;
const listeners = new Set<() => void>();

export function noteCommittedRender(stamp: string): void {
  if (stamp === committed) return;
  committed = stamp;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`: re-render when a new server render lands. */
export function subscribeCommittedRender(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function committedRender(): string | null {
  return committed;
}
