'use client';

/**
 * Operator passkey sign-in (login page).
 *
 * Mirrors PasskeyRegisterButton but for authentication: the server actions
 * hand us the assertion options + expectedChallenge, we drive the authenticator
 * via @simplewebauthn/browser, then post the assertion back. `complete` mints a
 * session server-side (sets cookies + redirects), so success navigates away;
 * only client-side ceremony errors (user cancel, no credential) surface inline.
 */

import * as React from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { isRedirectError } from '@/lib/redirect-error';

type OptionsJSON = Parameters<typeof startAuthentication>[0]['optionsJSON'];

type StartResult =
  | { ok: true; options: Record<string, unknown>; expectedChallenge: string }
  | { ok: false; message: string };

interface Props {
  /** Server action: begins the ceremony, returns assertion options. */
  start: () => Promise<StartResult>;
  /** Server action: verifies the assertion, mints the session, redirects. */
  complete: (formData: FormData) => Promise<void>;
}

export function PasskeyLoginButton({ start, complete }: Props): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async (): Promise<void> => {
    setErr(null);
    setPending(true);
    try {
      const started = await start();
      if (!started.ok) {
        setErr(started.message);
        return;
      }
      const response = await startAuthentication({
        optionsJSON: started.options as unknown as OptionsJSON,
      });
      const fd = new FormData();
      fd.set('response', JSON.stringify(response));
      fd.set('expectedChallenge', started.expectedChallenge);
      // Redirects on success; on a server-side failure it redirects back to
      // /login?error=… which the page renders.
      await complete(fd);
    } catch (e: unknown) {
      // Success (and the server-side error path) redirect — Next surfaces that
      // as a NEXT_REDIRECT error here. Re-throw so navigation proceeds instead
      // of flashing "NEXT_REDIRECT" in the inline error box.
      if (isRedirectError(e)) throw e;
      const msg =
        e instanceof Error && e.message
          ? e.message
          : 'Passkey sign-in was cancelled or failed.';
      setErr(msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-60 transition-colors"
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        {pending ? 'Waiting for authenticator…' : 'Sign in with a passkey'}
      </button>
      {err && (
        <p
          role="alert"
          className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {err}
        </p>
      )}
    </div>
  );
}
