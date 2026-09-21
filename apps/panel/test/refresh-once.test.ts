/**
 * The post-save refresh happens once per action, is retried only when Next
 * discarded it, and never runs ahead of the page it is refreshing.
 *
 * `<RefreshAfterAction>` costs a full render of every layout plus the page, so
 * each rule here is request volume against a shared API rate limit. On a
 * production build of the old component the refresh was also unreliable in
 * the other direction: in one of four measured saves it never landed at all,
 * and the next visit to the overview served its pre-save render from the
 * router cache.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_WAIT_MS,
  MAX_REFRESH_ATTEMPTS,
  createRearmGate,
  rearmRefresh,
  resetRefreshOnceState,
  scheduleRefreshOnce,
  type RefreshOnceDeps,
} from '../src/lib/refresh-once';

/** A fake clock and timer queue, so every test is deterministic. */
function harness(opts: { settled?: boolean } = {}) {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const state = { settled: opts.settled ?? true, refreshes: 0 };
  const deps: RefreshOnceDeps = {
    refresh: () => {
      state.refreshes += 1;
    },
    isSettled: () => state.settled,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
    now: () => now,
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
    }
    now = until;
  };
  return { deps, state, advance };
}

beforeEach(() => resetRefreshOnceState());

describe('scheduleRefreshOnce', () => {
  it('refreshes exactly once for an action, and never synchronously', () => {
    const h = harness();
    scheduleRefreshOnce('act-1', h.deps);
    expect(h.state.refreshes).toBe(0);
    h.advance(1000);
    expect(h.state.refreshes).toBe(1);
  });

  it('does not refresh again when the same action is scheduled again (a re-run effect)', () => {
    const h = harness();
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(1);
  });

  it('still refreshes when the operator has moved to another tab first', () => {
    // That tab may be served from the router cache with its pre-write render;
    // skipping the refresh here is what left stale data on screen.
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    h.advance(500); // the operator clicks away while the landing still streams
    h.state.settled = true;
    h.advance(100);
    expect(h.state.refreshes).toBe(1);
  });

  it('re-arms a refresh that was discarded, and only after one fired', () => {
    const h = harness();
    // Before anything fired, a URL change is not a discard.
    rearmRefresh('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(0);

    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(1);
    // Still mounted and the URL moved: Next dropped it. Try again.
    rearmRefresh('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(2);
  });

  it('gives up after MAX_REFRESH_ATTEMPTS, so a page that keeps changing its URL cannot loop', () => {
    const h = harness();
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    for (let i = 0; i < 10; i++) {
      rearmRefresh('act-1', h.deps);
      h.advance(1000);
    }
    expect(h.state.refreshes).toBe(MAX_REFRESH_ATTEMPTS);
  });

  it('does not stack a second schedule on one still waiting', () => {
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    h.advance(3100);
    rearmRefresh('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    rearmRefresh('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    h.advance(3100);
    expect(h.state.refreshes).toBe(2);
  });

  it('waits while the page is still loading or a form is still submitting', () => {
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    h.advance(1000);
    expect(h.state.refreshes).toBe(0);
    h.state.settled = true;
    h.advance(100);
    expect(h.state.refreshes).toBe(1);
  });

  it('does not wait forever on something that never settles', () => {
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps, { pollMs: 50, maxWaitMs: 3000 });
    h.advance(3100);
    expect(h.state.refreshes).toBe(1);
  });

  it('survives Strict Mode: mount, cleanup, mount ends in one refresh', () => {
    const h = harness();
    const cancel = scheduleRefreshOnce('act-1', h.deps);
    cancel();
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(1);
  });

  it('a second action gets its own refresh', () => {
    const h = harness();
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    scheduleRefreshOnce('act-2', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(2);
  });

  it('does not fire in the middle of a slow action: waits past 3s while a submit is busy', () => {
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(10_000); // a second action still pending, under load
    expect(h.state.refreshes).toBe(0);
    h.state.settled = true;
    h.advance(100);
    expect(h.state.refreshes).toBe(1);
  });

  it('still has a hard ceiling for a marker that never clears', () => {
    const h = harness({ settled: false });
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(DEFAULT_MAX_WAIT_MS - 100);
    expect(h.state.refreshes).toBe(0);
    h.advance(200);
    expect(h.state.refreshes).toBe(1);
  });
});

describe('createRearmGate', () => {
  it('opens exactly once per refresh that settles while still mounted', () => {
    const gate = createRearmGate();
    expect(gate.observe(false)).toBe(false); // mount, nothing in flight
    expect(gate.observe(true)).toBe(false); // refresh fired
    expect(gate.observe(false)).toBe(true); // settled without unmounting: discarded
    expect(gate.observe(false)).toBe(false); // no second answer for the same settle
  });

  it('stays shut while one slow refresh is in flight, however many tab clicks re-render', () => {
    const h = harness();
    const gate = createRearmGate();
    scheduleRefreshOnce('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(1);
    // Five tab clicks while the refresh is still pending: each re-renders the
    // component with isPending true. None may re-arm.
    for (let i = 0; i < 5; i++) {
      if (gate.observe(true)) rearmRefresh('act-1', h.deps);
      h.advance(1000);
    }
    expect(h.state.refreshes).toBe(1);
    // It settles and the component is still mounted: one retry.
    if (gate.observe(false)) rearmRefresh('act-1', h.deps);
    h.advance(1000);
    expect(h.state.refreshes).toBe(2);
  });
});
