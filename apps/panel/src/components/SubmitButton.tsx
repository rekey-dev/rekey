'use client';

/**
 * Form submit button with in-flight pending state.
 *
 * Pending state comes from `useActionPending`: the owning `ActionForm`'s
 * own transition when there is one, and React's `useFormStatus()` otherwise.
 * See `ActionForm.tsx` for why reading React's pending state alone is not
 * safe here. On submit, we flip `disabled=true` and swap the label to
 * `pendingLabel` so:
 *   - the user gets immediate feedback that something is happening
 *   - double-clicks are blocked at the DOM level (no duplicate POSTs)
 *
 * The server-action redirect pattern means the page eventually re-renders,
 * but for anything from 100ms to 2s the user has no signal. This component
 * is the canonical fix.
 *
 * @example
 * ```tsx
 * <ActionForm action={createPlan}>
 *   <input name="slug" />
 *   <SubmitButton>Create plan</SubmitButton>
 * </ActionForm>
 * ```
 */

import * as React from 'react';
import { useActionPending } from './ActionForm';

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
  const pending = useActionPending();
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
