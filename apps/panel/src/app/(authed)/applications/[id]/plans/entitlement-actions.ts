'use server';

/**
 * Server actions for a plan's entitlement bundle. Each redirects back to the
 * plans page, which is what re-renders it with the saved bundle.
 */

import { redirect } from 'next/navigation';
import { api, PanelApiError } from '@/lib/api';

function entitlementsPath(applicationId: string, slug: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/entitlements`;
}

export async function addEntitlement(applicationId: string, slug: string, formData: FormData): Promise<void> {
  const kind = String(formData.get('kind') ?? '');
  const key = String(formData.get('key') ?? '').trim();
  const valueType = String(formData.get('valueType') ?? '').trim();
  const value = String(formData.get('value') ?? '').trim();
  const quantity = Number(formData.get('quantity') ?? 0);
  const licenseKind = String(formData.get('licenseKind') ?? '').trim();

  const body: Record<string, unknown> = { kind };
  if (kind === 'FEATURE') {
    if (key) body.key = key;
    if (valueType) body.valueType = valueType;
    if (value) body.value = value;
  } else if (kind === 'CREDIT') {
    body.quantity = quantity;
  } else if (kind === 'LICENSE') {
    if (licenseKind) body.licenseKind = licenseKind;
    if (quantity > 0) body.quantity = quantity;
  } else if (kind === 'USAGE') {
    if (key) body.key = key;
    body.quantity = quantity;
    // Empty means "hard cap", which is not zero: zero is a real rate meaning
    // "charge nothing per unit". Read the raw field so the two stay apart.
    const rawRate = String(formData.get('creditsPerUnit') ?? '').trim();
    if (rawRate !== '') body.creditsPerUnit = Number(rawRate);
  }

  try {
    await api({ method: 'PUT', path: entitlementsPath(applicationId, slug), body });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/plans?entError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/plans?entSaved=${encodeURIComponent(slug)}`);
}

export async function removeEntitlement(applicationId: string, slug: string, entId: string): Promise<void> {
  await api({
    method: 'DELETE',
    path: `${entitlementsPath(applicationId, slug)}/${encodeURIComponent(entId)}`,
  });
  redirect(`/applications/${applicationId}/plans`);
}
