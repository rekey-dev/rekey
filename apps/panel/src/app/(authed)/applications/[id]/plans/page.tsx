import * as React from 'react';
import Link from '@/components/Link';
import { errorMessage } from '@/lib/error-message';
import { api, type PlanRow, type UsageMeterRow, type PlanEntitlementRow, getApplication, readErrorFlash, unlessBusy } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { BillingModeBanner } from '@/components/BillingModeBanner';
import { Modal } from '@/components/Modal';
import { PlanCreateForm } from '@/components/PlanCreateForm';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { createPlan } from './plan-actions';
import type { PlanPriceFlash } from './PlanPricesSection';
import { PlansTable } from './PlansTable';
import { CurrencyCatalog } from '@/components/CurrencyCatalog';
import { currencyChoice, toChargingProviders, unchargeableReason } from '@/lib/price-currencies';
import { getBillingProviders, providerLabel } from '../billing/shared';
import { registerCanHelp, repairText } from '@/lib/plan-blockers';
import { Banner } from '@/components/Banner';

const ERR: Record<string, string> = {
  missing: 'Every field is required, and the amount is typed as the currency is written (19.99), with no more decimals than the currency has.',
  PLAN_SLUG_INVALID: 'Slug must be lowercase letters/digits/-/_.',
  PLAN_SLUG_TAKEN: 'A plan with that slug already exists.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage plans.',
  PLAN_ENTITLEMENT_INVALID: 'Entitlement is missing required fields for its kind.',
  PLAN_ENTITLEMENT_NOT_FOUND: 'Entitlement not found.',
  // The plan row is written either way and lands as "not registered", say so,
  // rather than leaving the operator with the bare code and no idea whether
  // anything was saved.
  BILLING_PROVIDER_ERROR:
    'Your payment provider refused to register this plan, so it was saved but is not on sale. Check the credentials under Billing → Setup → Providers, then use “Retry registration” on the plan.',
  BILLING_CREDENTIALS_NOT_CONFIGURED:
    'No payment provider is configured yet. Add one under Billing → Setup → Providers before creating plans.',
};

export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const created = typeof sp.created === 'string' ? sp.created : undefined;
  const entError = typeof sp.entError === 'string' ? sp.entError : undefined;
  const entSaved = typeof sp.entSaved === 'string' ? sp.entSaved : undefined;
  const editError = typeof sp.editError === 'string' ? sp.editError : undefined;
  const editSlug = typeof sp.editSlug === 'string' ? sp.editSlug : undefined;
  const priceError = typeof sp.priceError === 'string' ? sp.priceError : undefined;
  const priceErrorFlash = await readErrorFlash(priceError);
  const priceFlash: PlanPriceFlash = {
    error: priceError,
    errorDetail: priceErrorFlash.detail,
    errorFix: priceErrorFlash.fix,
    saved: typeof sp.priceSaved === 'string' ? sp.priceSaved : undefined,
    added: typeof sp.priceAdded === 'string' ? sp.priceAdded : undefined,
    removed: typeof sp.priceRemoved === 'string' ? sp.priceRemoved : undefined,
    localPrices: typeof sp.localPricesSaved === 'string' ? sp.localPricesSaved : undefined,
  };

  // Billing master switch off → point at the switch instead of an empty table
  // (same guard the Revenue page renders; the tab group is hidden but the URL
  // stays reachable).
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Plans"
          description="What end-users buy: subscriptions, licenses, usage-based pricing, or credit packs."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const [planPage, meterPage, providers] = await Promise.all([
    api<Page<PlanRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans`,
    }),
    api<Page<UsageMeterRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/usage-meters`,
    }).catch(unlessBusy(() => emptyPage<UsageMeterRow>())),
    // The currency fields say which currencies no provider can charge. With
    // the provider list unreadable they still work, and say nothing about that.
    getBillingProviders(id).catch(unlessBusy(() => [])),
  ]);
  const reportingCurrency = app.billingConfig.reportingCurrency;
  const plans = planPage.items;
  const meters = meterPage.items;
  // Per-plan entitlement bundles (one round-trip each; plan counts are small).
  const entLists = await Promise.all(
    plans.map((p) =>
      api<PlanEntitlementRow[]>({
        method: 'GET',
        path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans/${encodeURIComponent(p.slug)}/entitlements`,
      }).catch(unlessBusy(() => [] as PlanEntitlementRow[])),
    ),
  );
  const entBySlug: Record<string, PlanEntitlementRow[]> = {};
  plans.forEach((p, i) => {
    entBySlug[p.slug] = entLists[i] ?? [];
  });
  const action = createPlan.bind(null, id);
  const meterOptions = meters.filter((m) => m.active).map((m) => ({ slug: m.slug, name: m.name }));

  const active = plans.filter((p) => p.active);
  const inactive = plans.filter((p) => !p.active);

  // Plans on the pricing page right now that no provider will honour. Scoped to
  // `active` deliberately: an archived plan nobody can buy is not a problem,
  // and warning about it buries the ones that are costing money. The status
  // column already covers PENDING and FAILED, so they are left out here rather
  // than counted twice.
  const unbuyable = active.filter(
    (p) =>
      p.checkout?.ready === false &&
      p.registrationStatus !== 'PENDING' &&
      p.registrationStatus !== 'FAILED',
  );
  // The subset the per-row Register button is actually offered for. That button
  // is withheld when registering cannot clear what blocks the plan: nothing is
  // configured, or no provider can charge its currency. The banner's remedy
  // text has to follow the same rule or it names a control that is not on
  // screen, which is exactly the state the banner exists to explain.
  const registerable = unbuyable.filter((p) => registerCanHelp(p.checkout?.blockers ?? []));
  const noProvider = unbuyable.some((p) =>
    (p.checkout?.blockers ?? []).some((b) => b.code === 'NO_BILLING_PROVIDER'),
  );

  return (
    <CurrencyCatalog providers={toChargingProviders(providers)} first={reportingCurrency}>
    <div className="space-y-5">
      <BillingModeBanner applicationId={id} />
      {created && (
        <Banner tone="success">
          Plan <code className="font-mono">{created}</code> created.
        </Banner>
      )}
      {entSaved && (
        <Banner tone="success">
          Entitlement saved on <code className="font-mono">{entSaved}</code>.
        </Banner>
      )}
      {entError && (
        <Banner tone="error">
          {errorMessage(ERR, entError)}
        </Banner>
      )}
      {unbuyable.length > 0 && (
        // The one state nothing else on this page reveals. Every other signal
        // says these plans are fine, so the notice has to say what the symptom
        // will be rather than only naming the state.
        <Banner tone="error">
          <p>
            {unbuyable.length === 1 ? 'One live plan cannot' : `${unbuyable.length} live plans cannot`}{' '}
            be bought. A buyer who clicks Buy is refused.
          </p>
          <ul className="mt-2 space-y-1">
            {unbuyable.map((p) => (
              <li key={p.id} className="text-xs">
                <code className="font-mono">{p.slug}</code>
                {(p.checkout?.blockers ?? []).map((b) => (
                  <span key={`${p.id}-${b.provider ?? 'none'}-${b.code}`} className="block">
                    {b.provider !== null && `${providerLabel(providers, b.provider)}: `}
                    {b.message}
                    {/* No provider connected gets the paragraph below, once. */}
                    {b.code !== 'NO_BILLING_PROVIDER' && <span className="block opacity-90">To repair: {repairText(b, id)}</span>}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {registerable.length > 0 && (
            <p className="mt-2 text-xs">
              Plans register with the payment provider when they are created, so a plan created
              before you connected one was never registered and connecting it afterwards does not
              repair them. Use <strong>Register</strong> on each row that offers it, or recreate
              them.
            </p>
          )}
          {noProvider && (
            <p className="mt-2 text-xs">
              Connect a billing provider in{' '}
              <Link href={`/applications/${id}/billing/providers`} className="underline">
                Billing, Setup, Providers
              </Link>{' '}
              first. Until one is
              configured there is nothing to register these plans with, so <strong>Register</strong>{' '}
              is not offered on the rows below.
            </p>
          )}
        </Banner>
      )}

      <SectionHeader
        title="Plans"
        count={`(${plans.length})`}
        description={
          <>
            What end-users buy. Three kinds:{' '}
            <strong>Subscription</strong> (recurring access),{' '}
            <strong>License</strong> (one purchase auto-issues a software license key),{' '}
            <strong>Usage</strong> (metered, pay per unit consumed). Archive blocks new sign-ups;
            existing subscribers stay. To see which price and provider a buyer in one country gets, use the{' '}
            <Link href={`/applications/${id}/billing/preview`} className="underline hover:text-[var(--color-fg)]">
              routing preview
            </Link>
            .
          </>
        }
        action={
          <Modal
            modalKey="newPlan"
            size="lg"
            title="Create a plan"
            description="Pick the kind first, and the form adapts to show only the fields that kind needs. Slug + name + amount are required for every kind."
            trigger="+ New plan"
          >
            <PlanCreateForm action={action} meters={meterOptions} defaultCurrency={reportingCurrency} error={error} />
          </Modal>
        }
      />

      {plans.length === 0 ? (
        <EmptyState
          icon={
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="6" width="18" height="13" rx="2" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          }
          title="No plans yet"
          description="Create your first plan: a subscription, license, usage-based, or credit pack. Pick the kind in the “+ New plan” modal and the form adapts."
        />
      ) : (
        <PlansTable
          rows={[...active, ...inactive]}
          applicationId={id}
          entBySlug={entBySlug}
          editError={editError}
          editSlug={editSlug}
          priceFlash={priceFlash}
          reportingCurrency={reportingCurrency}
          providerLabel={(name) => providerLabel(providers, name)}
          // With the provider list unreadable there is nothing to judge by, so nothing is claimed.
          unchargeable={(currency) => (providers.length === 0 ? null : unchargeableReason(currencyChoice(currency, providers)))}
        />
      )}
    </div>
    </CurrencyCatalog>
  );
}

