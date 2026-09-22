// @vitest-environment jsdom
/**
 * The unsaved-changes guard still works after the first save.
 *
 * `ActionForm` no longer rethrows the redirect a save ends in, so the page is
 * re-rendered in place rather than remounted by `RedirectBoundary`, and
 * `StickyFormFooter` outlives the save. It used to set "submitting" on submit
 * and never clear it, with the pre-save values as its baseline, so after one
 * save on Auth methods, a second edit followed by a sidebar click left the page
 * with no prompt (0 of 6 on a production build, against 4 of 6 before). It now
 * re-arms when the server render the save caused is committed.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionForm } from '@/components/ActionForm';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { noteCommittedRender } from '@/lib/render-stamp';

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  noteCommittedRender('before-save');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function toggle(name: string): void {
  const box = container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A click on an in-app link; true when the guard asked first. */
function clickLinkAsked(): boolean {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const link = container.querySelector('a')!;
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  const asked = confirm.mock.calls.length > 0;
  confirm.mockRestore();
  return asked;
}

describe('StickyFormFooter after a save', () => {
  it('guards the next edit once the save has landed', async () => {
    const action = async (): Promise<void> => undefined;
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement('a', { href: '/elsewhere' }, 'Elsewhere'),
          React.createElement(
            ActionForm,
            { action },
            React.createElement('input', { type: 'checkbox', name: 'a' }),
            React.createElement('input', { type: 'checkbox', name: 'b' }),
            React.createElement(StickyFormFooter),
          ),
        ),
      );
    });

    // First edit is guarded (the component works at all).
    await act(async () => toggle('a'));
    expect(clickLinkAsked(), 'the first edit was not guarded').toBe(true);

    // Save.
    await act(async () => {
      container.querySelector('form')!.requestSubmit(container.querySelector('button[type=submit]'));
    });
    // The server render the save caused reaches the screen.
    await act(async () => {
      noteCommittedRender('after-save');
      vi.advanceTimersByTime(10);
    });
    expect(container.textContent, 'still reads dirty right after the save').toContain('No unsaved changes.');

    // A second edit, then a sidebar click: must ask.
    await act(async () => toggle('b'));
    expect(container.textContent).toContain('Unsaved changes');
    expect(
      clickLinkAsked(),
      'After one save the guard never asked again: it stayed in "submitting" with the pre-save baseline, so leaving discarded the second edit silently.',
    ).toBe(true);
  });

  it('does not take unsaved edits as the baseline when a render arrives without a save', async () => {
    const action = async (): Promise<void> => undefined;
    await act(async () => {
      root.render(
        React.createElement(
          'div',
          null,
          React.createElement('a', { href: '/elsewhere' }, 'Elsewhere'),
          React.createElement(
            ActionForm,
            { action },
            React.createElement('input', { type: 'checkbox', name: 'a' }),
            React.createElement(StickyFormFooter),
          ),
        ),
      );
    });
    await act(async () => toggle('a'));
    // e.g. a RefreshAfterAction refresh from something else landing now.
    await act(async () => {
      noteCommittedRender('unrelated-refresh');
      vi.advanceTimersByTime(10);
    });
    expect(clickLinkAsked()).toBe(true);
  });
});
