import * as React from 'react';
import { redirect } from 'next/navigation';
import { errorQuery, api, PanelApiError, type PlanRow, type UsageMeterRow, type PlanEntitlementRow, getApplication } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { formatMoney } from '@/lib/format';
import { BillingModeBanner } from '@/components/BillingModeBanner';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Modal } from '@/components/Modal';
import { PlanCreateForm } from '@/components/PlanCreateForm';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { EntitlementForm } from './EntitlementForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

async function createPlan(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const amount = Number(formData.get('amount') ?? 0);
  const currency = String(formData.get('currency') ?? 'USD').toUpperCase();
  const interval = String(formData.get('interval') ?? 'MONTH');
  const kind = String(formData.get('kind') ?? 'SUBSCRIPTION') as 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';
  const licenseKind = String(formData.get('licenseKind') ?? '');
  const licenseDurationDays = Number(formData.get('licenseDurationDays') ?? 0);
  const licenseSeatsAllowed = Number(formData.get('licenseSeatsAllowed') ?? 0);
  const meterSlug = String(formData.get('meterSlug') ?? '').trim();
  const pricePerUnitCents = Number(formData.get('pricePerUnitCents') ?? 0);
  const creditsAmount = Number(formData.get('creditsAmount') ?? 0);

  if (!slug || !name || !Number.isInteger(amount) || amount < 0) {
    redirect(`/applications/${applicationId}/plans?error=missing&newPlan=1`);
  }
  const body: Record<string, unknown> = { slug, name, amount, currency, interval, kind };
  if (kind === 'LICENSE') {
    if (licenseKind) body.licenseKind = licenseKind;
    if (licenseKind === 'TIMED' && licenseDurationDays > 0) body.licenseDurationDays = licenseDurationDays;
    if (licenseKind === 'SEATS' && licenseSeatsAllowed > 0) body.licenseSeatsAllowed = licenseSeatsAllowed;
  }
  if (kind === 'USAGE') {
    if (meterSlug) body.meterSlug = meterSlug;
    if (Number.isInteger(pricePerUnitCents) && pricePerUnitCents >= 0) body.pricePerUnitCents = pricePerUnitCents;
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
  // a per-entitlement failure surfaces an error but keeps the `created` flag —
  // the operator sees the plan and can fix the bundle in the Entitlements modal.
  const entitlementsRaw = String(formData.get('entitlements') ?? '[]');
  let entitlements: Array<Record<string, unknown>> = [];
  try {
    const parsed: unknown = JSON.parse(entitlementsRaw);
    if (Array.isArray(parsed)) entitlements = parsed as Array<Record<string, unknown>>;
  } catch {
    // Ignore a malformed payload — the plan is still created without add-ons.
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

async function registerPlan(applicationId: string, slug: string): Promise<void> {
  'use server';
  await api({
    method: 'POST',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/register`,
  });
  // `redirect`, not `revalidatePath` — matching every other action in this
  // file. A same-action revalidatePath kills Next's seeded prefetch here and
  // the page renders blank for a full RSC round-trip.
  redirect(`/applications/${applicationId}/plans`);
}

async function setPlanActive(applicationId: string, slug: string, active: boolean): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}`,
    body: { active },
  });
  redirect(`/applications/${applicationId}/plans`);
}

async function addEntitlement(applicationId: string, slug: string, formData: FormData): Promise<void> {
  'use server';
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
    // Empty means "hard cap", which is not the same as zero — zero is a real
    // price meaning "charge nothing per unit". Read the raw field so the two
    // stay distinguishable.
    const rawRate = String(formData.get('creditsPerUnit') ?? '').trim();
    if (rawRate !== '') body.creditsPerUnit = Number(rawRate);
  }

  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/entitlements`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/plans?entError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/plans?entSaved=${encodeURIComponent(slug)}`);
}

async function removeEntitlement(applicationId: string, slug: string, entId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/plans/${encodeURIComponent(slug)}/entitlements/${encodeURIComponent(entId)}`,
  });
  redirect(`/applications/${applicationId}/plans`);
}

/** Compact human label for an entitlement chip. */
function entitlementLabel(e: PlanEntitlementRow): string {
  switch (e.kind) {
    case 'FEATURE':
      return `${e.key}=${e.value}`;
    case 'CREDIT':
      return `${e.quantity} credits`;
    case 'LICENSE':
      return e.licenseKind === 'SEATS' ? `${e.quantity ?? 0} seats` : `license (${e.licenseKind?.toLowerCase()})`;
    case 'USAGE':
      // Deliberately does NOT claim "hard cap" when the entitlement carries no
      // price: the meter itself may price the overage as a fallback, and this
      // view cannot see the meter. Saying "hard cap" over a meter that is
      // charging is the worse of the two wrong answers, so say less.
      return e.creditsPerUnit == null
        ? `${e.key} ≤ ${e.quantity}`
        : `${e.key}: ${e.quantity} included, then ${e.creditsPerUnit}cr/unit`;
    default:
      return e.kind;
  }
}

const ERR: Record<string, string> = {
  missing: 'All fields required + amount must be a non-negative integer (cents).',
  PLAN_SLUG_INVALID: 'Slug must be lowercase letters/digits/-/_.',
  PLAN_SLUG_TAKEN: 'A plan with that slug already exists.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage plans.',
  PLAN_ENTITLEMENT_INVALID: 'Entitlement is missing required fields for its kind.',
  PLAN_ENTITLEMENT_NOT_FOUND: 'Entitlement not found.',
  // The plan row is written either way and lands as "not registered" — say so,
  // rather than leaving the operator with the bare code and no idea whether
  // anything was saved.
  BILLING_PROVIDER_ERROR:
    'Your payment provider refused to register this plan, so it was saved but is not on sale. Check the credentials under Billing → Providers, then use “Retry registration” on the plan.',
  BILLING_CREDENTIALS_NOT_CONFIGURED:
    'No payment provider is configured yet. Add one under Billing → Providers before creating plans.',
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

  // Billing master switch off → point at the switch instead of an empty table
  // (same guard the Revenue page renders; the tab group is hidden but the URL
  // stays reachable).
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Plans"
          description="What end-users buy — subscriptions, licenses, usage-based pricing, or credit packs."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const [planPage, meterPage] = await Promise.all([
    api<Page<PlanRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans`,
    }),
    api<Page<UsageMeterRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/usage-meters`,
    }).catch(() => emptyPage<UsageMeterRow>()),
  ]);
  const plans = planPage.items;
  const meters = meterPage.items;
  // Per-plan entitlement bundles (one round-trip each; plan counts are small).
  const entLists = await Promise.all(
    plans.map((p) =>
      api<PlanEntitlementRow[]>({
        method: 'GET',
        path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/plans/${encodeURIComponent(p.slug)}/entitlements`,
      }).catch(() => [] as PlanEntitlementRow[]),
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

  return (
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
          {ERR[entError] ?? entError}
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
            existing subscribers stay.
          </>
        }
        action={
          <Modal
            modalKey="newPlan"
            size="lg"
            title="Create a plan"
            description="Pick the kind first — the form adapts to show only the fields that kind needs. Slug + name + amount are required for every kind."
            trigger="+ New plan"
          >
            <PlanCreateForm action={action} meters={meterOptions} error={error} />
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
          description="Create your first plan — a subscription, license, usage-based, or credit pack. Pick the kind in the “+ New plan” modal and the form adapts."
        />
      ) : (
        <PlansTable
          rows={[...active, ...inactive]}
          applicationId={id}
          entBySlug={entBySlug}
        />
      )}
    </div>
  );
}

function PlansTable({
  rows,
  applicationId,
  entBySlug,
}: {
  rows: PlanRow[];
  applicationId: string;
  entBySlug: Record<string, PlanEntitlementRow[]>;
}): React.JSX.Element {
  return (
    <Table minWidth="min-w-[60rem]">
      <THead>
        <TR>
          <TH>Slug</TH>
          <TH>Name</TH>
          <TH>Kind</TH>
          <TH>Entitlements</TH>
          <TH align="right">Price</TH>
          <TH>Interval</TH>
          <TH>Status</TH>
          <TH align="right"> </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((p) => {
          const ents = entBySlug[p.slug] ?? [];
          return (
            <TR key={p.id} hover>
              <TD>
                <Badge tone="neutral" mono>{p.slug}</Badge>
              </TD>
              <TD className="font-medium">{p.name}</TD>
              <TD className="text-xs">
                <Badge tone="brand" mono>{(p.kind ?? 'SUBSCRIPTION').toLowerCase()}</Badge>
                {p.kind === 'LICENSE' && p.licenseKind && (
                  <span className="ml-1.5 text-[var(--color-muted-fg)]">· {p.licenseKind.toLowerCase()}</span>
                )}
                {p.kind === 'USAGE' && p.meterSlug && (
                  <span className="ml-1.5 font-mono text-[var(--color-muted-fg)]">
                    · {p.meterSlug} @ {p.pricePerUnitCents}¢/unit
                  </span>
                )}
                {p.kind === 'CREDIT' && p.creditsAmount && (
                  <span className="ml-1.5 font-mono text-[var(--color-muted-fg)]">
                    · {p.creditsAmount} credits
                  </span>
                )}
              </TD>
              <TD>
                <div className="flex max-w-[16rem] flex-wrap items-center gap-1">
                  {ents.slice(0, 4).map((e) => (
                    <Badge key={e.id} tone="neutral">{entitlementLabel(e)}</Badge>
                  ))}
                  {ents.length > 4 && (
                    <span className="text-[11px] text-[var(--color-faint-fg)]">+{ents.length - 4}</span>
                  )}
                  {ents.length === 0 && (
                    <span className="text-[11px] text-[var(--color-faint-fg)]">—</span>
                  )}
                </div>
              </TD>
              <TD align="right" mono>{formatMoney(p.amount, p.currency)}</TD>
              <TD muted className="text-xs">
                {p.kind === 'CREDIT' || (p.kind === 'LICENSE' && p.licenseKind !== 'TIMED') ? 'one-time' : p.interval}
              </TD>
              <TD>
                {p.registrationStatus === 'FAILED' ? (
                  // The provider's own reason is the only actionable thing
                  // here ("Invalid API Key provided: sk_test_…"), and it was
                  // reachable only by hovering — invisible on touch and to
                  // keyboard users. Show it inline; keep the title for the
                  // full text when it is truncated.
                  <span
                    className="inline-flex flex-col items-start gap-0.5"
                    title={p.registrationError ?? undefined}
                  >
                    <Badge tone="danger" dot>not registered</Badge>
                    {p.registrationError && (
                      <span className="block max-w-[9rem] truncate text-[10px] text-[var(--color-muted-fg)]">
                        {p.registrationError}
                      </span>
                    )}
                  </span>
                ) : p.registrationStatus === 'PENDING' ? (
                  <Badge tone="neutral" dot>registering…</Badge>
                ) : p.active ? (
                  <Badge tone="success" dot>active</Badge>
                ) : (
                  <Badge tone="neutral" dot>archived</Badge>
                )}
              </TD>
              <TD align="right">
                <div className="flex items-center justify-end gap-3">
                  <Modal
                    modalKey={`ent_${p.slug}`}
                    size="lg"
                    title={`Entitlements — ${p.slug}`}
                    description="The benefit bundle this plan grants on purchase (licenses, credits, feature flags, usage allowance). Materialized onto the buyer when the subscription activates."
                    trigger="Entitlements"
                    triggerClassName="cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
                  >
                    <div className="space-y-4">
                      {ents.length > 0 ? (
                        <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
                          {ents.map((e) => (
                            <li key={e.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                              <span className="text-[var(--color-fg)]">
                                <Badge tone="neutral" mono className="mr-1.5">{e.kind}</Badge>
                                {entitlementLabel(e)}
                              </span>
                              <form action={removeEntitlement.bind(null, applicationId, p.slug, e.id)}>
                                <ConfirmButton confirm={`Remove "${entitlementLabel(e)}" from ${p.slug}? Future purchases stop granting it; already-materialized grants on existing buyers are unaffected.`}>
                                  Remove
                                </ConfirmButton>
                              </form>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-[var(--color-muted-fg)]">
                          No entitlements yet. A plan with none falls back to its legacy kind on purchase.
                        </p>
                      )}
                      <EntitlementForm action={addEntitlement.bind(null, applicationId, p.slug)} />
                    </div>
                  </Modal>
                  {p.registrationStatus === 'FAILED' || p.registrationStatus === 'PENDING' ? (
                    // Activating an unregistered plan is refused by the API —
                    // nothing can be sold against it until the provider accepts
                    // it. Offering "Reactivate" here would be a button whose
                    // only outcome is an error, so this offers the repair the
                    // API actually wants instead.
                    <form action={registerPlan.bind(null, applicationId, p.slug)} className="inline">
                      <SubmitButton
                        pendingLabel="Registering…"
                        className="rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        Retry registration
                      </SubmitButton>
                    </form>
                  ) : (
                  <form action={setPlanActive.bind(null, applicationId, p.slug, !p.active)} className="inline">
                    {p.active ? (
                      <ConfirmButton confirm={`Archive plan "${p.slug}"? End-users on this plan stay subscribed; new sign-ups are blocked.`}>
                        Archive
                      </ConfirmButton>
                    ) : (
                      <SubmitButton
                        pendingLabel="Reactivating…"
                        className="rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        Reactivate
                      </SubmitButton>
                    )}
                  </form>
                  )}
                </div>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
