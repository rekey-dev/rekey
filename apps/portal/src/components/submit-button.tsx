'use client';

/**
 * Submit button that disables itself while its form's server action is in
 * flight, and says what it is doing.
 *
 * Every form in this portal posts to a server action over the network, and
 * none of them were guarded: the button stayed live for the whole round trip,
 * so a second click submitted again. On sign-in that is a wasted request; on
 * `checkoutAction` and `cancelSubscriptionAction` it is two checkout sessions
 * or a double cancel, from a customer who just thought the page had hung.
 *
 * `useFormStatus` reads the pending state of the nearest ancestor `<form>`,
 * which only works from a child component — hence the separate client
 * component rather than a prop on `<Button>`. Mirrors the panel's
 * `components/SubmitButton.tsx`.
 */

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from './button';

export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  className = '',
}: {
  children: ReactNode;
  /** Shown in place of `children` while the action runs. */
  pendingLabel: string;
  variant?: 'primary' | 'secondary';
  className?: string;
}): ReactNode {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      disabled={pending}
      aria-busy={pending || undefined}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
