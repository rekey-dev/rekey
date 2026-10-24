import * as React from 'react';
import { SubmitButton } from './SubmitButton';

/**
 * What the `rekey` provider is called on the button. A deployment signing its
 * operators in against its own Application knows the brand; nothing else does,
 * so this is configurable and falls back to something honest rather than
 * guessing a name.
 */
const PANEL_OAUTH_REKEY_LABEL = process.env.NEXT_PUBLIC_PANEL_OAUTH_REKEY_LABEL || 'your account';

export const PROVIDER_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
  // Operator sign-in against one of this deployment's own Applications. The
  // label names the site the operator already has an account on, which is the
  // only thing that makes the button meaningful, "Continue with Rekey" on
  // Rekey's own panel would say nothing.
  rekey: `Continue with ${PANEL_OAUTH_REKEY_LABEL}`,
};

export function OAuthButton({ provider, label }: { provider: string; label: string }): React.JSX.Element {
  return (
    <SubmitButton
      pendingLabel="Redirecting…"
      className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <ProviderIcon provider={provider} />
      {label}
    </SubmitButton>
  );
}

function ProviderIcon({ provider }: { provider: string }): React.JSX.Element | null {
  if (provider === 'google') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.26.8-.57v-2c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.77-1.34-1.77-1.1-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.84 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.8 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .31.2.68.81.57A12 12 0 0 0 12 .5z" />
      </svg>
    );
  }
  return null;
}
