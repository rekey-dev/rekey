'use client';

import * as React from 'react';

/**
 * Passwordless sign-in. Posts the email to /api/auth/magic-link. With email
 * transport configured the link is mailed; without it (demo), the raw token
 * comes back and we render the sign-in link directly so the flow is testable.
 */
export function MagicLinkForm(): React.JSX.Element {
  const [email, setEmail] = React.useState('');
  const [msg, setMsg] = React.useState<React.ReactNode>(null);
  const [busy, setBusy] = React.useState(false);

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        magicLinkToken?: string | null;
        emailSent?: boolean;
        error?: { message?: string };
      };
      if (!res.ok) {
        setMsg(<span className="text-red-600">{json.error?.message ?? 'Could not send link.'}</span>);
        return;
      }
      if (json.magicLinkToken) {
        const href = `/api/auth/magic-link/verify?token=${encodeURIComponent(json.magicLinkToken)}`;
        setMsg(
          <span>
            No email transport configured —{' '}
            <a className="underline text-rekey-700 dark:text-rekey-500" href={href}>
              click here to sign in
            </a>
            .
          </span>,
        );
      } else {
        setMsg(<span className="text-rekey-700 dark:text-rekey-500">Magic link sent — check your inbox.</span>);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="card space-y-2">
      <div className="label">Or sign in with a magic link</div>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          autoComplete="email"
          className="field"
        />
        <button type="submit" disabled={busy} className="btn-ghost shrink-0">
          {busy ? 'Sending…' : 'Email link'}
        </button>
      </div>
      {msg && <p className="text-xs">{msg}</p>}
    </form>
  );
}
