/**
 * Banner shown when a backing service the API depends on is unreachable.
 *
 * Why this exists: the brute-force store now fails closed, so credential paths
 * answer 503 rather than running unprotected. That means a Redis outage shows up
 * to end users as sign-in failures, and before this nothing told the operator
 * why — the only signal was a super-admin services page they had to think to
 * open, on a deployment they might not even run.
 *
 * Reads `/health/ready`, which reports `db` and `redis` separately. Cached
 * briefly so a burst of navigations shares one probe.
 *
 * Renders nothing on the happy path, nothing when Redis is merely
 * `not_configured` (a legitimate dev setup, not an incident), and nothing if the
 * probe itself fails. Losing the banner is an acceptable failure; taking every
 * authed page down with it is not.
 */

import * as React from 'react';
import { getReadyReport } from '@/lib/api';

/** Cached so several server components in one render share a single probe. */
const readReady = React.cache(getReadyReport);

const LABEL = { db: 'The database', redis: 'Redis' } as const;

export async function DependencyBanner(): Promise<React.JSX.Element | null> {
  const ready = await readReady();
  if (!ready) return null;

  // `not_configured` is not an outage — it is what a dev stack without Redis
  // reports, and flagging it would train operators to ignore this banner.
  const down = (['db', 'redis'] as const).filter((k) => ready[k] === 'unreachable');
  if (down.length === 0) return null;

  const names = down.map((k) => LABEL[k]).join(' and ');

  return (
    <div
      role="status"
      className="border-b border-amber-300 bg-amber-50 px-6 py-2.5 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <span className="font-medium">
        {names} {down.length > 1 ? 'are' : 'is'} unreachable.
      </span>{' '}
      {down.includes('redis') ? (
        <>
          Sign-in and other credential endpoints are refusing requests on purpose
          rather than running without brute-force protection. Restore Redis to
          clear this.
        </>
      ) : (
        <>Most of the API cannot serve requests until this is restored.</>
      )}
    </div>
  );
}
