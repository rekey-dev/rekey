'use client';

import * as React from 'react';
import { apexesWithoutWildcard } from '@/lib/blocked-domains';

const SHOWN = 3;

/** The blocked-domains textarea, with a note for each apex listed without its `*.` twin. */
export function BlockedDomainsInput({
  defaultValue,
  className,
}: {
  defaultValue: string;
  className: string;
}): React.JSX.Element {
  const [apexes, setApexes] = React.useState(() => apexesWithoutWildcard(defaultValue));
  const first = apexes[0];
  const more = apexes.length - SHOWN;

  return (
    <>
      <textarea
        name="blockedDomains"
        rows={3}
        defaultValue={defaultValue}
        placeholder={'competitor.com\n*.competitor.com'}
        className={className}
        aria-describedby={first ? 'blocked-apex-note' : undefined}
        onChange={(e) => setApexes(apexesWithoutWildcard(e.currentTarget.value))}
      />
      {first && (
        <p id="blocked-apex-note" className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
          {apexes.slice(0, SHOWN).map((d, i) => (
            <React.Fragment key={d}>
              {i > 0 && ', '}
              <code>{d}</code>
            </React.Fragment>
          ))}
          {more > 0 && ` and ${more} more`}
          {apexes.length === 1
            ? ' blocks only that exact domain, so its subdomains can still sign up. Add '
            : ' block only those exact domains, so their subdomains can still sign up. Add '}
          <code>*.{first}</code>
          {apexes.length === 1 ? ' to block them too.' : ' and the same for each of the others to block them too.'}
        </p>
      )}
    </>
  );
}
