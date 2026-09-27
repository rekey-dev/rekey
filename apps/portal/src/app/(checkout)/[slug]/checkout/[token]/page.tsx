/**
 * `/<slug>/checkout/<token>`: the Rekey-hosted checkout page.
 *
 * Rendered per request (the nonce and the session are both per request). The
 * slug in the path must be the session's own Application, otherwise the page
 * answers exactly as for an unknown token, so the path cannot be used to learn
 * which Application a token belongs to. It does not need the hosted portal
 * switched on for the Application and never reads the portal config.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { checkoutTokenMode } from '@rekey.dev/shared-types/checkout';
import { confirmApproval, isCheckoutToken, lookupCheckout } from '@/lib/checkout-api';
import { NONCE_HEADER } from '@/lib/checkout-csp';
import { checkoutLocale } from '@/lib/checkout-format';
import { CheckoutNotice, CheckoutView } from '@/components/checkout/checkout-view';

export const dynamic = 'force-dynamic';

/**
 * Never "nothing has been charged": a buyer who approved at PayPal just before
 * the link ran out has paid, and the payment completes from PayPal's webhook.
 */
const EXPIRED_BODY =
  'This checkout link has expired. If you already paid, do not pay again: contact the business you were buying from. Otherwise, go back to their app and start again.';

type Params = {
  params: Promise<{ slug: string; token: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * A buyer who approved on PayPal's own page (the fallback link) comes back
 * here with `subscription_id`. It is only a claim: the API checks it with
 * PayPal like any approval, and activation still waits for the webhook.
 * PayPal may append it on a cancelled return too, so the query is stripped
 * with a redirect after one attempt: a refresh must not ask again.
 */
async function confirmReturnFromPaypal(token: string, searchParams: Params['searchParams']): Promise<boolean> {
  const query = await searchParams;
  if (query === undefined || !('subscription_id' in query)) return false;
  const returned = query.subscription_id;
  if (typeof returned === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(returned)) await confirmApproval(token, returned);
  return true;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  return { title: checkoutTokenMode(token) === 'test' ? '[Test] Checkout' : 'Checkout' };
}

export default async function CheckoutPage({ params, searchParams }: Params): Promise<React.JSX.Element> {
  const { slug, token } = await params;
  const h = await headers();
  const nonce = h.get(NONCE_HEADER) ?? '';
  const locale = checkoutLocale(h.get('accept-language'));
  if (isCheckoutToken(token) && (await confirmReturnFromPaypal(token, searchParams))) {
    redirect(`/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`);
  }
  const lookup = await lookupCheckout(token);
  const testMode = checkoutTokenMode(token) === 'test';

  if (lookup.kind === 'unavailable') {
    return (
      <CheckoutNotice
        title="Checkout is temporarily unavailable"
        body="This page could not load the checkout. Try again in a moment. If you already paid, do not pay again."
        returnUrl={`/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`}
        returnLabel="Try again"
        testMode={false}
      />
    );
  }
  if (lookup.kind === 'not_found' || (lookup.kind === 'view' && lookup.view.slug !== slug)) {
    return (
      <CheckoutNotice
        title="This checkout link isn't valid"
        body="Check that you copied the whole address, or go back to the app you were buying in and start again."
        returnUrl={null}
        returnLabel=""
        testMode={false}
      />
    );
  }
  if (lookup.kind === 'expired') {
    return (
      <CheckoutNotice
        title="This checkout has expired"
        body={EXPIRED_BODY}
        returnUrl={null}
        returnLabel=""
        testMode={testMode}
      />
    );
  }

  const { view } = lookup;
  if (view.status === 'complete') {
    return (
      <CheckoutNotice
        title="This checkout is already paid"
        body="There is nothing more to do here."
        returnUrl={view.returnUrl}
        returnLabel="Return to the app"
        testMode={view.paymentMode === 'test'}
      />
    );
  }
  if (view.status === 'expired' || view.order === null || view.provider !== 'paypal') {
    return (
      <CheckoutNotice
        title="This checkout has expired"
        body={EXPIRED_BODY}
        returnUrl={view.returnUrl}
        returnLabel="Return to the app"
        testMode={view.paymentMode === 'test'}
      />
    );
  }
  return (
    <CheckoutView
      view={view}
      order={view.order}
      nonce={nonce}
      basePath={`/${encodeURIComponent(slug)}/checkout/${encodeURIComponent(token)}`}
      locale={locale}
    />
  );
}
