/**
 * `SavedBanner` keeps its flag in the URL until the post-action refresh has
 * committed. Stripping it on mount made that refresh render the page without
 * the flag, so the banner vanished about 100 ms after it appeared (Lifecycle
 * disable/enable, Access "Sign out all end-users", and every other flag).
 */

import { describe, expect, it } from 'vitest';
import { stripAfterNextRender, withoutParams, type FlagStripDeps } from '../src/lib/flag-strip';

function harness(initial: string | null) {
  let stamp = initial;
  const listeners = new Set<() => void>();
  const state = { strips: 0 };
  const deps: FlagStripDeps = {
    committedRender: () => stamp,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    strip: () => {
      state.strips += 1;
    },
  };
  const commit = (next: string | null): void => {
    stamp = next;
    for (const l of [...listeners]) l();
  };
  return { deps, state, commit, listeners };
}

describe('stripAfterNextRender', () => {
  it('does not strip on mount, only once a newer server render commits', () => {
    const h = harness('landing');
    stripAfterNextRender(h.deps);
    expect(h.state.strips).toBe(0);
    h.commit('refresh');
    expect(h.state.strips).toBe(1);
  });

  it('ignores a notification for the render that was already on screen', () => {
    const h = harness('landing');
    stripAfterNextRender(h.deps);
    h.commit('landing');
    expect(h.state.strips).toBe(0);
  });

  it('strips once and unsubscribes', () => {
    const h = harness('landing');
    stripAfterNextRender(h.deps);
    h.commit('refresh');
    h.commit('later');
    expect(h.state.strips).toBe(1);
    expect(h.listeners.size).toBe(0);
  });

  it('never strips after cancel, and cancel is idempotent', () => {
    const h = harness('landing');
    const cancel = stripAfterNextRender(h.deps);
    cancel();
    cancel();
    h.commit('refresh');
    expect(h.state.strips).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  it('treats the first stamp outside a stamped layout as newer', () => {
    const h = harness(null);
    stripAfterNextRender(h.deps);
    h.commit('first');
    expect(h.state.strips).toBe(1);
  });
});

describe('withoutParams', () => {
  it('removes only the named params', () => {
    expect(withoutParams('?disabled=1&tab=a', ['disabled'])).toBe('?tab=a');
  });

  it('returns an empty search when nothing else is left', () => {
    expect(withoutParams('?rotated=3', ['rotated'])).toBe('');
  });

  it('returns null when none of the params is present', () => {
    expect(withoutParams('?tab=a', ['saved'])).toBeNull();
    expect(withoutParams('', ['saved'])).toBeNull();
  });
});
