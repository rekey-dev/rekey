import * as React from 'react';
import { resendVerificationAction } from '@/lib/actions';
import { SubmitButton } from './submit-button';

export function ResendVerificationForm({
  slug,
  from,
  email,
}: {
  slug: string;
  from: 'login' | 'link' | 'sign-up';
  email?: string | undefined;
}): React.JSX.Element {
  return (
    <form action={resendVerificationAction.bind(null, slug, from)} className="space-y-3">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
        <input
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          defaultValue={email}
          placeholder="you@example.com"
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
      </label>
      <SubmitButton pendingLabel="Sending…" className="w-full">
        Send a new confirmation link
      </SubmitButton>
    </form>
  );
}
