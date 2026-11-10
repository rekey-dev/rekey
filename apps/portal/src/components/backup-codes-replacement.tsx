'use client';

/**
 * Get new backup codes: ask for a current authenticator code, then show the
 * new codes once. They live only in this component's state, from the action
 * response that minted them.
 */

import * as React from 'react';
import type { BackupCodesResult } from '@/lib/two-factor-actions';
import { Banner } from './banner';
import { SubmitButton } from './submit-button';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';

export function BackupCodesReplacement({
  replace,
}: {
  replace: (formData: FormData) => Promise<BackupCodesResult>;
}): React.JSX.Element {
  const [codes, setCodes] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<{ message: string } | null>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  if (codes) {
    return (
      <section aria-labelledby="new-backup-codes-heading" className="space-y-3">
        <h3 id="new-backup-codes-heading" className="text-sm font-semibold text-[var(--color-fg)]">
          Your new backup codes
        </h3>
        <p className={mutedCls}>
          Your old backup codes no longer work. Each of these signs you in once if you lose your authenticator app. They
          are shown only now, so store them somewhere safe.
        </p>
        <ol className="grid grid-cols-2 gap-2 rounded-md border border-[var(--color-border)] p-3 font-mono text-sm text-[var(--color-fg)]">
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium text-[var(--color-fg)]">Get new backup codes</summary>
      {error && (
        <div ref={errorRef} tabIndex={-1} className="outline-none">
          <Banner tone="error">{error.message}</Banner>
        </div>
      )}
      <form
        action={async (formData) => {
          const result = await replace(formData);
          if (result.ok) setCodes(result.backupCodes);
          else setError({ message: result.message });
        }}
        className="space-y-3"
      >
        <p className={mutedCls}>
          Your current backup codes stop working and you get ten new ones. Confirm with the code your authenticator app
          shows now. A backup code does not work here.
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-[var(--color-fg)]">6-digit code from your app</span>
          <input
            name="code"
            type="text"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            className={inputCls}
          />
        </label>
        <SubmitButton variant="secondary" pendingLabel="Getting codes…">
          Get new backup codes
        </SubmitButton>
      </form>
    </details>
  );
}
