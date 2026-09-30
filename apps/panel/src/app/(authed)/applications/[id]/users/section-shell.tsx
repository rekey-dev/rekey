import * as React from 'react';
import { Card, SectionHeader } from '@/components/Card';
import { formatDate } from '@/lib/date';
import type { AnalyticsMetricGap } from '@rekey.dev/shared-types';
import { isSection, type Section } from '@/lib/users-analytics';

const METRIC_NAME: Record<string, string> = {
  dau: 'daily active users',
  wau: 'weekly active users',
  mau: 'monthly active users',
  dauAverage: 'average daily active users',
  stickiness: 'stickiness',
};

function metricName(m: string): string {
  const name = METRIC_NAME[m];
  return name === undefined ? m : name;
}

function listOf(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One sentence for why some numbers in a section are blank. */
export function describeGap(g: AnalyticsMetricGap): string {
  const what = listOf(g.metrics.map(metricName));
  const days = g.days.length;
  const when =
    days === 0 ? '' : days === 1 ? ` on ${formatDate(g.days[0]!)}` : ` on ${days} days (${formatDate(g.days[0]!)} to ${formatDate(g.days[days - 1]!)})`;
  const why =
    g.reason === 'filter_not_in_rollup'
      ? 'The daily history does not keep these under the filters you chose'
      : 'The daily history has no record for those days';
  return `No ${what}${when}. ${why}.`;
}

const UNAVAILABLE: Record<string, string> = {
  needs_rollup: 'Needs daily history, which this deployment is still collecting.',
  billing_disabled: 'Billing is off for this application.',
  not_captured: 'Rekey does not record this.',
  outside_window: 'The range reaches past the data this can be answered from.',
};

/**
 * One widget's frame: its title, and the right body for whatever state the
 * API sent it in. `ok` renders `children(data)`; the other states each say
 * what happened and what to do, never a zero standing in for "unknown".
 */
export function SectionShell<T>({
  title,
  description,
  section,
  retryHref,
  action,
  footnote,
  since,
  children,
  bare = false,
  gapFixHref,
}: {
  title: string;
  description?: React.ReactNode;
  section: Section<T> | undefined;
  retryHref: string;
  action?: React.ReactNode;
  footnote?: React.ReactNode;
  /** For `unavailable: needs_rollup`: when the history starts. */
  since?: string | null | undefined;
  children: (data: T) => React.ReactNode;
  /** No card around the body, for a row of tiles. */
  bare?: boolean;
  /** Where a gap note's "shorter range" link goes; omitted when the range is already short. */
  gapFixHref?: string | undefined;
}): React.JSX.Element {
  const body = sectionBody(section, retryHref, since, children);
  const ok = section !== undefined && isSection(section) && section.status === 'ok';
  const ignored = ok ? (section.ignoredFilters ?? []) : [];
  const stale = ok && section.cache?.stale;
  // Older API builds send no `gaps`; read that as none.
  const gaps: AnalyticsMetricGap[] = ok ? (section.gaps ?? []) : [];
  const header = (
    <SectionHeader
      title={title}
      description={description}
      action={action}
      className={bare ? 'mb-3' : 'mb-4'}
    />
  );
  const notes = (
    <>
      {ignored.length > 0 && (
        <p className="mt-3 text-xs text-[var(--color-muted-fg)]">
          Not filtered by {ignored.join(', ')}: this widget cannot apply {ignored.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {gaps.map((g) => (
        <p key={`${g.reason}:${g.metrics.join(',')}`} className="mt-2 text-xs text-[var(--color-muted-fg)]">
          {describeGap(g)} {g.fix}
          {gapFixHref && (
            <>
              {' '}
              <a href={gapFixHref} className="font-medium text-[var(--color-fg)] underline underline-offset-2">
                Show the last 30 days
              </a>
            </>
          )}
        </p>
      ))}
      {stale && <p className="mt-1 text-xs text-[var(--color-faint-fg)]">Showing the last result while a fresh one is computed.</p>}
      {ok && footnote && <p className="mt-3 text-xs text-[var(--color-muted-fg)]">{footnote}</p>}
    </>
  );
  if (bare) {
    return (
      <section aria-label={title}>
        {header}
        {body}
        {notes}
      </section>
    );
  }
  return (
    <Card as="section" className="min-w-0">
      {header}
      {body}
      {notes}
    </Card>
  );
}

function sectionBody<T>(
  section: Section<T> | undefined,
  retryHref: string,
  since: string | null | undefined,
  children: (data: T) => React.ReactNode,
): React.ReactNode {
  if (section === undefined) {
    return <StateNote tone="muted" title="Not returned" body="The API sent nothing for this section." />;
  }
  if (!isSection(section)) {
    return (
      <StateNote
        tone="error"
        title="Could not be shown"
        body="The API answered in a shape this panel does not know. Update the panel and the API to the same release."
      />
    );
  }
  switch (section.status) {
    case 'ok':
      return children(section.data);
    case 'error':
      return (
        <StateNote tone="error" title={section.error.message} body={section.error.fix}>
          <a href={retryHref} className="text-xs font-medium text-[var(--color-fg)] underline underline-offset-2">
            Retry
          </a>
        </StateNote>
      );
    case 'forbidden':
      return (
        <StateNote
          tone="muted"
          title="Not visible to your role"
          body={`Your access to this application does not include ${section.scope}.`}
        />
      );
    case 'pending':
      return (
        <StateNote tone="muted" title="Still calculating" body="This one takes a moment on a large application.">
          <a href={retryHref} className="text-xs font-medium text-[var(--color-fg)] underline underline-offset-2">
            Refresh
          </a>
        </StateNote>
      );
    case 'unavailable':
      return (
        <StateNote
          tone="muted"
          title={
            section.reason === 'needs_rollup' && since
              ? `History starts on ${formatDate(since)}`
              : (UNAVAILABLE[section.reason] ?? 'Not available')
          }
          body={section.fix}
        />
      );
  }
}

export function StateNote({
  tone,
  title,
  body,
  children,
}: {
  tone: 'error' | 'muted';
  title: string;
  body?: string | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={`rounded-lg border px-4 py-5 text-center ${
        tone === 'error'
          ? 'border-red-200 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/30'
          : 'border-dashed border-[var(--color-border)]'
      }`}
    >
      <p className={`text-sm font-medium ${tone === 'error' ? 'text-red-800 dark:text-red-300' : 'text-[var(--color-fg)]'}`}>{title}</p>
      {body && <p className="mx-auto mt-1 max-w-md text-xs text-[var(--color-muted-fg)]">{body}</p>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
