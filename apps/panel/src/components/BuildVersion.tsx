import * as React from 'react';
import { getApiBuildInfo } from '@/lib/api';
import { panelBuild, versionLine } from '@/lib/build-info';

/** Fixed height, so the line arriving (or not) never moves the sidebar footer. */
const ROW = 'h-4 truncate text-[11px] leading-4 text-[var(--color-faint-fg)] tabular-nums';

/**
 * The muted "Rekey v2.2.0 · a1b2c3d" line at the foot of the sidebar. Render
 * inside `<Suspense fallback={<BuildVersionPlaceholder />}>` so a slow API
 * never holds up the page.
 */
export async function BuildVersion(): Promise<React.JSX.Element> {
  const line = versionLine(panelBuild(), await getApiBuildInfo());
  return (
    <p className={ROW} title={line ?? undefined}>
      {line}
    </p>
  );
}

export function BuildVersionPlaceholder(): React.JSX.Element {
  return <p className={ROW} aria-hidden="true" />;
}
