import * as React from 'react';
import { api, type BillingCredentialRow, getApplication } from '@/lib/api';

/**
 * Live/test billing-mode banner for the billing tab group (Providers /
 * Plans / Payments / Coupons).
 *
 * If any enabled provider credential is `mode=live`, render a red-tinted
 * warning — plan/coupon edits affect real customers. Otherwise (only test
 * credentials configured) a quiet "Test mode" note. Renders nothing when no
 * provider is configured yet.
 *
 * `BillingModeNotice` is the pure presentational half for pages that already
 * fetched the credentials list (the Providers page); `BillingModeBanner` is
 * the self-fetching server component for the rest, and also re-checks the
 * billing master switch.
 */

export function BillingModeNotice({
  rows,
}: {
  rows: BillingCredentialRow[];
}): React.JSX.Element | null {
  const configured = rows.filter((r) => r.configured);
  if (configured.length === 0) return null;
  const live = configured.some((r) => r.enabled && r.mode === 'live');
  if (live) {
    return (
      <p
        role="status"
        className="rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-sm text-red-800 dark:text-red-300"
      >
        <strong className="font-semibold">Live billing configuration</strong> — changes affect
        real customers.
      </p>
    );
  }
  return (
    <p
      role="status"
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-muted-fg)]"
    >
      Test mode — billing providers are using sandbox credentials; no real money moves.
    </p>
  );
}

export async function BillingModeBanner({
  applicationId,
}: {
  applicationId: string;
}): Promise<React.JSX.Element | null> {
  const [app, rows] = await Promise.all([
    getApplication(applicationId),
    api<BillingCredentialRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing-credentials`,
    }).catch(() => [] as BillingCredentialRow[]),
  ]);
  if (!app.billingConfig.enabled) return null;
  return <BillingModeNotice rows={rows} />;
}
