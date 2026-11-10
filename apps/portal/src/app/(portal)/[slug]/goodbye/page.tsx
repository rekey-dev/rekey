import * as React from 'react';
import { notFound } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';

export default async function GoodbyePage({ params }: { params: Promise<{ slug: string }> }): Promise<React.JSX.Element> {
  const { slug } = await params;
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const appName = config.branding.displayName || config.name;
  return (
    <div className="mx-auto max-w-sm space-y-3 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Your account was deleted</h1>
      <p role="status" className="text-sm text-[var(--color-muted-fg)]">
        Your {appName} account is gone and you are signed out everywhere. Thank you for using {appName}.
      </p>
    </div>
  );
}
