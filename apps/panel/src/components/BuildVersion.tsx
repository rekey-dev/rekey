import * as React from 'react';
import { getApiBuildInfo } from '@/lib/api';
import { panelBuild, versionBadge } from '@/lib/build-info';

const BADGE =
  'inline-flex h-5 items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 font-mono text-[10px] leading-none tabular-nums text-[var(--color-muted-fg)]';

/**
 * The version badge beside the logo, linking to that release's notes. Render
 * inside `<Suspense fallback={<BuildVersionPlaceholder />}>` so a slow API
 * never holds up the page.
 */
export async function BuildVersion(): Promise<React.JSX.Element> {
  const badge = versionBadge(panelBuild(), await getApiBuildInfo());
  return (
    <a
      href={badge.href}
      target="_blank"
      rel="noopener noreferrer"
      title={badge.title}
      aria-label={`${badge.title}. Release notes`}
      className={`${BADGE} hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]`}
    >
      {badge.mismatch && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-500" />}
      {badge.label}
    </a>
  );
}

/** Same height as the badge, so its arrival never shifts the sidebar. */
export function BuildVersionPlaceholder(): React.JSX.Element {
  return <span aria-hidden="true" className={`${BADGE} w-12`} />;
}
