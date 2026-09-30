import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { savedStateKey } from '@/lib/saved-state-key';

const BASE = (id: string): string => `/applications/${encodeURIComponent(id)}/settings`;

async function saveReportingTimezone(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const reportingTimezone = String(formData.get('reportingTimezone') ?? '');
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/settings`,
      body: { reportingTimezone },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${BASE(applicationId)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${BASE(applicationId)}?timezone=1`);
}

/**
 * ICU still lists some zones under names IANA has since replaced, so an
 * operator searching for Kolkata or Kyiv would not find them. Both names are
 * the same zone to the API.
 */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

/** Every IANA zone this runtime knows, current names, sorted, UTC first. */
export function timezoneOptions(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const names = new Set(all.map((z) => {
    const renamed = RENAMED[z];
    return renamed === undefined ? z : renamed;
  }));
  names.add(current);
  names.delete('UTC');
  return ['UTC', ...[...names].sort()];
}

/**
 * The zone the Users overview counts days in, saved with
 * `PATCH /tenant/applications/:id/settings`. Only rendered when the API
 * reports the field, since an older API has nowhere to store it.
 */
export function ReportingTimezone({
  applicationId,
  current,
  canWrite,
}: {
  applicationId: string;
  current: string;
  /** Saving needs write access to the application and `overview:write`. */
  canWrite: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
      <h3 className="text-sm font-medium text-[var(--color-fg)]">Reporting timezone</h3>
      <p className="mt-1 max-w-prose text-xs text-[var(--color-muted-fg)]">
        The day boundary Users &gt; Overview counts in. A change applies to days counted from now on; history
        already recorded keeps the zone it was counted in, and the last 63 days of live activity are always UTC.
      </p>
      {!canWrite && (
        <p className="mt-3 text-sm text-[var(--color-fg)]">
          {current}
          <span className="ml-2 text-xs text-[var(--color-muted-fg)]">Changing it needs write access with the Overview scope.</span>
        </p>
      )}
      {canWrite && (
      <ActionForm
        key={savedStateKey({ current })}
        action={saveReportingTimezone.bind(null, applicationId)}
        className="mt-3 flex flex-wrap items-end gap-2"
      >
        <label className="block text-xs font-medium text-[var(--color-fg)]" htmlFor="reportingTimezone">
          Timezone
          <select
            id="reportingTimezone"
            name="reportingTimezone"
            defaultValue={current}
            className="mt-1 block h-9 w-64 max-w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
          >
            {timezoneOptions(current).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <SubmitButton
          pendingLabel="Saving…"
          className="h-9 rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
        >
          Save timezone
        </SubmitButton>
      </ActionForm>
      )}
    </div>
  );
}
