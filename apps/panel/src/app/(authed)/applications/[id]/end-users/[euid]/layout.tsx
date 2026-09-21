/**
 * End-user detail shell: identity header, the conditions that apply to every
 * tab, and the tab strip.
 *
 * ## Why this is a layout and not a page
 *
 * This screen used to be one 900-line page rendering everything it knew about
 * an end-user as a single scroll, profile, auth events, subscriptions,
 * payments, credits, export, erase, impersonate, passkeys, impersonations. It
 * was a data dump, not a console: the shape answered "what do we store" when
 * the operator's question is "what do I do about this ticket". It also fetched
 * four endpoints on every render regardless of which part you came for, and had
 * nowhere to put the device, session and support actions the API has had since
 * the device series shipped.
 *
 * Splitting it into a layout plus six routed tabs gives each concern a
 * linkable URL, lets each tab fetch only what it renders, and leaves an obvious
 * place to add an action. The tabs are real route segments rather than client
 * state so that a support agent can paste "the devices tab for this user" into
 * a ticket.
 *
 * ## What stays here
 *
 * Only facts that are true on every tab: who this is, that they are erased,
 * and the navigation. `getEndUserDetail` is `React.cache`d per request, so the
 * header reading it here and a tab reading it below is one round trip, not two.
 */

import * as React from 'react';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { CopyLinkButton } from '@/components/CopyLinkButton';
import { RecordHeader } from '@/components/RecordHeader';
import { getEndUserDetail } from './shared';
import { getApplication } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';

export default async function EndUserLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; euid: string }>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  // Request-cached: the application layout already fetched this row.
  const [detail, application] = await Promise.all([getEndUserDetail(id, euid), getApplication(id)]);
  const scopes = application.access?.scopes ?? null;
  const canBilling = hasScope(scopes, 'billing:read');
  const isErased = detail.endUser.erasedAt !== null;
  const base = `/applications/${id}/end-users/${euid}`;

  return (
    <div className="space-y-5">
      {/* One band: a back link would be redundant since End-users is already
          highlighted one row above, and a separate underline strip would just
          duplicate AppNav's own. `RecordHeader` combines crumb, title and tab
          strip into a single row instead. */}
      <RecordHeader
        crumbs={[
          { label: 'End-users', href: `/applications/${id}/end-users` },
          { label: detail.endUser.email },
        ]}
        title={
          <>
            <span className="min-w-0 truncate">{detail.endUser.email}</span>
            {isErased && (
              <Badge tone="danger" dot>
                erased
              </Badge>
            )}
          </>
        }
        meta={<span className="font-mono">{detail.endUser.id}</span>}
        action={<CopyLinkButton />}
        segmentsLabel="End-user sections"
        // Subscriptions and Credits are billing reads. Without the scope they
        // are not offered rather than offered and refused.
        segments={[
          { href: base, label: 'Overview', exact: true },
          ...(canBilling ? [{ href: `${base}/subscriptions`, label: 'Subscriptions' }] : []),
          { href: `${base}/devices`, label: 'Devices' },
          ...(canBilling ? [{ href: `${base}/credits`, label: 'Credits' }] : []),
          { href: `${base}/security`, label: 'Security' },
          { href: `${base}/data`, label: 'Data & privacy' },
        ]}
      />

      {/* In the LAYOUT for the same reason the application's disabled banner is
          in its own: an erased user looks ordinary on Devices, on Credits and
          on Subscriptions, and an operator who landed on one of those directly
          would otherwise act on a tombstone without being told. */}
      {isErased && (
        <Banner tone="warning">
          This end-user has been erased (GDPR). Their PII and credentials are gone and they can no
          longer sign in. Financial records are retained but anonymized.
        </Banner>
      )}

      <div>{children}</div>
    </div>
  );
}
