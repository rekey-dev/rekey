import * as React from 'react';
import Link from '@/components/Link';
import { formatCount, formatExact, formatShare } from '@/lib/metric-format';
import { parseUsersQuery } from '@/lib/users-filters';
import { getUsersAnalytics } from '@/lib/users-analytics';
import { isApiBusy } from '@/lib/api';

const LABEL = { completed: 'Completed', skipped: 'Skipped', pending: 'Pending' } as const;
const HINT = {
  completed: 'answered every required question',
  skipped: 'chose to skip; never blocked',
  pending: 'neither completed nor skipped yet',
} as const;

/**
 * How many users completed, skipped or have yet to do either, from the
 * Users overview's onboarding section: one aggregate read, never a page
 * through every user. Renders nothing when the read is unavailable, since the
 * questions on this page are the point of it.
 */
export async function OnboardingStatusCounts({ applicationId }: { applicationId: string }): Promise<React.JSX.Element | null> {
  const { filters } = parseUsersQuery({}, null);
  let result: Awaited<ReturnType<typeof getUsersAnalytics>>;
  try {
    result = await getUsersAnalytics(applicationId, filters, ['onboarding']);
  } catch (err) {
    // The counts are a side note to the questions: a busy analytics route must
    // not replace the whole page with the busy notice.
    if (!isApiBusy(err)) throw err;
    return (
      <p className="rounded-lg border border-dashed border-[var(--color-border)] px-4 py-3 text-xs text-[var(--color-muted-fg)]">
        Onboarding counts are busy right now. Reload in a few seconds to see them.
      </p>
    );
  }
  if (result.kind !== 'ok') return null;
  const section = result.data.sections.onboarding;
  if (section?.status !== 'ok') return null;
  const counts = section.data.counts;
  const total = counts.completed + counts.skipped + counts.pending;

  return (
    <section aria-label="Onboarding status" className="space-y-2">
      <div className="grid grid-cols-3 gap-3">
        {(['completed', 'skipped', 'pending'] as const).map((k) => (
          <div key={k} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <p className="text-xs text-[var(--color-muted-fg)]">{LABEL[k]}</p>
            <p className="text-xl font-semibold tabular-nums text-[var(--color-fg)]" title={formatExact(counts[k])}>
              {formatCount(counts[k])}
              {total > 0 && <span className="ml-2 text-xs font-normal text-[var(--color-muted-fg)]">{formatShare(counts[k] / total)}</span>}
            </p>
            <p className="mt-0.5 hidden text-xs text-[var(--color-muted-fg)] sm:block">{HINT[k]}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        Everyone, now.{' '}
        <Link href={`/applications/${applicationId}/users`} className="underline underline-offset-2 hover:text-[var(--color-fg)]">
          The funnel and answers by sign-up date
        </Link>{' '}
        are on Users &gt; Overview.
      </p>
    </section>
  );
}
