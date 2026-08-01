'use client';

/**
 * Form submit button with in-flight pending state.
 *
 * `useFormStatus` is a React hook available *inside* a form's children
 * tree — it reflects whether the surrounding form's `action` is currently
 * pending (server action in flight). On submit, we flip `disabled=true`
 * and swap the label to `pendingLabel` so:
 *   - the user gets immediate feedback that something is happening
 *   - double-clicks are blocked at the DOM level (no duplicate POSTs)
 *
 * UX-AUDIT-3 / item #6 + #14: the server-action redirect pattern means
 * the page eventually re-renders, but for 100ms–2s the user has no signal.
 * This component is the canonical fix.
 *
 * @example
 * ```tsx
 * <form action={createPlan}>
 *   <input name="slug" />
 *   <SubmitButton>Create plan</SubmitButton>
 * </form>
 * ```
 */

import * as React from 'react';
import { useFormStatus } from 'react-dom';

export interface SubmitButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'disabled'> {
  /** Label shown while the form is pending. Defaults to `"Saving…"`. */
  pendingLabel?: string;
}

export function SubmitButton({
  children,
  pendingLabel = 'Saving…',
  className,
  ...rest
}: SubmitButtonProps): React.JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={
        (className ??
          'rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:opacity-60 disabled:cursor-not-allowed') +
        ''
      }
      {...rest}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
