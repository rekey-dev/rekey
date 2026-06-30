'use client';

import * as React from 'react';
import { useActionState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { mintInvite, type MintState } from './actions';

const INITIAL: MintState = { ok: false };

/**
 * Mint form + one-time key reveal. The raw key comes back in the action result
 * and is shown here exactly once — it is never re-fetchable, so we surface a
 * copy affordance and a clear "shown once" warning.
 */
export function MintInviteForm(): React.JSX.Element {
  const [state, formAction, pending] = useActionState(mintInvite, INITIAL);

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-[var(--color-muted-fg)]">Note (optional)</span>
          <input
            type="text"
            name="note"
            maxLength={200}
            placeholder="for jane@acme.com"
            className="w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
          />
        </label>
        <label className="space-y-1.5">
          <span className="block text-xs font-medium text-[var(--color-muted-fg)]">Expires in (days)</span>
          <input
            type="number"
            name="expiresInDays"
            min={1}
            max={365}
            placeholder="never"
            className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? 'Minting…' : 'Mint invite key'}
        </button>
      </form>

      {state.error && (
        <p role="alert" className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {state.error}
        </p>
      )}

      {state.ok && state.rawToken && (
        <div className="space-y-2 rounded-md border border-[var(--color-success)]/40 bg-[var(--color-success-soft)] px-3 py-3">
          <p className="text-sm font-medium text-[var(--color-success)]">
            Invite key minted — copy it now. It is shown once and cannot be recovered.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs text-[var(--color-fg)]">
              {state.rawToken}
            </code>
            <CopyButton value={state.rawToken} label="Copy invite key" />
          </div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Hand this to the operator you are inviting. They paste it on the panel sign-up page.
          </p>
        </div>
      )}
    </div>
  );
}
