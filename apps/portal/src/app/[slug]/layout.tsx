import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getPortalConfig, safeCssColor } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { signOutAction } from '@/lib/actions';

export default async function SlugLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const session = await getPortalUser(slug);

  const b = config.branding;
  const title = b.displayName || config.name;
  // The operator's branding drives the portal's CSS tokens. Only the colors they
  // actually set are overridden, so the clean neutral default (globals.css)
  // stands for any token left blank.
  const vars: Record<string, string> = {};
  const primary = safeCssColor(b.primaryColor);
  const background = safeCssColor(b.backgroundColor);
  const surface = safeCssColor(b.surfaceColor);
  if (primary) vars['--color-primary'] = primary;
  if (background) vars['--color-bg'] = background;
  if (surface) vars['--color-surface'] = surface;
  const brandStyle = Object.keys(vars).length ? (vars as React.CSSProperties) : undefined;

  return (
    // Full-bleed wrapper so a custom --color-bg paints the whole viewport, not
    // just the centered column. Brand tokens cascade to every child.
    <div className="min-h-screen bg-[var(--color-bg)]" style={brandStyle}>
      <div className="mx-auto max-w-3xl px-5 py-8">
        <header className="mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            {b.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.logoUrl} alt="" className="h-7 w-7 rounded object-contain" />
            )}
            <div className="leading-tight">
              <span className="block text-base font-semibold text-[var(--color-fg)]">{title}</span>
              {b.tagline && <span className="block text-xs text-[var(--color-muted-fg)]">{b.tagline}</span>}
            </div>
          </div>
          {session && (
            <div className="flex items-center gap-3 text-sm text-[var(--color-muted-fg)]">
              <span className="hidden sm:inline">{session.user.email}</span>
              <form action={signOutAction.bind(null, slug)}>
                <button
                  type="submit"
                  className="rounded-md border border-[var(--color-border)] px-2.5 py-1 hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]"
                >
                  Sign out
                </button>
              </form>
            </div>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
