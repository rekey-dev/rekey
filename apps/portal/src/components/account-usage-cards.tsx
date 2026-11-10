/**
 * The dashboard's read-only cards for what the customer's plans give them.
 * Each renders nothing when it has nothing to show.
 */

import * as React from 'react';
import { DEVICE_LIMIT_FEATURE_KEY, type ResolvedEntitlementsDto, type UsageRemainingDto } from '@rekey.dev/shared-types';
import type { CreditLedgerEntry } from '@/lib/account-usage';
import { creditReasonWord, featureLabel, featureValue, signedCredits, usageLine } from '@/lib/account-usage-copy';
import { Card } from './card';

const headingCls = 'mb-3 text-sm font-semibold text-[var(--color-fg)]';
const linkCls = 'underline hover:text-[var(--color-fg)]';

export function EntitlementsCard({
  entitlements,
  locale,
  devicesHref,
}: {
  entitlements: ResolvedEntitlementsDto | null;
  locale: string;
  /** Where the device limit links, when the application lists devices. */
  devicesHref: string | null;
}): React.JSX.Element | null {
  const features = Object.entries(entitlements?.features ?? {});
  if (features.length === 0) return null;
  return (
    <Card>
      <h2 className={headingCls}>What your plan includes</h2>
      <dl className="divide-y divide-[var(--color-border)] text-sm">
        {features.map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-3 py-2">
            <dt className="text-[var(--color-muted-fg)]">{featureLabel(key)}</dt>
            <dd className="text-right text-[var(--color-fg)]">
              {featureValue(value, locale)}
              {key === DEVICE_LIMIT_FEATURE_KEY && devicesHref && (
                <>
                  {' · '}
                  <a href={devicesHref} className={`text-[var(--color-muted-fg)] ${linkCls}`}>
                    Manage devices
                  </a>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function UsageCard({
  usage,
  locale,
  dateOf,
}: {
  usage: UsageRemainingDto | null;
  locale: string;
  dateOf: (value: string) => string;
}): React.JSX.Element | null {
  const meters = (usage?.meters ?? []).filter((m) => m.included !== null || m.used > 0);
  if (!usage || meters.length === 0) return null;
  return (
    <Card>
      <h2 className={headingCls}>Usage this period</h2>
      <ul className="space-y-4 text-sm">
        {meters.map((meter) => {
          const line = usageLine(meter, locale);
          const share = meter.included ? Math.min(100, Math.round((meter.used / meter.included) * 100)) : null;
          return (
            <li key={meter.meterSlug} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-[var(--color-fg)]">{meter.name}</span>
                <span className="text-right text-[var(--color-fg)]">{line}</span>
              </div>
              {share !== null && meter.included !== null && (
                <div
                  role="meter"
                  aria-label={meter.name}
                  aria-valuemin={0}
                  aria-valuemax={meter.included}
                  aria-valuenow={Math.min(meter.used, meter.included)}
                  aria-valuetext={line}
                  className="h-2 overflow-hidden rounded-full bg-[var(--color-border)]"
                >
                  <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${share}%` }} />
                </div>
              )}
              <p className="text-xs text-[var(--color-muted-fg)]">Resets on {dateOf(meter.periodEnd)}.</p>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function CreditsCard({
  balance,
  ledger,
  locale,
  dateOf,
}: {
  balance: number | null;
  ledger: CreditLedgerEntry[] | null;
  locale: string;
  dateOf: (value: string) => string;
}): React.JSX.Element | null {
  const entries = ledger ?? [];
  if (balance === null || (balance === 0 && entries.length === 0)) return null;
  return (
    <Card>
      <h2 className={headingCls}>Credits</h2>
      <p className="text-sm text-[var(--color-fg)]">
        Balance: <span className="font-medium tabular-nums">{balance.toLocaleString(locale)}</span>
      </p>
      {entries.length > 0 && (
        <table className="mt-3 w-full table-fixed text-sm">
          <caption className="sr-only">Recent credit changes</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Change</th>
              <th scope="col">Credits</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="py-2 pr-3">
                  <span className="block text-[var(--color-fg)]">{e.description ?? creditReasonWord(e.reason)}</span>
                  <span className="block text-xs text-[var(--color-muted-fg)]">{dateOf(e.createdAt)}</span>
                </td>
                <td className="w-24 py-2 text-right tabular-nums text-[var(--color-fg)]">{signedCredits(e.delta, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
