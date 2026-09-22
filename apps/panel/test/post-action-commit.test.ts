// @vitest-environment jsdom
/**
 * After a Server Action, the page on screen must show what the action changed.
 *
 * Operators reported it as "the table does not refresh": invite a member,
 * revoke a key, run a support action, and the old rows stay until a manual
 * reload. Measured on a production build (`lib/commit-nudge.ts` has the
 * numbers), the payload with the new rows arrived every time and React left
 * the transition that carried it suspended for good. The same wedge dropped
 * redirects (#569) and pinned pending flags (#567).
 *
 * Three rules keep it fixed, and each is a check below:
 *
 *   1. Every Server Action re-renders the page: it ends in `redirect()` or
 *      calls `revalidatePath()`. An action that does neither leaves every
 *      table on the page stale by construction.
 *   2. Every form that submits to a Server Action is an `ActionForm` (or a
 *      `RevealActionForm`, which is one), because that is where the nudge
 *      lives. A raw `<form action={serverAction}>` gets React's transition and
 *      nothing to un-wedge it.
 *   3. `ActionForm` keeps nudging after the action settles until the authed
 *      layout's `RenderStamp` changes. This is a behaviour test in jsdom: it
 *      cannot reproduce the production wedge, but it proves the retry is
 *      scheduled, and that it stops.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionForm } from '@/components/ActionForm';
import { NUDGE_DELAYS_MS, nudgeUntilCommitted } from '@/lib/commit-nudge';
import { noteCommittedRender } from '@/lib/render-stamp';
import { formElements } from './action-form.test';
import { localFunctions, refreshesPage, serverActions, sourceFiles } from './server-actions';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

/**
 * Actions that change nothing a page lists, so there is nothing to re-render.
 * Each needs its reason.
 */
const NOTHING_TO_REFRESH: Record<string, string> = {
  // The first half of a WebAuthn ceremony: returns the options the browser
  // needs and writes nothing the operator sees. The finishing action redirects.
  'startRegistration': 'passkey registration options',
  'startPasskeyLogin': 'passkey sign-in options',
};

describe('rule 1: every Server Action re-renders the page', () => {
  it('ends in redirect() or calls revalidatePath()', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(srcDir)) {
      const source = readFileSync(file, 'utf8');
      const fns = localFunctions(source);
      for (const action of serverActions(source)) {
        seen += 1;
        if (action.name in NOTHING_TO_REFRESH) continue;
        if (!refreshesPage(action.body, fns)) {
          offenders.push(`${path.relative(srcDir, file)}:${action.line} ${action.name}`);
        }
      }
    }
    // A scan that finds nothing proves nothing: the panel has well over a
    // hundred actions, so a parser that stopped matching them would show here.
    expect(seen, 'the Server Action scan found almost nothing; is the parser still matching?').toBeGreaterThan(80);
    expect(
      offenders,
      `These Server Actions neither redirect nor revalidate, so the page they were submitted from keeps showing what it showed before the write:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * Files allowed a raw `<form action={…}>`. Each one needs its reason.
 */
const RAW_FORM_ALLOWLIST: Record<string, string> = {
  // The implementation of the rule.
  [path.join('components', 'ActionForm.tsx')]: 'is ActionForm',
  // The Unlayer editor cancels the submit and posts the export itself, then
  // runs the same `useCommitNudge` ActionForm does (checked below). The
  // `action` attribute is only the no-JavaScript fallback.
  [path.join('components', 'EmailEditorClient.tsx')]: 'posts by hand, nudges itself',
};

describe('rule 2: every form that posts to a Server Action is an ActionForm', () => {
  it('the email editor, which posts by hand, nudges like ActionForm', () => {
    const source = readFileSync(path.join(srcDir, 'components', 'EmailEditorClient.tsx'), 'utf8');
    expect(source).toMatch(/useCommitNudge\(\)/);
    expect(source).toMatch(/nudge\.start\(\)/);
  });

  it('has no raw <form action={…}> outside ActionForm itself', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (rel in RAW_FORM_ALLOWLIST) continue;
      for (const form of formElements(readFileSync(file, 'utf8'))) {
        if (/\baction=\{/.test(form.head)) offenders.push(`${rel}:${form.line}`);
      }
    }
    expect(
      offenders,
      `A raw form posting to a Server Action gets no post-action nudge, so its result can sit unrendered (lib/commit-nudge.ts). Use ActionForm:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the authed layout stamps every server render', () => {
    const layout = readFileSync(path.join(srcDir, 'app', '(authed)', 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/<RenderStamp stamp=\{randomUUID\(\)\} \/>/);
  });
});

describe('nudgeUntilCommitted', () => {
  function fakeTimers(): {
    setTimer: (fn: () => void, ms: number) => number;
    clearTimer: (h: unknown) => void;
    run: () => number[];
  } {
    let queue: { fn: () => void; ms: number; id: number }[] = [];
    let next = 1;
    return {
      setTimer: (fn, ms) => {
        queue.push({ fn, ms, id: next });
        next += 1;
        return next - 1;
      },
      clearTimer: (h) => {
        queue = queue.filter((t) => t.id !== h);
      },
      run: () => {
        const waited: number[] = [];
        while (queue.length > 0) {
          const t = queue.shift()!;
          waited.push(t.ms);
          t.fn();
        }
        return waited;
      },
    };
  }

  it('nudges on every step of the schedule while nothing has committed, then stops', () => {
    const timers = fakeTimers();
    let nudges = 0;
    nudgeUntilCommitted({ nudge: () => (nudges += 1), committed: () => false, ...timers });
    expect(timers.run()).toEqual([...NUDGE_DELAYS_MS]);
    expect(nudges).toBe(NUDGE_DELAYS_MS.length);
  });

  it('stops at the first check after the render commits', () => {
    const timers = fakeTimers();
    let nudges = 0;
    nudgeUntilCommitted({ nudge: () => (nudges += 1), committed: () => nudges >= 2, ...timers });
    timers.run();
    expect(nudges).toBe(2);
  });

  it('can be cancelled before it fires', () => {
    const timers = fakeTimers();
    let nudges = 0;
    const cancel = nudgeUntilCommitted({ nudge: () => (nudges += 1), committed: () => false, ...timers });
    cancel();
    cancel();
    timers.run();
    expect(nudges).toBe(0);
  });
});

describe('rule 3: ActionForm nudges after the action settles', () => {
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    noteCommittedRender('render-before-the-action');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
    vi.useRealTimers();
  });

  async function submitAndCountCommits(): Promise<{ commits: () => number }> {
    let commits = 0;
    const action = async (): Promise<void> => undefined;
    await act(async () => {
      root.render(
        React.createElement(
          React.Profiler,
          { id: 'form', onRender: () => (commits += 1) },
          React.createElement(ActionForm, { action }, React.createElement('button', { type: 'submit' }, 'Save')),
        ),
      );
    });
    const form = container.querySelector('form')!;
    await act(async () => {
      form.requestSubmit(container.querySelector('button'));
    });
    return { commits: () => commits };
  }

  it('keeps re-rendering until a new server render is committed', async () => {
    const { commits } = await submitAndCountCommits();
    const settled = commits();
    // One act per step: act batches every update inside it into one render.
    for (const ms of NUDGE_DELAYS_MS.slice(0, 3)) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }
    const nudged = commits() - settled;
    expect(
      nudged,
      'ActionForm did not re-render after its action settled. On a production build the render the action caused can be left suspended until some other update retries it, and this nudge is that update (lib/commit-nudge.ts). Without it redirects are dropped and tables stay stale.',
    ).toBeGreaterThanOrEqual(3);

    // The layout's stamp changes: the render reached the screen. No more nudges.
    noteCommittedRender('render-after-the-action');
    for (const ms of NUDGE_DELAYS_MS.slice(3, 4)) {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    }
    const afterCommit = commits();
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
    }
    expect(commits(), 'ActionForm kept nudging after the new render had committed').toBe(afterCommit);
  });
});

describe('ActionForm does not rethrow a redirect (issue #25)', () => {
  const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    actEnv.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  });

  class Boundary extends React.Component<{ children: React.ReactNode; onCatch: (e: unknown) => void }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
    componentDidCatch(error: unknown): void {
      this.props.onCatch(error);
    }
    render(): React.ReactNode {
      return this.state.failed ? null : this.props.children;
    }
  }

  async function submitThrowing(error: unknown): Promise<unknown[]> {
    const caught: unknown[] = [];
    const action = async (): Promise<void> => {
      throw error;
    };
    await act(async () => {
      root.render(
        React.createElement(
          Boundary,
          { onCatch: (e: unknown) => caught.push(e) },
          React.createElement(ActionForm, { action }, React.createElement('button', { type: 'submit' }, 'Save')),
        ),
      );
    });
    await act(async () => {
      container.querySelector('form')!.requestSubmit(container.querySelector('button'));
    });
    return caught;
  }

  it('swallows the redirect signal: the router already has the destination', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/team?saved=1;307;' });
    const caught = await submitThrowing(redirect);
    expect(
      caught,
      'The redirect reached an error boundary. In the app that boundary is Next\'s RedirectBoundary, which renders nothing until it has navigated again: the page blinks blank on every save (issue #25).',
    ).toEqual([]);
    expect(container.querySelector('form'), 'the form was unmounted by a boundary').not.toBeNull();
  });

  it('still rethrows a real failure', async () => {
    // React reports what a boundary caught on console.error; expected here.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const caught = await submitThrowing(new Error('boom'));
      expect(caught).toHaveLength(1);
    } finally {
      quiet.mockRestore();
    }
  });
});
