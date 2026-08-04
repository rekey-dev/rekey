import * as React from 'react';
import Link from 'next/link';
import { getApplication } from '@/lib/api';
import { AppNav } from '@/components/AppNav';
import { CopyButton } from '@/components/CopyButton';
import { EnvironmentBadge } from '@/components/EnvironmentBadge';

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
      <header className="space-y-1.5">
        <Link
          href="/applications"
          className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          ← All applications
        </Link>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">{app.name}</h1>
          {/* Fixed at creation, so it belongs in the identity row next to the
              slug rather than on a settings tab that implies it is editable. */}
          <EnvironmentBadge environment={app.environment} />
          <span className="font-mono text-xs text-[var(--color-muted-fg)]">{app.slug}</span>
          {/* --color-muted-fg, not --color-faint-fg: this is a value the
              operator is meant to read off the screen and copy, and faint put
              it at 3.72:1 (rgb(107,107,107) on #0a0a0a) at 12px — below AA for
              a string where one wrong character is a silent auth failure.
              Muted measures 7.85:1 on the same background. */}
          <span title={app.publicKey} className="max-w-7xl truncate font-mono text-xs text-[var(--color-muted-fg)]">
            {app.publicKey}
          </span>
          <CopyButton value={app.publicKey} label="Copy" />
        </div>
      </header>

      <AppNav id={id} billingEnabled={app.billingConfig.enabled} />

      <div>{children}</div>
    </section>
  );
}
