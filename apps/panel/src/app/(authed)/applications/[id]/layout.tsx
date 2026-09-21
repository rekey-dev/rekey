import * as React from 'react';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { AppNav } from '@/components/AppNav';
import { Breadcrumb } from '@/components/Breadcrumb';
import { CopyButton } from '@/components/CopyButton';
import { EnvironmentBadge } from '@/components/EnvironmentBadge';
import { Banner } from '@/components/Banner';

export default async function ApplicationDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const app = await getApplication(id);

  return (
    <section className="mx-auto max-w-7xl space-y-5 px-6 py-8 lg:px-8">
      {/* This header used to run the name, the environment badge, the slug and a
          36-character public key along ONE baseline-aligned row. The key is by
          a wide margin the longest string on that line, so it took the eye
          first and the application's own name, the thing that tells you which
          application you are about to change, read as a prefix to it.

          Two clusters instead: identity left, the identifiers you copy right.
          Nothing is hidden and nothing is newly truncated; they have simply
          stopped competing for the same slot. */}
      <header className="space-y-2">
        <Breadcrumb
          items={[{ label: 'Applications', href: '/applications' }, { label: app.name }]}
        />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
              {app.name}
            </h1>
            {/* In the identity row rather than on a settings tab: it is what the
                application IS. It is now promotable (once, one-way) from the
                Lifecycle tab, but it is still not a field you edit in place. */}
            <EnvironmentBadge environment={app.environment} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-[var(--color-muted-fg)]">{app.slug}</span>
            <span aria-hidden="true" className="text-[var(--color-faint-fg)]">
              ·
            </span>
            {/* --color-muted-fg, not --color-faint-fg: this is a value the
                operator is meant to read off the screen and copy, and faint put
                it at 3.72:1 (rgb(107,107,107) on #0a0a0a) at 12px, below AA for
                a string where one wrong character is a silent auth failure.
                Muted measures 7.85:1 on the same background.

                Still not ellipsised, for the same reason. Moving it off the
                title's line is what buys it room; shortening it would trade one
                legibility problem for another. */}
            <span className="font-mono text-xs text-[var(--color-muted-fg)]">{app.publicKey}</span>
            <CopyButton value={app.publicKey} label="Copy" />
          </div>
        </div>
      </header>

      <AppNav
        id={id}
        billingEnabled={app.billingConfig.enabled}
        scopes={app.access?.scopes ?? null}
      />

      {/* In the LAYOUT, not on one page. A disabled application looks entirely
          normal on every tab, the plans are there, the end-users are there,
          the keys are there, and an operator debugging "why is sign-in
          failing" would otherwise have to guess to visit Lifecycle. It renders
          above the tab content on all of them. */}
      {app.disabledAt != null && (
        <Banner tone="warning">
          <strong>This application is disabled</strong> and is refusing all end-user requests.
          Everything below is intact and unchanged.{' '}
          <Link href={`/applications/${id}/lifecycle`} className="underline underline-offset-2">
            Enable it
          </Link>{' '}
          to resume traffic.
        </Banner>
      )}

      <div>{children}</div>
    </section>
  );
}
