import * as React from 'react';
import { safeHttpUrl, type PortalBranding } from '@/lib/config';

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--color-fg)]">
      {children}
    </a>
  );
}

/** The operator's terms and privacy policy, under the create button, when they set either. */
export function SignUpAgreement({ branding }: { branding: PortalBranding }): React.JSX.Element | null {
  const terms = safeHttpUrl(branding.termsUrl);
  const privacy = safeHttpUrl(branding.privacyUrl);
  if (!terms && !privacy) return null;
  return (
    <p className="text-xs text-[var(--color-muted-fg)]">
      By creating an account you agree to the{' '}
      {terms && <ExternalLink href={terms}>Terms of service</ExternalLink>}
      {terms && privacy && ' and the '}
      {privacy && <ExternalLink href={privacy}>Privacy policy</ExternalLink>}.
    </p>
  );
}
