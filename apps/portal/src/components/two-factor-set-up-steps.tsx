'use client';

/**
 * The two-factor setup steps: fetch a setup key, confirm a code, then show the
 * backup codes once. The key and codes live only in this component's state,
 * from the action response that minted them.
 */

import * as React from 'react';
import Link from 'next/link';
import type {
  TwoFactorConfirmResult,
  TwoFactorSetUp,
  TwoFactorStartResult,
} from '@/lib/two-factor-actions';
import { Banner } from './banner';
import { SubmitButton } from './submit-button';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm';
const headingCls = 'text-base font-semibold text-[var(--color-fg)]';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';

export function TwoFactorSetUpSteps({
  start,
  confirm,
  continueHref,
  intro,
}: {
  start: () => Promise<TwoFactorStartResult>;
  confirm: (formData: FormData) => Promise<TwoFactorConfirmResult>;
  continueHref: string;
  /** Shown before setup starts only, so a status such as "Off." never outlives the step it describes. */
  intro?: React.ReactNode;
}): React.JSX.Element {
  const [setUp, setSetUp] = React.useState<TwoFactorSetUp | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  // An object, so the same message twice still moves focus back to it.
  const [error, setError] = React.useState<{ message: string } | null>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const errorBanner = error && (
    <div ref={errorRef} tabIndex={-1} className="outline-none">
      <Banner tone="error">{error.message}</Banner>
    </div>
  );

  if (setUp && confirmed) {
    return (
      <section aria-labelledby="backup-codes-heading" className="space-y-4">
        <h2 id="backup-codes-heading" className={headingCls}>
          Save your backup codes
        </h2>
        <Banner tone="success">Two-factor authentication is on.</Banner>
        <p className={mutedCls}>
          If you lose your authenticator app, each of these codes signs you in once. They are shown only now, so store
          them somewhere safe.
        </p>
        <ol className="grid grid-cols-2 gap-2 rounded-md border border-[var(--color-border)] p-3 font-mono text-sm text-[var(--color-fg)]">
          {setUp.backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ol>
        <Link
          href={continueHref}
          className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2 text-center text-sm font-medium text-[var(--color-primary-fg)]"
        >
          I have saved these
        </Link>
      </section>
    );
  }

  if (setUp) {
    return (
      <div className="space-y-5">
        <section aria-labelledby="scan-heading" className="space-y-3">
          <h2 id="scan-heading" className={headingCls}>
            Add this account to your authenticator app
          </h2>
          <p className={mutedCls}>Scan the QR code with an authenticator app, or type the setup key into it.</p>
          {setUp.qrSvg && (
            <div
              role="img"
              aria-label="QR code for your authenticator app"
              className="inline-block rounded-md border border-[var(--color-border)] bg-white p-3"
              // The SVG is built by the qrcode library on the portal server from the API's otpauth URL; the library escapes its payload.
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: setUp.qrSvg }}
            />
          )}
          <p className={mutedCls}>
            Setup key: <code className="break-all font-mono text-[var(--color-fg)]">{setUp.setupKey}</code>
          </p>
          <p className={mutedCls}>
            <a href={setUp.otpauthUrl} className="underline hover:text-[var(--color-fg)]">
              Open in an authenticator app on this device
            </a>
          </p>
        </section>
        {errorBanner}
        <form
          action={async (formData) => {
            const result = await confirm(formData);
            if (result.ok) setConfirmed(true);
            else setError({ message: result.message });
          }}
          className="space-y-3"
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">6-digit code from your app</span>
            <input
              name="code"
              type="text"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className={inputCls}
            />
          </label>
          <SubmitButton pendingLabel="Checking…" className="w-full">
            Turn on two-factor
          </SubmitButton>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {intro}
      {errorBanner}
      <form
        action={async () => {
          const result = await start();
          if (result.ok) {
            setError(null);
            setSetUp(result.setUp);
          } else {
            setError({ message: result.message });
          }
        }}
      >
        <SubmitButton pendingLabel="Preparing…" className="w-full">
          Start setup
        </SubmitButton>
      </form>
    </div>
  );
}
