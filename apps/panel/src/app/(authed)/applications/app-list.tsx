import * as React from 'react';
import Link from '@/components/Link';
import type { ApplicationRow } from '@/lib/api';
import { formatDate } from '@/lib/date';
import { hasScope } from '@/lib/operator-scopes';
import { EnvironmentBadge } from '@/components/EnvironmentBadge';
import { ApplicationStatusBadges, hasApplicationStatus } from '@/components/ApplicationStatusBadges';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatActiveDay } from './summary';

function keysLabel(app: ApplicationRow): string | null {
  const n = app.summary?.activeApiKeys;
  if (n === undefined) return null;
  if (n === 0) return 'No API key';
  return `${n} ${n === 1 ? 'key' : 'keys'}`;
}

function activeLabel(app: ApplicationRow): string | null {
  const day = app.summary?.lastActiveOn;
  if (day === undefined) return null;
  return day === null ? 'No activity yet' : formatActiveDay(day);
}

function Keys({ app }: { app: ApplicationRow }): React.JSX.Element {
  const n = app.summary?.activeApiKeys;
  if (n === undefined) return <span className="text-[var(--color-faint-fg)]">Hidden</span>;
  if (n > 0) return <span className="tabular-nums">{keysLabel(app)}</span>;
  const canMint = hasScope(app.access?.scopes ?? null, 'developer:write');
  return canMint && !app.disabledAt ? (
    <Link
      href={`/applications/${app.id}/api-keys`}
      className="relative z-10 inline-flex items-center gap-1 rounded text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
    >
      Mint a key
      <span aria-hidden="true">→</span>
    </Link>
  ) : (
    <span className="text-[var(--color-muted-fg)]">None</span>
  );
}

/**
 * The Applications list: a table from `md` up, stacked cards below it, so a
 * phone never scrolls sideways. Both read the same row fields; the table can
 * afford a link into API keys, while a card is one link as a whole.
 */
export function AppList({ apps }: { apps: ApplicationRow[] }): React.JSX.Element {
  const showKeys = apps.some((a) => a.summary?.activeApiKeys !== undefined);
  const showActive = apps.some((a) => a.summary?.lastActiveOn !== undefined);
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              <TH>Application</TH>
              <TH>Environment</TH>
              {showKeys && <TH>API keys</TH>}
              {showActive && <TH>Last active</TH>}
              <TH align="right">Created</TH>
            </TR>
          </THead>
          <TBody>
            {apps.map((a) => {
              const off = Boolean(a.disabledAt);
              return (
                <TR key={a.id} hover className="relative">
                  <TD className="max-w-[24rem]">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/applications/${a.id}`}
                        className={`truncate font-medium after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--color-primary)] ${
                          off ? 'text-[var(--color-muted-fg)]' : 'text-[var(--color-fg)]'
                        }`}
                      >
                        {a.name}
                      </Link>
                      {hasApplicationStatus(a) && (
                        <span className="flex shrink-0 gap-1">
                          <ApplicationStatusBadges app={a} />
                        </span>
                      )}
                    </div>
                    <div className="truncate font-mono text-[11px] text-[var(--color-muted-fg)]">{a.slug}</div>
                  </TD>
                  <TD>
                    <EnvironmentBadge environment={a.environment} />
                  </TD>
                  {showKeys && (
                    <TD className="whitespace-nowrap">
                      <Keys app={a} />
                    </TD>
                  )}
                  {showActive && (
                    <TD muted className="whitespace-nowrap tabular-nums">
                      {activeLabel(a) ?? <span className="text-[var(--color-faint-fg)]">Hidden</span>}
                    </TD>
                  )}
                  <TD align="right" muted className="whitespace-nowrap tabular-nums">
                    {formatDate(a.createdAt)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>

      <ul className="space-y-2 md:hidden">
        {apps.map((a) => {
          const day = a.summary?.lastActiveOn;
          const activity =
            day === undefined ? null : day === null ? 'No activity yet' : `Active ${formatActiveDay(day).toLowerCase()}`;
          const facts = [keysLabel(a), activity, `Created ${formatDate(a.createdAt)}`].filter(
            (f): f is string => f !== null,
          );
          return (
            <li key={a.id}>
              <Link
                href={`/applications/${a.id}`}
                className="block rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 transition-colors active:scale-[0.99] hover:border-[color-mix(in_srgb,var(--color-primary)_40%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`truncate font-medium ${a.disabledAt ? 'text-[var(--color-muted-fg)]' : 'text-[var(--color-fg)]'}`}>
                      {a.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-[var(--color-muted-fg)]">{a.slug}</div>
                  </div>
                  <EnvironmentBadge environment={a.environment} className="shrink-0" />
                </div>
                {hasApplicationStatus(a) && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <ApplicationStatusBadges app={a} />
                  </div>
                )}
                <p className="mt-2 text-xs text-[var(--color-muted-fg)]">{facts.join(' · ')}</p>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
