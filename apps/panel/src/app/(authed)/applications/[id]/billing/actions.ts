'use server';

/**
 * Server actions for the billing tabs.
 *
 * Each one redirects back to the tab that owns the control it came from, so a
 * save lands where it was made. The redirect is what re-renders the page with
 * the saved values; do not replace it with a revalidation (see the panel
 * AGENTS.md on redirect after revalidatePath).
 */

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError, type BillingProviderName } from '@/lib/api';

function credentialsPath(applicationId: string, provider: BillingProviderName): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials/${encodeURIComponent(provider)}`;
}

function configPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-config`;
}

function tab(applicationId: string, name: '' | 'providers' | 'settings'): string {
  const base = `/applications/${applicationId}/billing`;
  return name === '' ? base : `${base}/${name}`;
}

/**
 * The one generic credentials action. `fieldKeys` is bound from the
 * provider's discovery `credentialFields`, so the collected `data` always
 * matches what that module's PUT route expects. The API re-validates and
 * raises BILLING_CREDENTIALS_INVALID, which reopens the dialog with the error.
 */
export async function saveProviderCredentials(
  applicationId: string,
  provider: BillingProviderName,
  fieldKeys: string[],
  isEdit: boolean,
  formData: FormData,
): Promise<void> {
  const data: Record<string, string> = {};
  for (const key of fieldKeys) {
    const value = String(formData.get(key) ?? '').trim();
    // On an edit a blank input means "keep the stored value", so the key is
    // omitted and the API merges. Clearing a stored field is deliberately not
    // reachable from here: send an explicit empty string over the API for that.
    if (isEdit && value === '') continue;
    data[key] = value;
  }
  const countries = parseCountries(formData.get('countries'));
  const priority = parsePriority(formData.get('priority'));
  const mode = parseMode(formData.get('mode'));
  try {
    await api({
      method: 'PUT',
      path: credentialsPath(applicationId, provider),
      body: { data, countries, priority, mode },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${tab(applicationId, 'providers')}?${await errorQuery(err, { edit: provider })}`);
    }
    throw err;
  }
  redirect(`${tab(applicationId, 'providers')}?saved=${encodeURIComponent(provider)}`);
}

export async function toggleProviderEnabled(
  applicationId: string,
  provider: BillingProviderName,
  enabled: boolean,
): Promise<void> {
  await api({ method: 'PATCH', path: credentialsPath(applicationId, provider), body: { enabled } });
  redirect(tab(applicationId, 'providers'));
}

export async function removeProvider(applicationId: string, provider: BillingProviderName): Promise<void> {
  await api({ method: 'DELETE', path: credentialsPath(applicationId, provider) });
  redirect(tab(applicationId, 'providers'));
}

export async function registerWebhook(applicationId: string, provider: BillingProviderName): Promise<void> {
  try {
    await api({ method: 'POST', path: `${credentialsPath(applicationId, provider)}/register-webhook` });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${tab(applicationId, 'providers')}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${tab(applicationId, 'providers')}?webhook=${encodeURIComponent(provider)}`);
}

async function patchConfig(
  applicationId: string,
  body: Record<string, unknown>,
  landing: '' | 'settings',
  saved: string,
): Promise<void> {
  try {
    await api({ method: 'PATCH', path: configPath(applicationId), body });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${tab(applicationId, landing)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${tab(applicationId, landing)}?saved=${saved}`);
}

/**
 * Master billing switch. Off gates the whole public billing surface on the
 * API and hides the Billing tab group.
 */
export async function setBillingEnabled(applicationId: string, enabled: boolean): Promise<void> {
  await patchConfig(applicationId, { enabled }, '', 'billing');
}

/**
 * Failed-payment recovery. Turning it off only stops new cases; any case
 * already in flight runs to completion.
 */
export async function setDunningEnabled(applicationId: string, dunningEnabled: boolean): Promise<void> {
  await patchConfig(applicationId, { dunningEnabled }, 'settings', 'dunning');
}

export async function setBillingSubject(applicationId: string, billingSubject: 'user' | 'org'): Promise<void> {
  await patchConfig(applicationId, { billingSubject }, 'settings', 'subject');
}

function parseCountries(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length === 2);
}

function parsePriority(raw: FormDataEntryValue | null): number {
  if (typeof raw !== 'string' || raw === '') return 100;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return 100;
  return Math.round(n);
}

function parseMode(raw: FormDataEntryValue | null): 'test' | 'live' {
  return raw === 'live' ? 'live' : 'test';
}
