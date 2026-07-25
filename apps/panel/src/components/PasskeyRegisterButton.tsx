'use client';

/**
 * Operator passkey registration ceremony.
 *
 * Server-actions pass us the options + expectedChallenge; we drive the
 * authenticator via @simplewebauthn/browser then post the response back.
 * Stays a thin client glue layer — verification + persistence live on the
 * API side.
 */

import * as React from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { isRedirectError } from '@/lib/redirect-error';
import { Banner } from '@/components/Banner';

type OptionsJSON = Parameters<typeof startRegistration>[0]['optionsJSON'];

interface Props {
  /** Server action: returns the start payload. */
  start: () => Promise<StartResult>;
  /** Server action: posts the assertion + expectedChallenge + label. */
  complete: (formData: FormData) => Promise<void>;
}

type StartResult =
  | { ok: true; options: Record<string, unknown>; expectedChallenge: string }
  | { ok: false; code: string; message: string };

export function PasskeyRegisterButton({ start, complete }: Props): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');

  const run = async (): Promise<void> => {
    setErr(null);
    setPending(true);
    try {
      const started = await start();
      if (!started.ok) {
        setErr(started.message);
        return;
      }
      const { options, expectedChallenge } = started;
      const response = await startRegistration({ optionsJSON: options as unknown as OptionsJSON });
      const fd = new FormData();
      fd.set('response', JSON.stringify(response));
      fd.set('expectedChallenge', expectedChallenge);
      if (label.trim()) fd.set('deviceName', label.trim());
      await complete(fd);
    } catch (e: unknown) {
      // A redirect (e.g. revalidate + navigate on success) surfaces as a
      // NEXT_REDIRECT error — re-throw so it isn't shown as a failure.
      if (isRedirectError(e)) throw e;
      const msg =
        e instanceof Error && e.message
          ? e.message
          : 'Passkey registration was cancelled or failed.';
      setErr(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Device label (e.g. MacBook Pro)"
          maxLength={64}
          aria-label="Device label"
          disabled={pending}
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
        />
        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? 'Waiting for authenticator…' : 'Register passkey'}
        </button>
      </div>
      {err && (
        <Banner tone="error">
          {err}
        </Banner>
      )}
    </div>
  );
}
