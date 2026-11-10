'use client';

/**
 * A labelled password input with a show toggle inside its right edge and an
 * optional rule under it.
 * Without JavaScript the toggle does nothing and the field stays hidden.
 */

import * as React from 'react';

export function PasswordField({
  name,
  label,
  autoComplete,
  rule,
  minLength,
}: {
  name: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  rule?: string;
  minLength?: number;
}): React.JSX.Element {
  const [shown, setShown] = React.useState(false);
  const inputId = React.useId();
  const ruleId = React.useId();
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
          autoComplete={autoComplete}
          {...(minLength !== undefined && { minLength })}
          {...(rule && { 'aria-describedby': ruleId })}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-3 pr-16 text-sm"
        />
        <button
          type="button"
          aria-pressed={shown}
          aria-label={`Show ${label.toLowerCase()}`}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 rounded-md px-3 text-xs text-[var(--color-muted-fg)] underline hover:text-[var(--color-fg)]"
        >
          Show
        </button>
      </div>
      {rule && (
        <p id={ruleId} className="text-xs text-[var(--color-muted-fg)]">
          {rule}
        </p>
      )}
    </div>
  );
}
