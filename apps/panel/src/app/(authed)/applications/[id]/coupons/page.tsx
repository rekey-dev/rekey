import * as React from 'react';
import Link from '@/components/Link';
import { readErrorFlash, api, type CouponRow, getApplication, unlessBusy } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { Modal } from '@/components/Modal';
import { Pager, readPageSize } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { BillingModeBanner } from '@/components/BillingModeBanner';
import { SectionHeader } from '@/components/Card';
import { CurrencyCatalog } from '@/components/CurrencyCatalog';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { toChargingProviders } from '@/lib/price-currencies';
import { getBillingProviders, getPlans } from '../billing/shared';
import { createCoupon } from './actions';
import { CouponCreateForm } from './CouponCreateForm';
import { COUPON_FORM_ERR, CouponsTable } from './CouponsTable';
import type { CouponPlanOption } from './CouponTermsFields';

export default async function CouponsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const editCoupon = typeof sp.editCoupon === 'string' ? sp.editCoupon : undefined;
  const editError = typeof sp.editError === 'string' ? sp.editError : undefined;
  // `errorQuery` always writes `error`. It belongs to the create dialog only
  // when no coupon's edit dialog is the one being reopened.
  const error = editCoupon === undefined && typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery` in a
  // short-lived httpOnly cookie. Not in the URL: a query parameter is written
  // by whoever composes the link, and this text renders in the panel's banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error ?? editError);
  const created = typeof sp.created === 'string' ? sp.created : undefined;
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;

  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader title="Coupons" description="Discount codes applied at checkout." />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const reportingCurrency = app.billingConfig.reportingCurrency;
  const [{ items: coupons, page }, planPage, providers] = await Promise.all([
    api<Page<CouponRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/coupons?limit=${PAGE_SIZE}&offset=${offset}`,
    }),
    getPlans(id),
    getBillingProviders(id).catch(unlessBusy(() => [])),
  ]);
  const plans: CouponPlanOption[] = (planPage?.items ?? []).map((plan) => ({
    slug: plan.slug,
    name: plan.name,
    active: plan.active,
    currencies: plan.prices.map((price) => price.currency),
  }));

  const active = coupons.filter((c) => c.active);
  const inactive = coupons.filter((c) => !c.active);

  return (
    <CurrencyCatalog providers={toChargingProviders(providers)} first={reportingCurrency}>
      <div className="space-y-5">
        <BillingModeBanner applicationId={id} />
        {created && <SavedBanner params={['created']} message={`Coupon ${created} created.`} />}
        {saved && <SavedBanner params={['saved']} message={`Coupon ${saved.toUpperCase()} saved.`} />}
        {planPage === null && (
          <Banner tone="warning">
            The plans could not be read, so this page cannot say which plan currencies each coupon
            leaves out. Reload to try again.
          </Banner>
        )}

        <SectionHeader
          title="Coupons"
          count={`(${coupons.length})`}
          description="Discount codes a buyer enters at checkout. A percentage works in any currency unless you limit it. A fixed amount is set per currency and is refused in a currency it has no amount for. Totals are kept per currency and never added together."
          action={
            <Modal
              modalKey="newCoupon"
              size="lg"
              title="Add a coupon"
              description="A percentage, or a fixed amount stated in each currency your plans sell in."
              trigger="+ New coupon"
            >
              <CouponCreateForm
                key={created ?? 'new'}
                action={createCoupon.bind(null, id)}
                plans={plans}
                reportingCurrency={reportingCurrency}
              >
                {error && (
                  <Banner tone="error">
                    <ApiErrorText
                      code={error}
                      detail={errorDetail}
                      fix={errorFix}
                      map={COUPON_FORM_ERR}
                      fallback="The coupon could not be created."
                    />
                  </Banner>
                )}
              </CouponCreateForm>
            </Modal>
          }
        />

        {coupons.length === 0 ? (
          <EmptyState
            title="No coupons yet"
            description="A coupon takes a percentage or a fixed amount off at checkout. Codes are unique per Application and not case-sensitive."
            // The link carries the modal's own reopen flag rather than
            // mounting a second Modal with a duplicate modalKey.
            action={
              <Link
                href={`/applications/${id}/coupons?newCoupon=1`}
                className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
              >
                + New coupon
              </Link>
            }
          />
        ) : (
          <CouponsTable
            rows={[...active, ...inactive]}
            applicationId={id}
            plans={plans}
            reportingCurrency={reportingCurrency}
            flash={{ code: editCoupon, error: editError, detail: errorDetail, fix: errorFix }}
          />
        )}

        <Pager
          basePath={`/applications/${id}/coupons`}
          offset={offset}
          pageSize={PAGE_SIZE}
          count={coupons.length}
          hasMore={page.hasMore}
        />
      </div>
    </CurrencyCatalog>
  );
}
