// @vitest-environment jsdom
/**
 * A `Modal` closes when ITS OWN action lands, and for nothing else.
 *
 * It closes on the server render a submit from inside it caused. An earlier
 * version closed on any committed render, so a `RefreshAfterAction` refresh
 * left over from a previous save, landing after the operator opened another
 * dialog, would have shut the dialog they were filling in.
 */

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routerReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ replace: routerReplace }),
  usePathname: () => window.location.pathname,
}));

const { Modal } = await import('@/components/Modal');
const { ActionForm } = await import('@/components/ActionForm');
const { noteCommittedRender } = await import('@/lib/render-stamp');

beforeAll(() => {
  // jsdom has <dialog> but not its modal methods.
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
  proto.showModal = function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  noteCommittedRender('initial');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  actEnv.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
});

async function openModal(): Promise<HTMLDialogElement> {
  const action = async (): Promise<void> => undefined;
  await act(async () => {
    root.render(
      React.createElement(
        Modal,
        { trigger: 'Open', title: 'Edit' },
        React.createElement(
          ActionForm,
          { action },
          React.createElement('input', { name: 'n' }),
          React.createElement('button', { type: 'submit' }, 'Save'),
        ),
      ),
    );
  });
  await act(async () => {
    (container.querySelector('button') as HTMLButtonElement).click();
  });
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open, 'the modal did not open').toBe(true);
  return dialog;
}

describe('Modal close-on-land', () => {
  it('stays open when a render it did not cause lands', async () => {
    const dialog = await openModal();
    await act(async () => noteCommittedRender('a-refresh-from-an-earlier-save'));
    expect(
      dialog.open,
      'An unrelated server render (a leftover refresh) closed a dialog the operator had just opened.',
    ).toBe(true);
  });

  it('closes once the render its own submit caused lands', async () => {
    const dialog = await openModal();
    await act(async () => {
      dialog.querySelector('form')!.requestSubmit(dialog.querySelector('button[type=submit]'));
    });
    await act(async () => noteCommittedRender('the-save-landing'));
    expect(dialog.open, 'the modal stayed open after its own save landed').toBe(false);
  });
});

describe('closing a modal opened by its URL flag', () => {
  it('drops the flag with replaceState and starts no navigation', async () => {
    window.history.replaceState(null, '', '/applications/a/api-keys?newKey=1&keep=1');
    routerReplace.mockReset();
    await act(async () => {
      root.render(
        React.createElement(
          Modal,
          { trigger: 'Open', title: 'Mint', modalKey: 'newKey' },
          React.createElement('p', null, 'form'),
        ),
      );
    });
    const dialog = container.querySelector('dialog')!;
    expect(dialog.open, 'the flag did not reopen the modal').toBe(true);
    await act(async () => {
      (dialog.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    });
    const sp = new URLSearchParams(window.location.search);
    expect(sp.has('newKey'), 'closing left ?newKey=1, so a reload reopens an empty form').toBe(false);
    expect(sp.get('keep')).toBe('1');
    expect(
      routerReplace,
      'router.replace starts a server round-trip for the same page, which a production build could leave uncommitted (the URL then kept the flag).',
    ).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/');
  });
});
