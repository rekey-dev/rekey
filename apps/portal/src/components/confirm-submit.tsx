'use client';

/**
 * Submit button that confirms first via a styled <dialog>. Lives inside a
 * server-action <form>; the confirm button is a real type="submit" so the
 * form's action runs exactly as a plain submit would — only gated by an
 * explicit confirmation. Used for money/irreversible actions in the portal
 * (cancel subscription, switch plan) so a single stray click can't trigger them.
 */

import * as React from 'react';
import { useFormStatus } from 'react-dom';

/**
 * The dialog's two buttons. Split out so they can call `useFormStatus`, which
 * reports the pending state of the ancestor `<form>` — and only works from a
 * component rendered inside it.
 *
 * Both are locked while the action is in flight. Previously neither was, and
 * the confirm button also closed the dialog on click: a customer on a slow
 * connection was handed back a live, re-openable trigger while their checkout
 * or cancellation was still running. Two clicks, two checkout sessions.
 *
 * The dialog now stays up showing the pending label until the action's redirect
 * unmounts it — which is also the page's only feedback that anything happened.
 */
function ConfirmActions({
  label,
  pendingLabel,
  confirmClassName,
  cancelClassName,
  onCancel,
}: {
  label: string;
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
        Keep it
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
  /** Confirm button text while the action is in flight. */
  pendingLabel?: string;
  variant?: 'primary' | 'neutral';
  size?: 'sm' | 'md';
  /**
   * Optional extra content rendered inside the dialog, between the message and
   * the buttons — e.g. a provider picker whose inputs post with the form.
   */
  children?: React.ReactNode;
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const baseId = React.useId();

  // Same keyboard focus ring as <Button> (components/button.tsx). The buttons
  // here keep their compact py-1.5 padding, which Button's fixed base classes
  // would override, so the ring classes are applied directly instead.
  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]';

  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-1.5 text-sm';
  const triggerCls =
    variant === 'primary'
      ? `rounded-md bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] ${pad} ${focusRing}`
      : `rounded-md border border-[var(--color-border)] hover:bg-[var(--color-bg)] ${pad} ${focusRing}`;

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
      <button type="button" className={triggerCls} onClick={open}>
        {label}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`${baseId}-title`}
        className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-[var(--color-fg)] backdrop:bg-black/50"
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <h2 id={`${baseId}-title`} className="text-base font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted-fg)]">{message}</p>
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <ConfirmActions
            label={confirmLabel ?? label}
            pendingLabel={pendingLabel ?? 'Working…'}
            onCancel={close}
            cancelClassName={`rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg)] ${focusRing}`}
            confirmClassName={`rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] ${focusRing}`}
          />
        </div>
      </dialog>
    </>
  );
}
