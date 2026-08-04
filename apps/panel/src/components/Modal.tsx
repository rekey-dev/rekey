'use client';

/**
 * Modal dialog backed by the native `<dialog>` element.
 *
 * Usage pattern (server-action friendly):
 *
 *   <Modal trigger="+ New plan" title="Add a plan">
 *     <form action={createPlan}>
 *       …labelled inputs…
 *     </form>
 *   </Modal>
 *
 * The form's server action runs on submit; on success it `redirect()`s,
 * which navigates the page and closes the dialog naturally. On validation
 * failure the action `redirect()`s back with `?error=…` in the query — the
 * page rerenders with the error rendered inside the form, modal still open
 * (because the trigger detects `searchParams[modalKey]` and reopens it).
 *
 * `modalKey` is the querystring flag used to reopen-on-error. Pages that
 * use the modal pass it both here and in their server-action redirects:
 *   redirect(`/.../page?error=…&newPlan=1`) → modalKey="newPlan"
 *
 * When a page renders ONE modal PER ROW, the flag has to say which row —
 * pass `modalValue` and redirect with that value instead of `1`:
 *   redirect(`/.../page?error=…&editUser=${id}`) → modalKey="editUser"
 *                                                  modalValue={user.id}
 * Only the row whose value matches reopens. Encoding the row into the key
 * itself (modalKey={`editUser_${id}`} + `?editUser=${id}`) does NOT work:
 * the lookup is by key, so it misses and the modal silently stays shut while
 * the error renders inside a closed <dialog> — invisible.
 *
 * If you don't need reopen-on-error, omit `modalKey`.
 *
 * **A11y model (post-Audit-3):**
 *   - Trigger is a real `<button>` (or, if `trigger` is itself an element with
 *     a click target, we render it inline and bind keyboard events). Keyboard
 *     users get Enter/Space activation; SR users hear "button".
 *   - `<dialog>` carries `aria-labelledby` pointed at the title, and
 *     `aria-describedby` pointed at the description when present.
 *   - Native `<dialog>.showModal()` provides focus loop + Esc-to-close.
 *   - `triggerClassName` lets call-sites style the button to match their
 *     existing primary/secondary look without losing semantic button-ness.
 */

import * as React from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { shouldReopen } from '@/lib/modal-reopen';

/**
 * Stable dialog id, identical on the server and the client.
 *
 * This used to be a module-level `++modalCounter`. The module is evaluated
 * once per server process and once per browser page, and the two never
 * agreed: the server had rendered other modals before this request, so it
 * emitted `aria-labelledby="rekey-modal-2-title"` where the freshly-loaded
 * client produced `-3-`. React logged "This won't be patched up" on every
 * page containing a Modal, and one load escalated to a full document reload.
 *
 * `useId()` is React's answer to exactly this — it derives the id from the
 * component's position in the tree, so both renders compute the same string.
 */
function useModalId(): string {
  return `rekey-modal-${React.useId()}`;
}

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLS: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
};

/**
 * The `<dialog>` chrome, shared by every modal in the panel.
 *
 * There used to be two dialog looks. This one — left-aligned, header rule, an X
 * — and a second, hand-rolled inside TypedConfirmButton: centred, narrower, no
 * rule, no X. Same product, same interaction, two visual languages, and a
 * confirm dialog that didn't look like it belonged to the app that opened it.
 * Both now render from these two exports.
 *
 * Kept as a class string plus a component rather than one wrapper component
 * because the two call sites differ in a way that matters: `Modal` owns its own
 * trigger and open/close state, while `TypedConfirmButton` has to submit the
 * PARENT form (its confirm button is a real `type="submit"` inside the caller's
 * `<form action={serverAction}>`). Sharing the chrome is the part that was
 * actually broken; sharing the mechanics would have meant rewriting the
 * server-action plumbing for no user-visible gain.
 */
export function dialogChromeCls(size: ModalSize = 'md'): string {
  return `m-auto h-fit rounded-xl p-0 text-left backdrop:bg-black/50 backdrop:backdrop-blur-sm bg-[var(--color-surface)] text-[var(--color-fg)] ${SIZE_CLS[size]} w-[90vw] shadow-2xl border border-[var(--color-border)]`;
}

/** Title + optional description + close affordance, above a rule. */
export function ModalHeader({
  titleId,
  descId,
  title,
  description,
  onClose,
}: {
  titleId: string;
  descId?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="px-6 pt-5 pb-3 border-b border-[var(--color-border)] flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {description && (
          <p id={descId} className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
            {description}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="shrink-0 rounded-md p-1 text-neutral-600 dark:text-neutral-400 hover:text-[var(--color-fg)] hover:bg-neutral-100 dark:hover:bg-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-primary)]"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function Modal({
  trigger,
  title,
  description,
  children,
  modalKey,
  modalValue,
  triggerClassName,
  triggerRef,
  size = 'md',
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  modalKey?: string;
  /**
   * Value `modalKey` must hold for THIS modal to reopen. Defaults to `'1'`.
   * Set it when one page renders a modal per row, so the flag identifies the
   * row (`?editUser=<id>` + modalKey="editUser" + modalValue={id}).
   */
  modalValue?: string;
  /**
   * Tailwind classes applied to the trigger `<button>`. Defaults to a primary
   * pill style; pass `""` to opt out and style via children, or pass your
   * own to match the surrounding row.
   */
  triggerClassName?: string;
  /**
   * Ref to the trigger `<button>`. Lets a parent open the modal
   * programmatically via `ref.current?.click()` — pass `triggerClassName="hidden"`
   * to drive it from a different control without rendering a visible button.
   * Do NOT pass a `<button>` as `trigger`; that would nest buttons.
   */
  triggerRef?: React.Ref<HTMLButtonElement>;
  /** Modal width. `md` (max-w-lg) is the default. Use `lg`/`xl` for richer
   *  multi-column forms (e.g. plan create with 3 cards). */
  size?: ModalSize;
}): React.JSX.Element {
  const ref = React.useRef<HTMLDialogElement>(null);
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const baseId = useModalId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;

  // Lock background scroll while the dialog is open. The native <dialog>
  // renders the rest of the page inert but does NOT stop it scrolling, so the
  // content behind the overlay could still scroll under the modal. Toggle
  // `overflow: hidden` on <html> for the duration.
  function lockScroll(): void {
    document.documentElement.style.overflow = 'hidden';
  }
  function unlockScroll(): void {
    document.documentElement.style.overflow = '';
  }

  // Reopen on error: if the URL carries this modal's flag, force it open.
  const reopen = shouldReopen(search, modalKey, modalValue);
  React.useEffect(() => {
    if (reopen && ref.current && !ref.current.open) {
      // showModal() may throw `InvalidStateError` if the dialog is already in
      // the modal-state (e.g. duplicate mount). Catch and ignore — the second
      // instance becoming a no-op is preferable to crashing the page.
      try {
        ref.current.showModal();
        lockScroll();
      } catch {
        /* already-open or detached — safe to ignore */
      }
    }
  }, [reopen]);

  // Always release the scroll lock if the component unmounts while open.
  React.useEffect(() => () => unlockScroll(), []);

  function open(): void {
    try {
      ref.current?.showModal();
      lockScroll();
    } catch {
      /* see above */
    }
  }

  function close(): void {
    ref.current?.close();
    // `dialog.close()` fires the native `close` event → handleClose() runs and
    // releases the lock. Unlock here too so the lock is never left stuck even
    // if a browser skips the event for a programmatic close. Idempotent.
    unlockScroll();
  }

  // Fires for every close path (X button, backdrop click, native Esc — all of
  // which end in the dialog's `close` event).
  function handleClose(): void {
    unlockScroll();
    stripModalParam();
  }

  // When the dialog closes (X button, backdrop click, or native Esc — all fire
  // the dialog's `close` event), strip the `?modalKey=1` flag from the URL.
  // Otherwise the URL stays at `?modalKey=1` while the dialog is shut, so a
  // trigger that navigates back to the same `?modalKey=1` is a no-op (URL
  // unchanged → `useSearchParams` doesn't change → the reopen effect never
  // re-fires) and the modal can't be reopened until a full reload.
  function stripModalParam(): void {
    if (modalKey && search.get(modalKey)) {
      const params = new URLSearchParams(search.toString());
      params.delete(modalKey);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }

  const defaultTriggerClass =
    'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]';

  // Only style the wrapping <button> when `trigger` is a string (default =
  // primary pill, override via triggerClassName). If `trigger` is an element it
  // styles itself — applying the pill too would double the styling (a pill
  // inside a pill). Pass triggerClassName explicitly to style the button.
  const triggerCls =
    triggerClassName ?? (typeof trigger === 'string' ? defaultTriggerClass : '');

  return (
    <>
      <button type="button" ref={triggerRef} onClick={open} className={triggerCls}>
        {trigger}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={dialogChromeCls(size)}
        onClose={handleClose}
        onClick={(e) => {
          // Click on backdrop → close. Safari is unreliable comparing
          // `e.target === ref.current`, so we additionally check that the
          // closest dialog is ours (rather than a child element bubbling up).
          if (e.target === e.currentTarget) close();
        }}
      >
        <ModalHeader
          titleId={titleId}
          descId={description ? descId : undefined}
          title={title}
          description={description}
          onClose={close}
        />
        <div className="p-6 max-h-[70vh] overflow-y-auto">{children}</div>
      </dialog>
    </>
  );
}
