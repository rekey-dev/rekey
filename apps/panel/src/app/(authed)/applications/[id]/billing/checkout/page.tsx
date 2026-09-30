import * as React from 'react';
import { getApplication, readErrorFlash } from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { Banner } from '@/components/Banner';
import { BillingOffState } from '../notices';
import { BILLING_ERR } from '../shared';
import { CheckoutPageSection } from './checkout-page-section';

export default async function BillingCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const app = await getApplication(id);

  if (!app.billingConfig.enabled) {
    return <BillingOffState applicationId={id} what="the checkout page" />;
  }

  return (
    <div className="space-y-5">
      {saved === 'checkout' && <SavedBanner message="Checkout page setting saved." />}
      {saved === 'checkout_checks' && <SavedBanner message="Checks ran. The results are under Readiness." />}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={BILLING_ERR} fallback={error} />
        </Banner>
      )}
      <CheckoutPageSection applicationId={id} />
    </div>
  );
}
