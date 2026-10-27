'use client';

/**
 * Form submit with a styled confirmation dialog. Wraps a server-action form:
 *
 *   <ActionForm action={revoke}>
 *     <ConfirmButton confirm="Revoke this key? This cannot be undone.">Revoke</ConfirmButton>
 *   </ActionForm>
 *
 * The trigger opens a native `<dialog>` (top-layer, focus-trapped, Esc-to-close,
 * backdrop-click-to-dismiss). Confirm is a real `type="submit"` inside the
 * parent form, so the server action runs exactly as before, only the
 * confirmation surface changed from `window.confirm` to a styled modal that
 * matches the rest of the panel.
 *
 * For high-stakes deletes that should require typing a phrase, use
 * <TypedConfirmButton> instead.
 */

import * as React from 'react';
import { useActionPending } from './ActionForm';
import { dangerButtonClass } from './Button';
import { ModalHeader, dialogChromeCls } from './Modal';

export function ConfirmButton({
  confirm,
  children,
  title,
  confirmLabel,
  pendingLabel,
  variant = 'danger',
  triggerClassName,
  triggerPressed,
}: {
  /** Body text explaining what will happen. */
  confirm: string;
  /** Trigger label (and the default confirm-button label). */
  children: React.ReactNode;
  /** Dialog heading naming the action and its object, e.g. "Delete webhook endpoint?". */
  title: string;
  /** Confirm-button label. Defaults to `children`. */
  confirmLabel?: React.ReactNode;
  /** Trigger label while the action runs. Defaults to `children`. */
  pendingLabel?: React.ReactNode;
  variant?: 'danger' | 'subtle';
  /** Replaces the trigger's text-link style, for a trigger that should read as a button. */
  triggerClassName?: string;
  /**
   * `aria-pressed` for a trigger that is one choice in a group of toggle
   * buttons, so it announces like its siblings. Leave it off otherwise.
   */
  triggerPressed?: boolean;
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;

  const triggerCls = `${
    triggerClassName ??
    (variant === 'danger'
      ? dangerButtonClass('xs')
      : 'inline-block py-1.5 text-xs text-[var(--color-muted-fg)] hover:underline')
  } aria-busy:opacity-60 aria-busy:cursor-wait`;

  const confirmCls =
    variant === 'danger'
      ? 'rounded-md bg-red-600 hover:bg-red-700 px-3 py-1.5 text-sm font-medium text-white'
      : 'rounded-md bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]';

  const open = (): void => {
    try {
      dialogRef.current?.showModal();
    } catch {
      /* already open / detached, ignore */
    }
  };
  const close = (): void => dialogRef.current?.close();
  // The dialog closes before the action runs, so the trigger is the element
  // left on screen. `aria-busy` is also what `<RefreshAfterAction>` waits on,
  // which is why this must not come straight from `useFormStatus`: a stuck
  // true would block that refresh for good. See `ActionForm.tsx`.
  const pending = useActionPending();

  return (
    <>
      <button
        type="button"
        className={triggerCls}
        onClick={open}
        disabled={pending}
        aria-busy={pending || undefined}
        aria-pressed={triggerPressed}
      >
        {pending ? (pendingLabel ?? children) : children}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={dialogChromeCls('sm')}
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <ModalHeader titleId={titleId} descId={descId} title={title} description={confirm} onClose={close} />
        <div className="flex items-center justify-end gap-2 p-6">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Cancel
          </button>
          {/* Real submit on the parent <form action={…}>. Close first so the
              modal layer doesn't swallow the submit, then let it propagate. */}
          <button type="submit" onClick={close} className={confirmCls}>
            {confirmLabel ?? children}
          </button>
        </div>
      </dialog>
    </>
  );
}
