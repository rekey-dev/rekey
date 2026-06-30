'use client';

/**
 * Submit button that confirms first via a styled <dialog>. Lives inside a
 * server-action <form>; the confirm button is a real type="submit" so the
 * form's action runs exactly as a plain submit would — only gated by an
 * explicit confirmation. Used for money/irreversible actions in the portal
 * (cancel subscription, switch plan) so a single stray click can't trigger them.
 */

import * as React from 'react';

export function ConfirmSubmit({
  label,
  title,
  message,
  confirmLabel,
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

  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-1.5 text-sm';
  const triggerCls =
    variant === 'primary'
      ? `rounded-md bg-[var(--color-primary)] font-medium text-[var(--color-primary-fg)] ${pad}`
      : `rounded-md border border-[var(--color-border)] hover:bg-[var(--color-bg)] ${pad}`;

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
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg)]"
          >
            Keep it
          </button>
          <button
            type="submit"
            onClick={close}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)]"
          >
            {confirmLabel ?? label}
          </button>
        </div>
      </dialog>
    </>
  );
}
