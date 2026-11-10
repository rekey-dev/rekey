'use client';

/**
 * A password input for a new password, with a show-password toggle inside its
 * right edge and its rule underneath.
 * Without JavaScript the toggle does nothing and the field stays hidden.
 */

import * as React from 'react';

export function ChoosePasswordField({
  minLength,
  name = 'newPassword',
  label = 'New password',
  autoFocus = true,
  error,
}: {
  minLength: number;
  name?: string;
  label?: string;
  autoFocus?: boolean;
  /** A refusal of the password the server returned, shown under the field. */
  error?: string | undefined;
}): React.JSX.Element {
  const [shown, setShown] = React.useState(false);
  const inputId = React.useId();
  const ruleId = React.useId();
  const errorId = React.useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-[var(--color-fg)]">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          name={name}
          type={shown ? 'text' : 'password'}
          required
          autoFocus={autoFocus || !!error}
          minLength={minLength}
          autoComplete="new-password"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${errorId} ${ruleId}` : ruleId}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-3 pr-32 text-sm"
        />
        <button
          type="button"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 rounded-md px-3 text-xs text-[var(--color-muted-fg)] underline hover:text-[var(--color-fg)]"
        >
          Show password
        </button>
      </div>
      {error && (
        <p id={errorId} className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <p id={ruleId} className="text-xs text-[var(--color-muted-fg)]">
        At least {minLength} characters. Some accounts ask for more.
      </p>
    </div>
  );
}
