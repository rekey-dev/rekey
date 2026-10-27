/**
 * The confirm dialog closes before its action runs, so the trigger is what the
 * operator sees while it is in flight. It has to look busy and refuse a second
 * click, or it invites a duplicate submit.
 */

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pending: false }));
vi.mock('@/components/ActionForm', () => ({ useActionPending: () => state.pending }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const { ConfirmButton } = await import('@/components/ConfirmButton');
const { TypedConfirmButton } = await import('@/components/TypedConfirmButton');

function trigger(el: React.ReactElement): string {
  const html = renderToStaticMarkup(el);
  const match = html.match(/^<button[^>]*>.*?<\/button>/);
  if (!match) throw new Error(`no trigger in ${html}`);
  return match[0];
}

const confirm = (): React.ReactElement =>
  React.createElement(
    ConfirmButton,
    { title: 'Delete webhook endpoint?', confirm: 'Gone for good.', pendingLabel: 'Deleting…' },
    'Delete',
  );
const typed = (): React.ReactElement =>
  React.createElement(TypedConfirmButton, {
    expected: 'acme',
    title: 'Delete application?',
    description: 'Gone for good.',
    pendingLabel: 'Deleting…',
  });

describe.each([
  ['ConfirmButton', confirm],
  ['TypedConfirmButton', typed],
])('%s trigger', (_name, build) => {
  it('is disabled, busy and shows the pending label while the action runs', () => {
    state.pending = true;
    const html = trigger(build());
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('>Deleting…</button>');
  });

  it('is enabled and shows its own label when idle', () => {
    state.pending = false;
    const html = trigger(build());
    expect(html).not.toContain(' disabled=');
    expect(html).not.toContain(' aria-busy=');
    expect(html).toContain('>Delete</button>');
  });
});
