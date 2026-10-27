import * as React from 'react';
import type { PlanEntitlementRow, PlanRow } from '@/lib/api';
import { additionalCurrenciesLabel, additionalPricesOf, defaultPriceOf, planPriceText } from '@/lib/plan-prices';
import { registerCanHelp } from '@/lib/plan-blockers';
import { ActionForm } from '@/components/ActionForm';
import { Badge } from '@/components/Badge';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Modal } from '@/components/Modal';
import { PlanEditForm } from '@/components/PlanEditForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { EntitlementForm } from './EntitlementForm';
import { addEntitlement, removeEntitlement } from './entitlement-actions';
import { editPlan, registerPlan, setPlanActive } from './plan-actions';
import { PlanBlockers } from './PlanBlockers';
import { PlanPricesSection, type PlanPriceFlash } from './PlanPricesSection';

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

export function PlansTable({
  rows,
  applicationId,
  entBySlug,
  editError,
  editSlug,
  priceFlash,
  reportingCurrency,
  providerLabel,
  unchargeable,
}: {
  rows: PlanRow[];
  applicationId: string;
  /** The currency of a plan with no flat price. */
  reportingCurrency: string;
  providerLabel: (name: string) => string;
  /** Why no enabled provider can charge a currency, or null when one can. */
  unchargeable: (currency: string) => string | null;
  entBySlug: Record<string, PlanEntitlementRow[]>;
  /** Failure from the last Edit submit, rendered inside that plan's modal. */
  editError?: string | undefined;
  editSlug?: string | undefined;
  /** Result of the last price action, rendered inside that plan's edit modal. */
  priceFlash: PlanPriceFlash;
}): React.JSX.Element {
  return (
    <Table minWidth="min-w-[60rem]">
      <THead>
        <TR>
          <TH>Slug</TH>
          <TH>Name</TH>
          <TH>Kind</TH>
          <TH>What&apos;s included</TH>
          <TH align="right">Price</TH>
          <TH>Interval</TH>
          <TH>Status</TH>
          <TH align="right"> </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((p) => {
          const ents = entBySlug[p.slug] ?? [];
          const defaultPrice = defaultPriceOf(p);
          const planCurrency = defaultPrice?.currency ?? reportingCurrency;
          const moreCurrencies = additionalCurrenciesLabel(additionalPricesOf(p));
          const blockers = p.checkout?.blockers ?? [];
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
                    · {p.meterSlug}
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
                    <span className="text-[11px] text-[var(--color-faint-fg)]">None</span>
                  )}
                </div>
              </TD>
              <TD align="right" mono>
                {planPriceText(p)}
                {moreCurrencies && (
                  <span className="block font-sans text-[11px] text-[var(--color-muted-fg)]">{moreCurrencies}</span>
                )}
              </TD>
              <TD muted className="text-xs">
                {p.kind === 'CREDIT' || (p.kind === 'LICENSE' && p.licenseKind !== 'TIMED') ? 'one-time' : p.interval}
              </TD>
              <TD>
                {p.registrationStatus === 'FAILED' ? (
                  // The provider's own reason is the only actionable thing
                  // here ("Invalid API Key provided: sk_test_…"), and it was
                  // reachable only by hovering, invisible on touch and to
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
                ) : p.checkout?.ready === false ? (
                  // `active` and buyable are different facts, and this is the
                  // row where they disagree. Showing "active" here would be
                  // technically true and the most misleading thing on the page.
                  <span
                    className="inline-flex flex-col items-start gap-0.5"
                    title={p.checkout.blockers.map((b) => b.message).join(' ')}
                  >
                    <Badge tone="danger" dot>cannot be bought</Badge>
                    <span className="block max-w-[9rem] truncate text-[10px] text-[var(--color-muted-fg)]">
                      {p.checkout.blockers[0]?.message ?? 'No provider will accept this plan.'}
                    </span>
                  </span>
                ) : p.active ? (
                  <Badge tone="success" dot>active</Badge>
                ) : (
                  <Badge tone="neutral" dot>archived</Badge>
                )}
              </TD>
              <TD align="right">
                <div className="flex items-center justify-end gap-3">
                  <Modal
                    modalKey="editSlug"
                    modalValue={p.slug}
                    size="lg"
                    title={`Edit plan: ${p.slug}`}
                    description="Rename the plan, correct its default price while no provider holds it, and manage its prices in other currencies. The slug is permanent because your integration passes it to checkout."
                    trigger="Edit"
                    triggerClassName="inline-block py-1.5 cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
                  >
                    <PlanBlockers
                      blockers={blockers}
                      applicationId={applicationId}
                      providerLabel={providerLabel}
                      register={(label) => (
                        <ActionForm action={registerPlan.bind(null, applicationId, p.slug)} className="inline">
                          <SubmitButton
                            pendingLabel="Registering…"
                            className="rounded text-xs font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                          >
                            {label}
                          </SubmitButton>
                        </ActionForm>
                      )}
                    />
                    <PlanEditForm
                      plan={{
                        slug: p.slug,
                        name: p.name,
                        price: defaultPrice ? { amount: defaultPrice.amount, currency: defaultPrice.currency } : null,
                        unpricedCurrency: reportingCurrency,
                        interval: p.interval,
                        // A provider price is immutable once minted, so the
                        // price inputs only render while none exists. The API
                        // says so per price; a plan with no price row has no
                        // such answer, and is read from its own registration.
                        priceEditable: defaultPrice?.amountEditable ?? p.registrationStatus !== 'REGISTERED',
                      }}
                      action={editPlan.bind(null, applicationId, { slug: p.slug, currency: planCurrency })}
                      error={editSlug === p.slug ? editError : undefined}
                    />
                    {defaultPrice !== null && p.kind !== 'USAGE' ? (
                      <PlanPricesSection
                        applicationId={applicationId}
                        plan={{ id: p.id, slug: p.slug, prices: p.prices, localPrices: p.localPrices }}
                        flash={editSlug === p.slug ? priceFlash : {}}
                        unchargeable={unchargeable}
                      />
                    ) : (
                      <p className="border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-muted-fg)]">
                        {p.kind === 'USAGE'
                          ? 'A usage plan is sold at one price only, so it cannot carry prices in other currencies. Create a separate usage plan for each currency.'
                          : 'A free plan has no price, so there is none to offer in another currency. Give it an amount above to add prices.'}
                      </p>
                    )}
                  </Modal>
                  <Modal
                    modalKey={`ent_${p.slug}`}
                    size="lg"
                    title={`What's included: ${p.name}`}
                    description="What a buyer gets with this plan: licenses, credits, features and usage allowance. They receive it when their subscription starts."
                    trigger="What's included"
                    triggerClassName="inline-block py-1.5 cursor-pointer rounded text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
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
                              <ActionForm action={removeEntitlement.bind(null, applicationId, p.slug, e.id)}>
                                <ConfirmButton title="Remove plan entitlement?" confirm={`Remove "${entitlementLabel(e)}" from ${p.slug}? Future purchases stop granting it; already-materialized grants on existing buyers are unaffected.`}>
                                  Remove
                                </ConfirmButton>
                              </ActionForm>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-[var(--color-muted-fg)]">
                          Nothing added yet. A plan with nothing here grants what its plan type gives by default.
                        </p>
                      )}
                      <EntitlementForm action={addEntitlement.bind(null, applicationId, p.slug)} />
                    </div>
                  </Modal>
                  {p.checkout?.ready === false &&
                    // Withheld when registering cannot clear what blocks the
                    // plan (no provider connected, or none that can charge its
                    // currency). Offering it there put a button on a live plan
                    // whose sole outcome was an error, in the very state this
                    // feature was written to explain.
                    registerCanHelp(p.checkout.blockers) &&
                    p.registrationStatus !== 'FAILED' &&
                    p.registrationStatus !== 'PENDING' && (
                      // Offered alongside Archive rather than instead of it:
                      // this plan is live and the operator may reasonably want
                      // either to fix it or to pull it down.
                      <ActionForm action={registerPlan.bind(null, applicationId, p.slug)} className="inline">
                        <SubmitButton
                          pendingLabel="Registering…"
                          className="inline-block py-1.5 rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                        >
                          Register
                        </SubmitButton>
                      </ActionForm>
                    )}
                  {p.registrationStatus === 'FAILED' || p.registrationStatus === 'PENDING' ? (
                    // Activating an unregistered plan is refused by the API,
                    // nothing can be sold against it until the provider accepts
                    // it. Offering "Reactivate" here would be a button whose
                    // only outcome is an error, so this offers the repair the
                    // API actually wants instead.
                    <ActionForm action={registerPlan.bind(null, applicationId, p.slug)} className="inline">
                      <SubmitButton
                        pendingLabel="Registering…"
                        className="inline-block py-1.5 rounded text-xs font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        Retry registration
                      </SubmitButton>
                    </ActionForm>
                  ) : (
                  <ActionForm action={setPlanActive.bind(null, applicationId, p.slug, !p.active)} className="inline">
                    {p.active ? (
                      <ConfirmButton title="Archive plan?" confirm={`Archive plan "${p.slug}"? End-users on this plan stay subscribed; new sign-ups are blocked.`}>
                        Archive
                      </ConfirmButton>
                    ) : (
                      <SubmitButton
                        pendingLabel="Reactivating…"
                        className="inline-block py-1.5 rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        Reactivate
                      </SubmitButton>
                    )}
                  </ActionForm>
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
