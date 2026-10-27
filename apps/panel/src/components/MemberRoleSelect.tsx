'use client';

/**
 * Member role picker that confirms before changing, for workspace members and
 * organization members alike.
 *
 * Rendered inside a server-action <form action={changeRole.bind(null, id)}>.
 * The previous version auto-submitted on every `change`, so a misclick could
 * silently promote someone to OWNER. This requires an explicit confirm (with
 * an extra warning when granting OWNER) and reverts the select on cancel.
 */

import * as React from 'react';

/** One choice in the picker. `consequence` is what the confirm dialog says picking it does. */
export interface RoleOption {
  value: string;
  label: string;
  title?: string;
  consequence?: string;
}

export function MemberRoleSelect({
  email,
  currentRole,
  roles,
}: {
  email: string;
  currentRole: string;
  /** The roles the signed-in operator may hand out. */
  roles: readonly RoleOption[];
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const selectRef = React.useRef<HTMLSelectElement | null>(null);
  const [next, setNext] = React.useState<string | null>(null);
  const baseId = React.useId();
  const picked = roles.find((r) => r.value === next);

  function onChange(e: React.ChangeEvent<HTMLSelectElement>): void {
    const value = e.target.value;
    if (value === currentRole) return;
    setNext(value);
    try {
      dialogRef.current?.showModal();
    } catch {
      /* ignore */
    }
  }

  function cancel(): void {
    if (selectRef.current) selectRef.current.value = currentRole;
    setNext(null);
    dialogRef.current?.close();
  }

  function confirm(): void {
    dialogRef.current?.close();
    selectRef.current?.form?.requestSubmit();
  }

  return (
    <>
      <select
        ref={selectRef}
        name="role"
        aria-label={`Role for ${email}`}
        defaultValue={currentRole}
        onChange={onChange}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
      >
        {roles.map((r) => (
          <option key={r.value} value={r.value} title={r.title}>
            {r.label}
          </option>
        ))}
      </select>

      <dialog
        ref={dialogRef}
        aria-labelledby={`${baseId}-title`}
        className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 max-w-md w-full text-[var(--color-fg)] backdrop:bg-black/50"
        onClick={(e) => {
          if (e.target === dialogRef.current) cancel();
        }}
        onCancel={(e) => {
          e.preventDefault();
          cancel();
        }}
      >
        <h2 id={`${baseId}-title`} className="text-base font-semibold">
          Change {email} to {picked?.label ?? next}?
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted-fg)]">{picked?.consequence ?? ''}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
          >
            Change role
          </button>
        </div>
      </dialog>
    </>
  );
}
