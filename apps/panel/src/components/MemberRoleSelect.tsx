'use client';

/**
 * Workspace member role picker that confirms before changing.
 *
 * Rendered inside a server-action <form action={changeRole.bind(null, id)}>.
 * The previous version auto-submitted on every `change`, so a misclick could
 * silently promote someone to OWNER. This requires an explicit confirm (with
 * an extra warning when granting OWNER) and reverts the select on cancel.
 */

import * as React from 'react';
import { ROLE_SUMMARY, roleLabel, type WorkspaceRole } from '@/lib/workspace-roles';

const CONSEQUENCE: Record<WorkspaceRole, string> = {
  OWNER: 'Owners control billing, other owners and can delete the workspace. Only choose this for people you fully trust.',
  ADMIN: 'Admins can see and change every app and invite members.',
  MEMBER: 'Members only see the apps you give them on the App access tab, so check that after this change.',
};

export function MemberRoleSelect({
  email,
  currentRole,
  roles,
}: {
  email: string;
  currentRole: string;
  /** The roles the signed-in operator may hand out. */
  roles: readonly WorkspaceRole[];
}): React.JSX.Element {
  const dialogRef = React.useRef<HTMLDialogElement | null>(null);
  const selectRef = React.useRef<HTMLSelectElement | null>(null);
  const [next, setNext] = React.useState<string | null>(null);
  const baseId = React.useId();

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
          <option key={r} value={r} title={ROLE_SUMMARY[r]}>
            {roleLabel(r)}
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
      >
        <h2 id={`${baseId}-title`} className="text-base font-semibold">
          Make {email} {next === 'MEMBER' ? 'a member' : `an ${roleLabel(next ?? '').toLowerCase()}`}?
        </h2>
        <p className="mt-1 text-sm text-[var(--color-muted-fg)]">
          {next ? CONSEQUENCE[next as WorkspaceRole] : ''}
        </p>
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
