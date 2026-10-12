import * as React from 'react';
import { UNAVAILABLE_CURRENCY } from '@/lib/billing-config';
import type { RoutingPreviewDto, RoutingPreviewItem } from '@rekey.dev/shared-types';
import Link from '@/components/Link';
import { api, getApplication, PanelApiError, unlessBusy } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { Card } from '@/components/Card';
import { CurrencyCatalog } from '@/components/CurrencyCatalog';
import { EmptyState } from '@/components/EmptyState';
import { toChargingProviders } from '@/lib/price-currencies';
import { countryName, previewRequest, priceReasonText, providerReasonText, readPreviewFields } from '@/lib/routing-preview';
import { BillingOffState } from '../notices';
import { getBillingProviders, getPlans, isInboundOnly, providerLabel } from '../shared';
import { PreviewForm } from './PreviewForm';

type Outcome = { ok: true; data: RoutingPreviewDto } | { ok: false; message: string; fix: string | undefined };

async function runPreview(applicationId: string, body: object): Promise<Outcome> {
  try {
    const data = await api<RoutingPreviewDto>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/billing/checkout/preview`,
      body,
      interruptOnAccessError: false,
    });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof PanelApiError) {
      return unlessBusy<Outcome>(() => ({ ok: false, message: err.message, fix: err.fix }))(err);
    }
    throw err;
  }
}

function Refusal({ title, refusal }: { title: string; refusal: { code: string; message: string; fix: string | null } }): React.JSX.Element {
  return (
    <div className="rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">
      <p className="font-medium">
        {title} <code className="font-mono text-xs">{refusal.code}</code>
      </p>
      <p className="mt-0.5 text-xs">{refusal.message}</p>
      {refusal.fix && (
        <p className="mt-0.5 text-xs opacity-90">
          <span className="font-medium">To repair: </span>
          {refusal.fix}
        </p>
      )}
    </div>
  );
}

function PreviewItem({ item, label }: { item: RoutingPreviewItem; label: (name: string) => string }): React.JSX.Element {
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">{item.plan.name}</h3>
        <Badge tone="neutral" mono>{item.plan.slug}</Badge>
        {item.refusal ? (
          <Badge tone="danger" dot>checkout refused</Badge>
        ) : item.priceFallback ? (
          <Badge tone="warning" dot>default price used</Badge>
        ) : (
          <Badge tone="success" dot>checkout opens</Badge>
        )}
      </div>
      <p className="text-sm text-[var(--color-fg)]">{item.summary}</p>

      {item.refusal && <Refusal title="Checkout would answer" refusal={item.refusal} />}

      {(item.price || item.provider) && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          {item.price && (
            <>
              <dt className="text-xs text-[var(--color-muted-fg)]">Price charged</dt>
              <dd>
                <span className="font-mono">{item.price.formatted}</span>{' '}
                <span className="text-xs text-[var(--color-muted-fg)]">
                  {item.price.currency}
                  {item.price.isDefault ? ', the default price' : ', a local price'}
                </span>
              </dd>
              <dt className="text-xs text-[var(--color-muted-fg)]">Why this price</dt>
              <dd className="text-xs">Because {priceReasonText(item.price.reason)}.</dd>
            </>
          )}
          {item.priceFallback && (
            <>
              <dt className="text-xs text-[var(--color-muted-fg)]">Price selected first</dt>
              <dd className="text-xs">
                <span className="font-mono">{item.priceFallback.requested.formatted}</span> in{' '}
                {item.priceFallback.requested.currency}, which no enabled provider can charge. The buyer is
                told before paying that they will be charged {item.priceFallback.charged.formatted}, and the
                billing log records it.
              </dd>
            </>
          )}
          {item.provider && (
            <>
              <dt className="text-xs text-[var(--color-muted-fg)]">Provider</dt>
              <dd>{label(item.provider)}</dd>
              {item.providerReason && (
                <>
                  <dt className="text-xs text-[var(--color-muted-fg)]">Why this provider</dt>
                  <dd className="text-xs">Because {providerReasonText(item.providerReason)}.</dd>
                </>
              )}
            </>
          )}
        </dl>
      )}
      {!item.price && !item.refusal && (
        <p className="text-xs text-[var(--color-muted-fg)]">This plan has no flat price, so there is none to charge at checkout.</p>
      )}

      {item.coupon &&
        (item.coupon.discount ? (
          <p className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            Coupon <code className="font-mono text-xs uppercase">{item.coupon.code}</code> takes{' '}
            <span className="font-mono">{item.coupon.discount.formatted.discount}</span> off. The buyer pays{' '}
            <span className="font-mono">{item.coupon.discount.formatted.total}</span>.
          </p>
        ) : item.coupon.refusal ? (
          <Refusal title={`Coupon ${item.coupon.code.toUpperCase()} is refused, and so is a checkout carrying it:`} refusal={item.coupon.refusal} />
        ) : null)}
    </Card>
  );
}

export default async function RoutingPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const fields = readPreviewFields(await searchParams);
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) return <BillingOffState applicationId={id} what="the routing preview" />;

  const request = previewRequest(fields);
  const [planPage, providers, outcome] = await Promise.all([
    getPlans(id),
    getBillingProviders(id).catch(unlessBusy(() => [])),
    request.kind === 'ready' ? runPreview(id, request.body) : null,
  ]);
  const plans = (planPage?.items ?? []).filter((plan) => plan.active).map((plan) => ({ slug: plan.slug, name: plan.name }));
  const routable = providers.filter((provider) => provider.status?.enabled === true && !isInboundOnly(provider));
  const label = (name: string): string => providerLabel(providers, name);

  return (
    <CurrencyCatalog providers={toChargingProviders(providers)} first={app.billingConfig.reportingCurrency}>
      <div className="space-y-5">
        <Banner tone="info">
          This is a preview. It opens no checkout, charges nobody, calls no provider and writes nothing to
          the billing log. It answers with the same functions checkout runs, from your plans, prices and
          providers as they are now.
        </Banner>
        <Card>
          <PreviewForm
            key={JSON.stringify(fields)}
            initial={fields}
            plans={plans}
            providers={routable.map((provider) => ({ name: provider.name, label: provider.label }))}
            applicationDefault={app.billingConfig.onUnavailableCurrency}
          />
        </Card>

        {request.kind === 'invalid' && <Banner tone="error">{request.reason}</Banner>}
        {outcome !== null && !outcome.ok && (
          <Banner tone="error">
            {outcome.message}
            {outcome.fix && <span className="mt-1 block opacity-90">{outcome.fix}</span>}
          </Banner>
        )}

        {outcome?.ok && (
          <section className="space-y-3" aria-labelledby="preview-result">
            <h2 id="preview-result" className="text-sm font-semibold text-[var(--color-fg)]">
              A buyer in {countryName(outcome.data.country) ?? outcome.data.country} ({outcome.data.country})
            </h2>
            <p className="max-w-prose text-xs text-[var(--color-muted-fg)]">
              Local prices on this Application are open to{' '}
              {outcome.data.localPrices === 'any' ? 'any country a buyer states' : 'a verified country only'}.{' '}
              <Link href={`/applications/${id}/billing/settings`} className="underline hover:text-[var(--color-fg)]">
                Change it in Settings
              </Link>
              .
              {request.kind === 'ready' && request.body.currency !== undefined && (
                <>
                  {' '}
                  For a named currency nobody can charge, this preview applied:{' '}
                  {UNAVAILABLE_CURRENCY[outcome.data.onUnavailableCurrency].label.toLowerCase()} (
                  {request.body.onUnavailableCurrency === undefined ? 'this Application’s default' : 'what the request says'}).
                </>
              )}
            </p>
            {outcome.data.items.length === 0 ? (
              <EmptyState
                variant="inline"
                title="No active plan to preview"
                description="The preview covers active plans. Create or reactivate one under Plans."
              />
            ) : (
              outcome.data.items.map((item) => <PreviewItem key={item.plan.id} item={item} label={label} />)
            )}
          </section>
        )}

        {request.kind === 'empty' && (
          <EmptyState
            variant="inline"
            title="Pick a country to see what a buyer there gets"
            description="For each plan: the price and currency they are charged, the provider that charges it, and why. A fallback to the default price and a refusal are shown the way the buyer would meet them."
          />
        )}
      </div>
    </CurrencyCatalog>
  );
}
