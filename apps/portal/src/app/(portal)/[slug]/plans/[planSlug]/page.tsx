/**
 * `/<slug>/plans/<planSlug>`: one plan, reviewed before checkout.
 *
 * The buyer sees the price they will be charged and its currency, is told
 * when it is not the price for their own currency, and may enter a coupon
 * code. `?coupon=` is priced by the API on every render, so what the page
 * shows about a code is never a string carried in the address.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { checkoutAction } from '@/lib/actions';
import { decodedSegment, managedBillingOrg, planReviewPath } from '@/lib/billing-subject';
import { getPortalConfig } from '@/lib/config';
import { couponCodeOf, quoteCoupon, type CouponQuote } from '@/lib/coupon-quote';
import { getPortalUser, portalClientFor } from '@/lib/session';
import { PlanReview } from '@/components/plan-review';

/** Shown when the checkout refused a code the quote had accepted a moment before. */
const REFUSED_AT_CHECKOUT = 'This code could not be applied to this checkout.';

export default async function PlanReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; planSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug, planSlug: segment } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);

  const config = await getPortalConfig(slug);
  const client = await portalClientFor(slug);
  if (!config || !client || !config.billingEnabled) redirect(`/${slug}`);

  const team = config.billingSubject === 'org' ? await managedBillingOrg(client, session.accessToken) : null;
  // A member of a team-billed app may look at the plans and cannot change them.
  if (config.billingSubject === 'org' && team === null) redirect(`/${slug}`);
  const orgId = team?.id ?? null;

  const wanted = decodedSegment(segment);
  const [plans, held] = await Promise.all([
    client.getPlans({ limit: 100 }, { accessToken: session.accessToken }).then((r) => r.items),
    client
      .listSubscriptions(session.accessToken, orgId ? { organizationId: orgId } : undefined)
      .then((r) => r.items)
      .catch(() => []),
  ]);
  const plan = plans.find((p) => p.slug === wanted);
  if (!plan) redirect(`/${slug}?error=PLAN_NOT_FOUND`);
  if (held.some((s) => s.planId === plan.id)) redirect(`/${slug}`);
  if (!plan.checkout.ready) redirect(`/${slug}?error=PLAN_UNAVAILABLE`);

  const code = couponCodeOf(sp.coupon);
  const [providerList, quoted] = await Promise.all([
    // A hiccup here must not block the purchase: with no list there is no
    // picker and the API routes the checkout.
    client.listBillingProviders({ planSlug: plan.slug }).catch(() => null),
    code === null
      ? Promise.resolve(null)
      : quoteCoupon(client, session.accessToken, { code, planSlug: plan.slug, organizationId: orgId }),
  ]);
  const coupon: CouponQuote | null =
    quoted?.kind === 'quote' && sp.refused === '1'
      ? { kind: 'refused', code: quoted.code, message: REFUSED_AT_CHECKOUT }
      : quoted;

  return (
    <PlanReview
      slug={slug}
      plan={plan}
      switching={held.length > 0}
      team={team?.name ?? null}
      coupon={coupon}
      providers={providerList?.providers ?? []}
      routedProvider={providerList?.routedProvider ?? null}
      reviewPath={planReviewPath(slug, plan.slug)}
      action={checkoutAction.bind(null, slug, orgId)}
    />
  );
}
