'use client';

/**
 * High-stakes destructive confirmation. Opens a native <dialog> and refuses
 * to submit until the operator types the literal `expected` string (case-
 * sensitive). Modeled on Stripe's "type acme-prod to confirm" flow.
 *
 * Use for actions that erase weeks of config (delete Application, revoke
 * API key, remove billing credentials). For mid-stakes deletes (single
 * end-user, single role) the existing <ConfirmButton> is still right.
 *
 * Behaviour:
 *   - Submits a hidden parent <form action={server-action}>, so it works
 *     with React server actions exactly like <ConfirmButton>.
 *   - The dialog's submit is a real submit on the parent form; we
 *     `requestSubmit()` after Esc + Cancel + match.
 *   - Native <dialog> handles Esc, focus loop, and backdrop click.
 */

import * as React from 'react';
import { ModalHeader, dialogChromeCls } from '@/components/Modal';

interface Props {
  /** The exact string the operator must type to confirm. Usually the slug or name. */
  expected: string;
  /** Heading / question. */
  title: string;
  /** Explanatory body. Plain text, no HTML. */
  description: string;
  /** Trigger button label (defaults to "Delete"). */
  triggerLabel?: string;
  /** Confirm button label (defaults to triggerLabel). */
  confirmLabel?: string;
  /** Trigger button class (defaults to text-red-600 link). */
  triggerClassName?: string;
}

export function TypedConfirmButton({
  expected,
  title,
  description,
  triggerLabel = 'Delete',
  confirmLabel,
  triggerClassName,
}: Props): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const [typed, setTyped] = React.useState('');
  const matches = typed === expected;

  // Unique per instance. The ids used to be the literal strings
  // "typed-confirm-title" / "typed-confirm-desc", and the End-users list renders
  // one of these per row — so every dialog on the page shared the same ids and
  // `aria-labelledby` resolved to the FIRST row's heading. Screen-reader users
  // deleting row 12 heard row 1's name.
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;

  const open = (): void => {
    setTyped('');
    dialogRef.current?.showModal();
  };
  const close = (): void => {
    dialogRef.current?.close();
  };
  const confirm = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (!matches) {
      e.preventDefault();
      return;
    }
    // Close dialog first so the form submit isn't blocked by the modal layer.
    dialogRef.current?.close();
    // Let the button's default submit behaviour propagate to the parent
    // form on the next tick. Returning here is enough — the click handler
    // doesn't preventDefault; the button is type="submit" inside the
    // parent <form action={…}>.
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={
          triggerClassName ?? 'text-xs text-red-600 dark:text-red-400 hover:underline'
        }
      >
        {triggerLabel}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={descId}
        // Same chrome as every other modal — see the note on `dialogChromeCls`.
        className={dialogChromeCls('sm')}
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
      >
        <ModalHeader
          titleId={titleId}
          descId={descId}
          title={title}
          description={description}
          onClose={close}
        />
        <div className="p-6">
        <p className="text-sm">
          Type{' '}
          <code className="font-mono px-1.5 py-0.5 rounded bg-[var(--color-surface-muted)] border border-[var(--color-border)]">
            {expected}
          </code>{' '}
          to confirm.
        </p>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Confirmation phrase"
          aria-invalid={typed.length > 0 && !matches}
          className="w-full mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
        />
        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={close}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            onClick={confirm}
            disabled={!matches}
            className="rounded-md bg-red-600 hover:bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirmLabel ?? triggerLabel}
          </button>
        </div>
        </div>
      </dialog>
    </>
  );
}
