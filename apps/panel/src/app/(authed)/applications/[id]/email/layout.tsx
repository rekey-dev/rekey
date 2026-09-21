/**
 * Email shell: one tab strip over four responsibilities.
 *
 * The page this replaces stacked three unrelated things, transport status,
 * BYO credentials, and the template list, into one scroll, put the send log on
 * a separate page reachable only by a link buried in the transport card, and
 * offered no way to stop email going out at all. The question an operator
 * arrives with is usually one of four, and each now has a place:
 *
 *   Settings       is mail on, who is it from, and which transport carries it
 *   Templates      what each email says, and whether it is sent at all
 *   Delivery       what actually happened to the last N sends
 *   Suppressions   who we must not email, and why
 *
 * The per-event editor stays at `email/[eventKey]`. A static segment wins over
 * a dynamic sibling in the App Router, so `templates` and `suppressions` are
 * not swallowed by it.
 */

import * as React from 'react';
import { RecordHeader } from '@/components/RecordHeader';

export default async function EmailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const base = `/applications/${id}/email`;

  return (
    <div className="space-y-5">
      {/* Email is the THIRD strip on this route, AppNav already spends two on
          Developer → Email, so it takes the enclosed idiom rather than a
          third page-spanning underline row. No breadcrumb: the two strips
          above already say Developer › Email, and a trail would be the same
          fact stated a third time. */}
      <RecordHeader
        title="Email"
        description="Transactional mail this Application sends to its end-users. Workspace mail (operator invitations and the like) is separate and is not affected by anything here."
        segmentsLabel="Email sections"
        // `email/[eventKey]` is a child of Templates living at a sibling
        // path, so without this the strip rendered on the per-event editor
        // with nothing selected at all.
        segmentsFallbackHref={`${base}/templates`}
        segments={[
          { href: base, label: 'Settings', exact: true },
          { href: `${base}/templates`, label: 'Templates' },
          { href: `${base}/logs`, label: 'Delivery' },
          { href: `${base}/suppressions`, label: 'Suppressions' },
        ]}
      />

      <div>{children}</div>
    </div>
  );
}
