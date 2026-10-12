import * as React from 'react';
import Link from '@/components/Link';
import { BillingLogTable } from '@/components/BillingLogTable';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Modal } from '@/components/Modal';
import { getBillingTrail, TRAIL_PAGE_SIZE, type TrailOf } from '../../../billing-log/shared';

const historyTrigger =
  'cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]';

async function Trail({
  applicationId,
  of,
  caption,
  fullHref,
  showCustomer,
}: {
  applicationId: string;
  of: TrailOf;
  caption: string;
  fullHref: string;
  showCustomer: boolean;
}): Promise<React.JSX.Element> {
  const page = await getBillingTrail(applicationId, of);
  if (page === null) {
    return (
      <EmptyState
        variant="inline"
        title="The billing history could not be read"
        description="The request failed, or your access to this Application does not cover billing. This is not an empty history. Reload to try again."
      />
    );
  }
  if (page.entries.length === 0) {
    return (
      <EmptyState
        variant="inline"
        title="Nothing in the billing log"
        description="Entries appear when a checkout opens, a payment is recorded or a subscription changes. Anything from before the log existed has no entry."
      />
    );
  }
  return (
    <div className="space-y-2">
      <BillingLogTable entries={page.entries} actors={page.actors} applicationId={applicationId} caption={caption} showCustomer={showCustomer} />
      {page.nextCursor !== null && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          The newest {TRAIL_PAGE_SIZE} entries.{' '}
          <Link href={fullHref} className="underline hover:text-[var(--color-fg)]">
            Open the full history in the billing log
          </Link>
        </p>
      )}
    </div>
  );
}

/** Everything the billing log holds about one end user, under their subscriptions and payments. */
export function BillingHistory({ applicationId, endUserId }: { applicationId: string; endUserId: string }): React.JSX.Element {
  const fullHref = `/applications/${applicationId}/billing-log?view=all&endUserId=${encodeURIComponent(endUserId)}`;
  return (
    <section className="space-y-3">
      <SectionHeader
        title="Billing history"
        description="What happened to this end-user's money and why: checkouts, the price they were given, payments, refunds, coupons and subscription changes. Newest first."
        action={
          <Link href={fullHref} className="text-xs text-[var(--color-muted-fg)] underline underline-offset-2 hover:text-[var(--color-fg)]">
            Open in the billing log
          </Link>
        }
      />
      <Trail
        applicationId={applicationId}
        of={{ endUserId }}
        caption="Billing history of this end-user, newest first"
        fullHref={fullHref}
        showCustomer={false}
      />
    </section>
  );
}

/** One subscription's history, in a dialog opened from its row. */
export function SubscriptionHistory({
  applicationId,
  subscriptionId,
  planName,
}: {
  applicationId: string;
  subscriptionId: string;
  planName: string;
}): React.JSX.Element {
  const fullHref = `/applications/${applicationId}/billing-log?view=all&subscriptionId=${encodeURIComponent(subscriptionId)}`;
  return (
    <Modal
      size="xl"
      title={`History of the ${planName} subscription`}
      description="Every billing log entry that names this subscription, newest first."
      trigger={
        <>
          History<span className="sr-only"> of the {planName} subscription</span>
        </>
      }
      triggerClassName={historyTrigger}
    >
      <Trail
        applicationId={applicationId}
        of={{ subscriptionId }}
        caption={`History of the ${planName} subscription, newest first`}
        fullHref={fullHref}
        showCustomer={false}
      />
    </Modal>
  );
}
