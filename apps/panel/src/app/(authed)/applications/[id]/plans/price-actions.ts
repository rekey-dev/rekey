'use server';

/**
 * Server actions for a plan's prices in other currencies.
 *
 * Every one redirects back to the plans page with `editSlug`, the flag that
 * reopens that plan's edit dialog, so the result shows where the operator was
 * working.
 */

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError, type PlanPrice } from '@/lib/api';
import { parsePriceAmount, parsePriceCountries, parsePriceCurrency, type PlanLocalPricesRule } from '@/lib/plan-prices';

interface PlanRef {
  id: string;
  slug: string;
}

function pricePath(applicationId: string, planId: string, currency: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(planId)}/prices/${encodeURIComponent(currency)}`;
}

function dialog(applicationId: string, plan: PlanRef, flags: Record<string, string>): string {
  const query = new URLSearchParams({ ...flags, editSlug: plan.slug });
  return `/applications/${applicationId}/plans?${query.toString()}`;
}

async function putPrice(
  applicationId: string,
  plan: PlanRef,
  currency: string,
  body: { amount?: number; countries?: string[] },
  savedFlags: Record<string, string> = {},
): Promise<void> {
  try {
    await api<PlanPrice>({ method: 'PUT', path: pricePath(applicationId, plan.id, currency), body });
  } catch (err) {
    if (err instanceof PanelApiError) {
      const query = await errorQuery(err, { priceError: err.code, editSlug: plan.slug });
      redirect(`/applications/${applicationId}/plans?${query}`);
    }
    throw err;
  }
  redirect(dialog(applicationId, plan, { priceSaved: currency, ...savedFlags }));
}

/** Add a price in another currency, or replace the amount of one not yet registered. */
export async function savePlanPrice(applicationId: string, plan: PlanRef, formData: FormData): Promise<void> {
  const currency = parsePriceCurrency(String(formData.get('currency') ?? ''));
  if (currency === null) redirect(dialog(applicationId, plan, { priceError: 'currency' }));
  const amount = parsePriceAmount(String(formData.get('amount') ?? ''), currency);
  if (amount === null) redirect(dialog(applicationId, plan, { priceError: 'amount' }));
  const countries = parsePriceCountries(String(formData.get('countries') ?? ''));
  if (countries === null) redirect(dialog(applicationId, plan, { priceError: 'countries' }));
  // A fresh value per successful add: it is what tells the add form to clear,
  // and adding the same currency twice in a row has to clear it twice.
  await putPrice(applicationId, plan, currency, { amount, countries }, { priceAdded: randomUUID().slice(0, 8) });
}

/** Change where an existing price applies. The amount is not sent, so it cannot be changed by accident. */
export async function savePlanPriceCountries(
  applicationId: string,
  plan: PlanRef,
  currency: string,
  formData: FormData,
): Promise<void> {
  const countries = parsePriceCountries(String(formData.get('countries') ?? ''));
  if (countries === null) redirect(dialog(applicationId, plan, { priceError: 'countries' }));
  await putPrice(applicationId, plan, currency, { countries });
}

/**
 * Change the amount of a price no provider has registered. Countries are not
 * sent, so they stay as they are.
 */
export async function savePlanPriceAmount(
  applicationId: string,
  plan: PlanRef,
  currency: string,
  formData: FormData,
): Promise<void> {
  const amount = parsePriceAmount(String(formData.get('amount') ?? ''), currency);
  if (amount === null) redirect(dialog(applicationId, plan, { priceError: 'amount' }));
  await putPrice(applicationId, plan, currency, { amount });
}

/**
 * Take a price off sale. The API deletes one nothing refers to and archives
 * one that an ended subscription or a payment still names, and refuses while
 * a live subscription or an open checkout is on it.
 */
export async function removePlanPrice(applicationId: string, plan: PlanRef, currency: string): Promise<void> {
  try {
    await api({ method: 'DELETE', path: pricePath(applicationId, plan.id, currency) });
  } catch (err) {
    if (err instanceof PanelApiError) {
      const query = await errorQuery(err, { priceError: err.code, editSlug: plan.slug });
      redirect(`/applications/${applicationId}/plans?${query}`);
    }
    throw err;
  }
  redirect(dialog(applicationId, plan, { priceRemoved: currency }));
}

/**
 * Set whether a buyer's country may select one of the plan's other prices.
 * The API writes the change to the billing log.
 */
export async function setPlanLocalPrices(applicationId: string, plan: PlanRef, rule: PlanLocalPricesRule): Promise<void> {
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(plan.slug)}`,
      body: { localPrices: rule },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      const query = await errorQuery(err, { priceError: err.code, editSlug: plan.slug });
      redirect(`/applications/${applicationId}/plans?${query}`);
    }
    throw err;
  }
  redirect(dialog(applicationId, plan, { localPricesSaved: rule }));
}
