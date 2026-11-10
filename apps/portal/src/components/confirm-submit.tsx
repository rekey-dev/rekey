'use client';

/**
 * Submit button that confirms first via a styled <dialog>. Lives inside a
 * server-action <form>; the confirm button is a real type="submit" so the
 * form's action runs exactly as a plain submit would, only gated by an
 * explicit confirmation. Used for money/irreversible actions in the portal
 * (cancel subscription) so a single stray click can't trigger them.
 */

import * as React from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The dialog's two buttons. Split out so they can call `useFormStatus`, which
 * reports the pending state of the ancestor `<form>`, and only works from a
 * component rendered inside it.
 *
 * Both are locked while the action is in flight. Previously neither was, and
 * the confirm button also closed the dialog on click: a customer on a slow
 * connection was handed back a live, re-openable trigger while their checkout
 * or cancellation was still running. Two clicks, two checkout sessions.
 *
 * The dialog now stays up showing the pending label until the action's redirect
 * unmounts it, which is also the page's only feedback that anything happened.
 */
function ConfirmActions({
  label,
  cancelLabel,
  pendingLabel,
  confirmClassName,
  cancelClassName,
  onCancel,
}: {
  label: string;
  cancelLabel: string;
  pendingLabel: string;
  confirmClassName: string;
  cancelClassName: string;
  onCancel: () => void;
}): React.JSX.Element {
  const { pending } = useFormStatus();
  const lock = ' disabled:opacity-50 disabled:cursor-not-allowed';
  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className={cancelClassName + lock}
      >
        {cancelLabel}
      </button>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending || undefined}
        className={confirmClassName + lock}
      >
        {pending ? pendingLabel : label}
      </button>
    </>
  );
}

export function ConfirmSubmit({
  label,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Keep it',
  triggerName,
  pendingLabel,
  variant = 'primary',
  size = 'md',
  children,
}: {
  /** Trigger button text. */
  label: string;
  /** Dialog heading. */
  title: string;
  /** Dialog body. */
  message: string;
  /** Confirm button text. Defaults to `label`. */
  confirmLabel?: string;
  /** Dismiss button text. */
  cancelLabel?: string;
  /** Accessible name of the trigger when `label` repeats down a list. Starts with `label`. */
  triggerName?: string;
  /** Confirm button text while the action is in flight. */
  pendingLabel?: string;
  /** `danger` is for removing or ending something: red trigger text and a red confirm button. */
  variant?: 'primary' | 'neutral' | 'danger';
  size?: 'sm' | 'md';
  /**
   * Optional extra content rendered inside the dialog, between the message and
   * the buttons, e.g. a provider picker whose inputs post with the form.
   */
  children?: React.ReactNode;
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const baseId = React.useId();

  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-1.5 text-sm';
  const triggerCls =
    variant === 'primary'
      ? `min-h-11 rounded-md bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] ${pad}`
      : variant === 'danger'
        ? `min-h-11 rounded-md border border-[var(--color-border)] font-medium text-[var(--color-danger)] hover:bg-[var(--color-bg)] ${pad}`
        : `min-h-11 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-bg)] ${pad}`;
  const confirmFill =
    variant === 'danger'
      ? 'bg-[var(--color-danger)] text-[var(--color-danger-fg)]'
      : 'bg-[var(--color-primary)] text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]';

  const open = (): void => {
    try {
      dialogRef.current?.showModal();
    } catch {
      /* ignore */
    }
  };
  const close = (): void => dialogRef.current?.close();

  return (
    <>
      <button type="button" className={triggerCls} onClick={open} aria-label={triggerName}>
        {label}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`${baseId}-title`}
        aria-describedby={`${baseId}-message`}
        className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-fg)] backdrop:bg-black/50"
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <h2 id={`${baseId}-title`} className="text-base font-semibold">
          {title}
        </h2>
        <p id={`${baseId}-message`} className="mt-1 text-sm text-[var(--color-muted-fg)]">
          {message}
        </p>
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <ConfirmActions
            label={confirmLabel ?? label}
            cancelLabel={cancelLabel}
            pendingLabel={pendingLabel ?? 'Working…'}
            onCancel={close}
            cancelClassName={`min-h-11 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg)]`}
            confirmClassName={`min-h-11 rounded-md px-3 py-1.5 text-sm font-medium ${confirmFill}`}
          />
        </div>
      </dialog>
    </>
  );
}
