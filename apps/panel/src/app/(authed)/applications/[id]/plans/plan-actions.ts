'use server';

/**
 * Server actions that create and edit a plan.
 *
 * Each one redirects back to the plans page. The redirect is what re-renders
 * the page with the saved values; do not replace it with a revalidation (see
 * the panel AGENTS.md on redirect after revalidatePath).
 */

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';
import { readTypedPlanAmount } from '@/lib/money-input';

/**
 * Create a plan. Every amount is typed the way it is written in the plan's
 * currency (19.99) and sent as the whole number of minor units the API stores.
 */
export async function createPlan(applicationId: string, formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const currency = String(formData.get('currency') ?? '').trim().toUpperCase();
  const typedAmount = readTypedPlanAmount(String(formData.get('amount') ?? ''), currency);
  const interval = String(formData.get('interval') ?? 'MONTH');
  const kind = String(formData.get('kind') ?? 'SUBSCRIPTION') as 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';
  const licenseKind = String(formData.get('licenseKind') ?? '');
  const licenseDurationDays = Number(formData.get('licenseDurationDays') ?? 0);
  const licenseSeatsAllowed = Number(formData.get('licenseSeatsAllowed') ?? 0);
  const meterSlug = String(formData.get('meterSlug') ?? '').trim();
  const creditsAmount = Number(formData.get('creditsAmount') ?? 0);

  if (!slug || !name || !typedAmount.ok) {
    redirect(`/applications/${applicationId}/plans?error=missing&newPlan=1`);
  }
  // An amount of zero is a plan with no flat price: free, or usage with no base fee.
  const body: Record<string, unknown> = { slug, name, interval, kind };
  if (typedAmount.minor > 0) body.price = { currency, amount: typedAmount.minor };
  if (kind === 'LICENSE') {
    if (licenseKind) body.licenseKind = licenseKind;
    if (licenseKind === 'TIMED' && licenseDurationDays > 0) body.licenseDurationDays = licenseDurationDays;
    if (licenseKind === 'SEATS' && licenseSeatsAllowed > 0) body.licenseSeatsAllowed = licenseSeatsAllowed;
  }
  if (kind === 'USAGE') {
    if (meterSlug) body.meterSlug = meterSlug;
  }
  if (kind === 'CREDIT') {
    if (Number.isInteger(creditsAmount) && creditsAmount > 0) body.creditsAmount = creditsAmount;
  }

  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/plans?${await errorQuery(err, { newPlan: '1' })}`);
    }
    throw err;
  }

  // Apply bundle add-ons (one PUT per entitlement). The plan already exists, so
  // a per-entitlement failure surfaces an error but keeps the `created` flag,
  // the operator sees the plan and can fix the bundle in the Entitlements modal.
  const entitlementsRaw = String(formData.get('entitlements') ?? '[]');
  let entitlements: Array<Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(entitlementsRaw);
    if (Array.isArray(parsed)) entitlements = parsed as Array<Record<string, unknown>>;
  } catch {
    // Ignore a malformed payload, the plan is still created without add-ons.
  }
  for (const ent of entitlements) {
    try {
      await api({
        method: 'PUT',
        path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/entitlements`,
        body: ent,
      });
    } catch (err) {
      if (err instanceof PanelApiError) {
        redirect(`/applications/${applicationId}/plans?created=${slug}&entError=${encodeURIComponent(err.code)}`);
      }
      throw err;
    }
  }
  redirect(`/applications/${applicationId}/plans?created=${slug}&e=plan_created`);
}

/**
 * Edit an existing plan's name, and its price while no provider price exists.
 *
 * The API refuses `price` and `interval` on a registered plan with
 * `PLAN_PRICE_IMMUTABLE`, so the form hides those inputs there rather than
 * offering an edit that cannot succeed. Only the fields actually submitted are
 * sent, so a name-only edit never touches the price. An amount of zero is sent
 * as `price: null`, which makes the plan free.
 *
 * The amount is typed as it is written in the plan's currency (19.99), as on
 * every other money field, and converted to minor units here.
 */
export async function editPlan(
  applicationId: string,
  /** `currency` is the default price's, or the reporting currency for a plan with no flat price. */
  plan: { slug: string; currency: string },
  formData: FormData,
): Promise<void> {
  const { slug } = plan;
  const back = (editError: string): string =>
    `/applications/${applicationId}/plans?editError=${editError}&editSlug=${encodeURIComponent(slug)}`;
  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect(back('missing'));

  const amountRaw = String(formData.get('amount') ?? '').trim();
  const currencyRaw = String(formData.get('currency') ?? '').trim().toUpperCase();
  const intervalRaw = String(formData.get('interval') ?? '').trim();
  const currency = currencyRaw || plan.currency.toUpperCase();
  const body: Record<string, unknown> = { name };
  if (amountRaw !== '') {
    const typed = readTypedPlanAmount(amountRaw, currency);
    if (!typed.ok) redirect(back('amount'));
    body.price = typed.minor === 0 ? null : { currency, amount: typed.minor };
  } else if (currency !== plan.currency.toUpperCase()) {
    // The stored integer means something else in another currency: 1999 is
    // 19.99 dollars and 1,999 yen. A new currency needs its amount typed.
    redirect(back('amount'));
  }
  if (intervalRaw) body.interval = intervalRaw;

  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(
        `/applications/${applicationId}/plans?${await errorQuery(err, {
          editError: err.code,
          editSlug: slug,
        })}`,
      );
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/plans`);
}

/**
 * Register a plan with the payment provider. Registration reaches the
 * provider, so it fails for reasons the operator can act on (no credentials,
 * credentials the provider rejected, a provider that is down), and each comes
 * back as a banner on the plans page.
 */
export async function registerPlan(applicationId: string, slug: string): Promise<void> {
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/register`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/plans?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/plans`);
}

export async function setPlanActive(applicationId: string, slug: string, active: boolean): Promise<void> {
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}`,
    body: { active },
  });
  redirect(`/applications/${applicationId}/plans`);
}
