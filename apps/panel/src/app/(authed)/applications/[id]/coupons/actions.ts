'use server';

/**
 * Server actions for coupons. Each redirects back to the coupons page, which
 * is what re-renders it with the saved coupon; a refusal reopens the dialog
 * it came from.
 */

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';
import { readCouponLimits, readCouponPlans, readCouponTerms, type DiscountType } from '@/lib/coupon-form';

function couponsPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/coupons`;
}

function page(applicationId: string, flags: Record<string, string>): string {
  return `/applications/${applicationId}/coupons?${new URLSearchParams(flags).toString()}`;
}

function discountTypeOf(raw: FormDataEntryValue | null): DiscountType {
  return raw === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
}

/**
 * Create a coupon. A percentage is typed as a percentage and sent as basis
 * points; each fixed amount is typed as its currency is written and sent in
 * that currency's smallest unit.
 */
export async function createCoupon(applicationId: string, formData: FormData): Promise<void> {
  const refuse = (error: string): never => redirect(page(applicationId, { error, newCoupon: '1' }));
  const code = String(formData.get('code') ?? '').trim();
  if (!code) refuse('code');
  const discountType = discountTypeOf(formData.get('discountType'));
  const read = readCouponTerms(discountType, formData);
  if (!read.ok) return refuse(read.code);

  const body: Record<string, unknown> = { code, discountType, ...read.terms };
  const planSlugs = readCouponPlans(formData);
  if (planSlugs.length > 0) body.planSlugs = planSlugs;
  const limits = readCouponLimits(formData);
  if (!limits.ok) return refuse(limits.code);
  // A create takes no null: a limit left empty is left out.
  for (const [name, value] of Object.entries(limits.limits)) if (value !== null) body[name] = value;

  try {
    await api({ method: 'POST', path: couponsPath(applicationId), body });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/coupons?${await errorQuery(err, { newCoupon: '1' })}`);
    }
    throw err;
  }
  redirect(page(applicationId, { created: code, e: 'coupon_created' }));
}

/**
 * Replace what a coupon takes off, where it applies, when it ends and how
 * often it may be redeemed. The amounts sent are the whole set: a currency
 * left out stops being covered. An end date or a cap left empty is removed.
 * A checkout already open keeps the discount it was opened with.
 */
export async function updateCouponTerms(
  applicationId: string,
  coupon: { code: string; discountType: DiscountType },
  formData: FormData,
): Promise<void> {
  const read = readCouponTerms(coupon.discountType, formData);
  if (!read.ok) redirect(page(applicationId, { editError: read.code, editCoupon: coupon.code }));
  const limits = readCouponLimits(formData);
  if (!limits.ok) redirect(page(applicationId, { editError: limits.code, editCoupon: coupon.code }));

  try {
    await api({
      method: 'PATCH',
      path: `${couponsPath(applicationId)}/${encodeURIComponent(coupon.code)}`,
      body: { ...read.terms, planSlugs: readCouponPlans(formData), ...limits.limits },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      const query = await errorQuery(err, { editError: err.code, editCoupon: coupon.code });
      redirect(`/applications/${applicationId}/coupons?${query}`);
    }
    throw err;
  }
  redirect(page(applicationId, { saved: coupon.code }));
}

export async function setCouponActive(applicationId: string, code: string, active: boolean): Promise<void> {
  await api({
    method: 'PATCH',
    path: `${couponsPath(applicationId)}/${encodeURIComponent(code)}`,
    body: { active },
  });
  redirect(`/applications/${applicationId}/coupons`);
}
