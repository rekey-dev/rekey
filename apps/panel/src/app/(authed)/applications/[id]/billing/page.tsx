import * as React from 'react';
import { redirect } from 'next/navigation';
import type { CheckoutStatusPanel } from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { apiGet, getApplication, readErrorFlash, unlessBusy } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { setBillingEnabled } from './actions';
import { LegacyHashRedirect } from './legacy-hash-redirect';
import { ReturnUrlNotice, UnbuyablePlansNotice } from './notices';
import {
  BILLING_ERR,
  billingBase,
  getBillingProviders,
  getPlans,
  getReturnUrlEvents,
  isInboundOnly,
  soldExternally,
  unbuyablePlans,
  unregisteredOrigins,
} from './shared';

type Health = 'ok' | 'warn' | 'idle';

export default async function BillingStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  // Links from before the tabs opened a provider's dialog with `?edit=` and
  // reported an auto-configured webhook with `?webhook=`. Both belong to the
  // Providers tab now, so a bookmark still lands on the dialog it named.
  if (typeof sp.edit === 'string' || typeof sp.webhook === 'string') {
    redirect(`${billingBase(id)}/providers?${legacyQuery(sp)}`);
  }
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;

  const [app, providers, planPage, returnUrlEvents, checkout] = await Promise.all([
    getApplication(id),
    getBillingProviders(id),
    getPlans(id),
    getReturnUrlEvents(id),
    apiGet<CheckoutStatusPanel>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/checkout/status`,
      { interruptOnAccessError: false },
    ).catch(unlessBusy(() => null)),
  ]);

  const base = billingBase(id);
  const billingEnabled = app.billingConfig.enabled;
  const dunningEnabled = app.billingConfig.dunningEnabled ?? false;
  const plans = planPage?.items ?? [];
  const blocked = unbuyablePlans(plans);
  const configured = providers.filter((d) => d.status !== null);
  const active = configured.filter((d) => d.status!.enabled);
  const live = active.filter((d) => d.status!.mode === 'live');
  const missingWebhook = active.filter((d) => !d.status!.webhookConfigured);
  const activePlans = plans.filter((p) => p.active).length;
  const canWrite = hasScope(app.access?.scopes ?? null, 'billing:write');
  const rekeyPageModes = checkout
    ? (['test', 'live'] as const).filter((m) =>
        (m === 'test' ? checkout.settings.checkoutModeTest : checkout.settings.checkoutModeLive) === 'EMBEDDED',
      )
    : [];

  return (
    <div className="space-y-5">
      <LegacyHashRedirect hash="#checkout-page" to={`${billingBase(id)}/checkout`} />
      {saved === 'billing' && (
        <SavedBanner message={`Billing ${billingEnabled ? 'enabled' : 'disabled'} for this application.`} />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={BILLING_ERR} fallback={error} />
        </Banner>
      )}
      <ReturnUrlNotice
        applicationId={id}
        count={returnUrlEvents.page.total}
        origins={unregisteredOrigins(returnUrlEvents.items)}
      />
      <UnbuyablePlansNotice
        applicationId={id}
        plans={blocked}
        soldExternally={soldExternally(blocked)}
        checkoutProviderLabels={providers.filter((d) => !isInboundOnly(d)).map((d) => d.label)}
      />

      {/* The master switch. Off gates the whole public billing surface on the
          API and hides the Billing tab group. */}
      <Card className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Billing</h2>
            <Badge tone={billingEnabled ? 'success' : 'neutral'} dot>
              {billingEnabled ? 'on' : 'off'}
            </Badge>
          </div>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
            {billingEnabled
              ? 'Plans, checkout, subscriptions, coupons, credits, licenses and usage are live for this application.'
              : 'The public billing API returns 403 and every billing tab except Setup stays hidden until you turn billing on. You can connect providers first.'}
          </p>
        </div>
        {canWrite ? (
          <ActionForm action={setBillingEnabled.bind(null, id, !billingEnabled)} className="shrink-0">
            {billingEnabled ? (
              <ConfirmButton
                confirm="Disable billing? The public billing API (checkout, subscriptions, plans, coupons, credits, licenses, usage) will immediately return 403 and the Billing tab group will be hidden. Existing subscriptions are not cancelled, and you can re-enable any time."
                variant="danger"
              >
                Disable billing
              </ConfirmButton>
          ) : (
            <SubmitButton
              pendingLabel="Enabling…"
              className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
            >
              Enable billing
            </SubmitButton>
          )}
        </ActionForm>
        ) : (
          <p className="shrink-0 text-xs text-[var(--color-muted-fg)]">
            Turning billing on or off needs billing write access.
          </p>
        )}
      </Card>

      <section className="space-y-3" aria-labelledby="billing-health-heading">
        <SectionHeader
          title={<span id="billing-health-heading">Checklist</span>}
          description="What a buyer needs in place to pay. Each row opens the tab that fixes it."
        />
        <Card padded={false} className="divide-y divide-[var(--color-border)]">
          <HealthRow
            href={`${base}/providers`}
            label="Payment providers"
            status={active.length > 0 ? 'ok' : billingEnabled ? 'warn' : 'idle'}
            value={
              configured.length === 0
                ? 'None configured'
                : `${active.map((d) => d.label).join(', ') || 'None active'}${live.length > 0 ? ' · live' : active.length > 0 ? ' · test mode' : ''}`
            }
          />
          <HealthRow
            href={`${base}/providers`}
            label="Provider webhooks"
            status={active.length === 0 ? 'idle' : missingWebhook.length === 0 ? 'ok' : 'warn'}
            value={
              active.length === 0
                ? 'No active provider'
                : missingWebhook.length === 0
                  ? 'All configured'
                  : `Not set up for ${missingWebhook.map((d) => d.label).join(', ')}`
            }
          />
          <HealthRow
            href={`/applications/${id}/plans`}
            label="Plans"
            status={
              !billingEnabled || planPage === null
                ? 'idle'
                : activePlans === 0 || (blocked.length > 0 && !soldExternally(blocked))
                  ? 'warn'
                  : 'ok'
            }
            value={
              planPage === null
                ? 'Could not be read'
                : activePlans === 0
                ? 'No active plans'
                : blocked.length > 0 && !soldExternally(blocked)
                  ? `${blocked.length} of ${activePlans} not payable`
                  : `${activePlans} active`
            }
          />
          <HealthRow
            href={`${base}/checkout`}
            label="Checkout page"
            status={!billingEnabled || checkout === null ? 'idle' : 'ok'}
            value={
              checkout === null
                ? 'Not available'
                : rekeyPageModes.length === 0
                  ? "Provider's page"
                  : `Rekey page in ${rekeyPageModes.join(' and ')}`
            }
          />
          <HealthRow
            href={`${base}/settings`}
            label="Failed-payment recovery"
            status={!billingEnabled ? 'idle' : dunningEnabled ? 'ok' : 'idle'}
            value={dunningEnabled ? 'On' : 'Off'}
          />
        </Card>
      </section>
    </div>
  );
}

function legacyQuery(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') q.set(key, value);
  }
  return q.toString();
}

const DOT: Record<Health, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  idle: 'bg-neutral-400',
};

const SR_STATUS: Record<Health, string> = {
  ok: 'OK',
  warn: 'Needs attention',
  idle: 'Off',
};

/** Same shape as the Application overview's configuration rows. */
function HealthRow({
  href,
  label,
  value,
  status,
}: {
  href: string;
  label: string;
  value: string;
  status: Health;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]"
    >
      <span className="flex min-w-0 items-center gap-2 text-sm text-[var(--color-fg)]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
        <span className="sr-only">{SR_STATUS[status]}:</span>
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs text-[var(--color-muted-fg)] group-hover:text-[var(--color-fg)]">
          {value}
        </span>
        <span aria-hidden className="text-xs text-neutral-400 group-hover:text-[var(--color-fg)]">
          →
        </span>
      </span>
    </Link>
  );
}
