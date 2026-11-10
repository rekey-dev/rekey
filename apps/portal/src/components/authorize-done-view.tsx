'use client';

/**
 * The done page's content. It tells the server to forget the target, then
 * sends the browser to the app. A custom scheme the system does not hand to
 * an app leaves the tab where it is, which is why the link to the same target
 * stays on screen.
 *
 * The first render's answer is kept in state: forgetting the target sets a
 * cookie, Next renders the page again without it, and the link must survive.
 */

import { useEffect, useRef, useState } from 'react';

export interface AuthorizeDoneShown {
  target: string;
  client: string | null;
  outcome: 'allowed' | 'cancelled';
}

export function AuthorizeDoneView({
  done,
  forget,
}: {
  done: AuthorizeDoneShown | null;
  forget: () => Promise<void>;
}): React.JSX.Element {
  const [shown] = useState(done);
  const opened = useRef(false);
  useEffect(() => {
    if (!shown || opened.current) return;
    opened.current = true;
    void forget()
      .catch(() => undefined)
      .finally(() => window.location.assign(shown.target));
  }, [shown, forget]);

  if (!shown) {
    return (
      <div className="mx-auto max-w-sm space-y-4 pt-10">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">This sign-in has finished</h1>
        <p role="status" className="text-sm text-[var(--color-muted-fg)]">
          You can close this tab. If the app did not open or is still waiting, start signing in from it again.
        </p>
      </div>
    );
  }

  const client = shown.client ?? 'the app';
  return (
    <div className="mx-auto max-w-sm space-y-4 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">
        {shown.outcome === 'allowed' ? 'You are signed in' : 'Sign-in cancelled'}
      </h1>
      <p role="status" className="text-sm text-[var(--color-muted-fg)]">
        {shown.outcome === 'allowed'
          ? `You can return to ${client} and close this tab.`
          : `Nothing was shared. You can return to ${client} and close this tab.`}
      </p>
      <p className="text-sm text-[var(--color-muted-fg)]">
        If {client} did not open:{' '}
        <a href={shown.target} className="underline hover:text-[var(--color-fg)]">
          Open {client}
        </a>
      </p>
    </div>
  );
}
