'use client';

/**
 * New-password + "confirm" pair with live mismatch feedback.
 *
 * A single password box on a recovery form is a trap: one typo and the operator
 * locks themselves out of the very account they're recovering, with no way to
 * discover the password they actually set. The confirm field catches that before
 * submit; the server action re-checks (never trust the client) and redirects
 * back with `error=mismatch`.
 *
 * Deliberately does NOT disable the submit button. An earlier version reached
 * into `form.elements` from an effect to toggle `disabled` + classes, which
 * fights React for ownership of a button it doesn't render — fragile the moment
 * submission stops always ending in a redirect. Inline feedback plus the
 * server's own re-check (which preserves the reset token on the bounce-back) is
 * both simpler and safe with JS disabled.
 *
 * Inputs stay uncontrolled so password-manager autofill works. ARIA: the
 * confirm input carries `aria-invalid` + a stable `aria-describedby` pointing
 * at the status line.
 */

import * as React from 'react';

const STATUS_ID = 'password-confirm-status';

export function PasswordConfirmFields({
  inputClassName,
  minLength = 8,
}: {
  inputClassName?: string;
  minLength?: number;
}): React.JSX.Element {
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">New password</span>
        <input
          type="password"
          name="newPassword"
          required
          autoFocus
          minLength={minLength}
          autoComplete="new-password"
          placeholder={`at least ${minLength} characters`}
          onChange={(e) => setPassword(e.currentTarget.value)}
          className={inputClassName}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Confirm new password</span>
        <input
          type="password"
          name="confirmPassword"
          required
          autoComplete="new-password"
          placeholder="type it again"
          onChange={(e) => setConfirm(e.currentTarget.value)}
          className={inputClassName}
          aria-invalid={mismatch || undefined}
          aria-describedby={STATUS_ID}
        />
        {mismatch ? (
          <span id={STATUS_ID} role="alert" className="block text-xs text-red-600 dark:text-red-400">
            × Both passwords must match.
          </span>
        ) : (
          <span id={STATUS_ID} className="block text-xs text-[var(--color-muted-fg)]">
            Typed twice so a typo can&apos;t lock you out.
          </span>
        )}
      </label>
    </>
  );
}
