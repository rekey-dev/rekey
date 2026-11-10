import * as React from 'react';
import { CopyButton } from './CopyButton';

/**
 * "Offer in the hosted portal" for one sign-in provider, with the portal page
 * to register in the provider's console. Shown only while the hosted portal is
 * on; otherwise a saved choice is carried through the form unchanged.
 */
export function OAuthPortalOption({
  providerLabel,
  portalUrls,
  offered,
  singleCallbackHost,
}: {
  providerLabel: string;
  /** From `portalSignInUrls`; empty while the portal is off. */
  portalUrls: string[];
  offered: boolean;
  singleCallbackHost: boolean;
}): React.JSX.Element | null {
  if (portalUrls.length === 0) {
    return offered ? <input type="hidden" name="hostedPortal" value="on" /> : null;
  }
  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] px-3 py-2">
      <label className="flex items-center gap-2 text-xs font-medium text-[var(--color-fg)]">
        <input type="checkbox" name="hostedPortal" defaultChecked={offered} />
        Offer in the hosted portal
      </label>
      <p className="text-xs text-[var(--color-muted-fg)]">
        Add {portalUrls.length === 1 ? 'this redirect URI' : 'these redirect URIs'} in the {providerLabel} console
        first, next to your app&apos;s own. Until it is listed there, customers who press the button land on an error
        page at {providerLabel}.
      </p>
      {portalUrls.map((url) => (
        <p key={url} className="flex items-center gap-2 text-xs">
          <code className="truncate font-mono text-[0.7rem] text-[var(--color-fg)]">{url}</code>
          <CopyButton value={url} label="Copy" />
        </p>
      ))}
      {singleCallbackHost && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          A {providerLabel} OAuth App allows a single callback host, and this page holds one {providerLabel} app per
          Application, so the portal would need a second OAuth App that Rekey cannot store yet. Keep this off unless
          this OAuth App calls back to the portal.
        </p>
      )}
    </div>
  );
}
