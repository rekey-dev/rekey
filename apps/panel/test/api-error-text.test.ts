/**
 * Render precedence, against the real component.
 *
 * The first version of this file re-implemented the precedence in a local
 * helper, so `api-error.tsx` could have been edited freely without a single
 * failure. It imports the component now and reads the element tree it returns —
 * no DOM needed, which suits this app's node-environment test setup.
 */
import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { ApiErrorText } from '../src/components/api-error';

/** The visible strings of whatever the component returned, in order. */
function textOf(el: React.ReactElement): string[] {
  const out: string[] = [];
  const walk = (node: React.ReactNode): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (React.isValidElement(node)) {
      walk((node.props as { children?: React.ReactNode }).children);
    }
  };
  walk(el);
  return out;
}

const render = (props: Parameters<typeof ApiErrorText>[0]) => textOf(ApiErrorText(props));

const LIMIT = 'This workspace has reached its limit of 1 production application.';

describe('ApiErrorText', () => {
  it("shows the API's message when the page has no words for the code", () => {
    expect(render({ code: 'LIMIT', detail: LIMIT, fix: 'Upgrade the plan.', map: {} })).toEqual([
      LIMIT,
      'Upgrade the plan.',
    ]);
  });

  it("prefers the page's own wording, and then withholds the API fix", () => {
    // Two voices in one banner reads as a non-sequitur: a page that took over
    // the explanation owns the whole message.
    expect(
      render({
        code: 'NAME_TAKEN',
        detail: 'name conflict',
        fix: 'Pick another.',
        map: { NAME_TAKEN: 'That name is already in use.' },
      }),
    ).toEqual(['That name is already in use.']);
  });

  it('falls back only when there is genuinely nothing to say', () => {
    expect(render({ code: 'MYSTERY', map: {} })).toEqual([
      'Something went wrong. Please try again.',
    ]);
  });

  it('handles an absent map and an absent code', () => {
    expect(render({ code: 'X', detail: LIMIT })).toEqual([LIMIT]);
    expect(render({ code: undefined, map: { X: 'nope' }, detail: LIMIT })).toEqual([LIMIT]);
  });

  it('renders the fix once, not twice', () => {
    // A hand-written copy of this span survived beside the component on the
    // applications page and printed the same sentence twice in two sizes.
    const parts = render({ code: 'X', detail: LIMIT, fix: 'Upgrade.', map: {} });
    expect(parts.filter((p) => p === 'Upgrade.')).toHaveLength(1);
  });

  it('uses a caller fallback when one is given', () => {
    expect(render({ code: 'RAW_CODE', map: {}, fallback: 'Could not save.' })).toEqual([
      'Could not save.',
    ]);
  });
});
