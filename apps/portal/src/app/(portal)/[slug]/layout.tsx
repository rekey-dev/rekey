import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { brandTokens, followsColorScheme, safeHttpUrl, supportLink } from '@/lib/config';
import { getPortalConfigOrRefresh, getPortalUser } from '@/lib/session';
import { signOutAction } from '@/lib/actions';
import { portalNav } from '@/lib/portal-nav';
import { Button } from '@/components/button';
import { NavLink } from '@/components/nav-link';

// Tab title carries the merchant's brand, the only name a customer knows.
// The config lookup is React-cached, so the layout render reuses this fetch.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const config = await getPortalConfigOrRefresh(slug);
  if (!config) return {};
  const appName = config.branding.displayName || config.name;
  return { title: `${appName} customer portal` };
}

function FooterLink({ href, children }: { href: string; children: ReactNode }): React.JSX.Element {
  return (
    <a
      href={href}
      className="underline hover:text-[var(--color-fg)]"
      {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

export default async function SlugLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const config = await getPortalConfigOrRefresh(slug);
  if (!config) notFound();
  const session = await getPortalUser(slug);

  const b = config.branding;
  const title = b.displayName || config.name;
  const logoUrl = safeHttpUrl(b.logoUrl);
  const supportHref = supportLink(b);
  const termsHref = safeHttpUrl(b.termsUrl);
  const privacyHref = safeHttpUrl(b.privacyUrl);
  const vars = brandTokens(b);
  const brandStyle = Object.keys(vars).length ? (vars as React.CSSProperties) : undefined;
  const nav = session ? portalNav(slug, config, session) : [];

  return (
    // Full-bleed wrapper so a custom --color-bg paints the whole viewport, not
    // just the centered column. Brand tokens cascade to every child.
    <div
      className="min-h-screen bg-[var(--color-bg)] text-[var(--color-fg)]"
      style={brandStyle}
      data-scheme={followsColorScheme(b) ? 'auto' : 'light'}
    >
      <div className="mx-auto max-w-3xl px-4 py-6 sm:px-5 sm:py-8">
        <header className="mb-8 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <a href={`/${slug}`} className="flex min-w-0 items-center gap-2.5 rounded-md">
              {logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-7 w-auto max-w-[160px] flex-none rounded object-contain"
                />
              )}
              <div className="min-w-0 leading-tight">
                <span className="block truncate text-base font-semibold text-[var(--color-fg)]">{title}</span>
                {b.tagline && <span className="block truncate text-xs text-[var(--color-muted-fg)]">{b.tagline}</span>}
              </div>
            </a>
            {session && (
              <div className="flex min-w-0 items-center gap-3 text-sm text-[var(--color-muted-fg)]">
                <span className="min-w-0 max-w-[40vw] truncate sm:max-w-[16rem]" title={session.user.email}>
                  {session.user.email}
                </span>
                <form action={signOutAction.bind(null, slug)} className="flex-none">
                  <Button type="submit" variant="secondary">
                    Sign out
                  </Button>
                </form>
              </div>
            )}
          </div>
          {nav.length > 0 && (
            <nav aria-label="Account sections" className="-mx-1 overflow-x-auto">
              <ul className="flex gap-1 px-1">
                {nav.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href} exact={item.exact}>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </header>
        <main>{children}</main>
        {(supportHref || termsHref || privacyHref) && (
          <footer className="mt-10 flex flex-wrap gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-muted-fg)]">
            {supportHref && (
              <span>
                Need help? <FooterLink href={supportHref}>Contact support</FooterLink>
              </span>
            )}
            {termsHref && <FooterLink href={termsHref}>Terms</FooterLink>}
            {privacyHref && <FooterLink href={privacyHref}>Privacy</FooterLink>}
          </footer>
        )}
      </div>
    </div>
  );
}
