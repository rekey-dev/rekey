import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  api,
  errorQuery,
  readErrorFlash,
  PanelApiError,
  getApplication,
  type UnappliedPaymentRow,
} from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { BillingModeBanner } from '@/components/BillingModeBanner';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { SubmitButton } from '@/components/SubmitButton';
import { Modal } from '@/components/Modal';
import { Banner } from '@/components/Banner';
import { formatDateTime } from '@/lib/date';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { StatusPill } from '@/components/StatusPill';
import { EmptyState } from '@/components/EmptyState';

/**
 * Unapplied payments — money a provider captured for something Rekey never
 * applied. Almost always a checkout that completed at the provider after Rekey
 * had stopped waiting for it, which means the customer probably paid for
 * something they are expecting to receive.
 *
 * Rekey never resolves one of these on its own, so this page is the whole
 * interface: it exists to get a human to decide. Three dispositions — refund
 * the money, keep it and extend the customer, or close the case with a note
 * when it was settled somewhere Rekey cannot see.
 */

const STATUSES = ['OPEN', 'REFUNDED', 'ENTITLEMENT_GRANTED', 'DISMISSED'] as const;
type UnappliedStatus = (typeof STATUSES)[number];

const STATUS_LABEL: Record<UnappliedStatus, string> = {
  OPEN: 'Needs a decision',
  REFUNDED: 'Refunded',
  ENTITLEMENT_GRANTED: 'Access extended',
  DISMISSED: 'Closed',
};

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/**
 * Minor units to a readable amount.
 *
 * The zero-decimal set is small and local on purpose: this is display text,
 * and the integer from the API stays the authority. A blind `/100` would show
 * a ¥5,000 charge as ¥50.
 */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD']);
function money(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const major = ZERO_DECIMAL.has(code) ? String(minor) : (minor / 100).toFixed(2);
  return `${major} ${code}`;
}

/**
 * Colour for the age column.
 *
 * Only an OPEN case is urgent — a resolved one's age is history, and colouring
 * it would put permanent alarm into a list that is mostly resolved rows.
 */
function ageClass(status: UnappliedPaymentRow['status'], ageDays: number): string {
  if (status !== 'OPEN') return '';
  if (ageDays >= 120) return 'text-red-700 dark:text-red-400';
  if (ageDays >= 90) return 'text-amber-700 dark:text-amber-400';
  return '';
}

// ─── Actions ─────────────────────────────────────────────────────────

async function refundCase(applicationId: string, caseId: string, formData: FormData): Promise<void> {
  'use server';
  const raw = String(formData.get('amount') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  // Blank means "everything that remains", which is what every provider does
  // with an absent amount. Rekey never computes the remainder itself.
  const amount = raw ? Math.round(Number(raw) * 100) : undefined;
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/unapplied-payments/${encodeURIComponent(caseId)}/refund`,
      body: { ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}), ...(note ? { note } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/unapplied-payments?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/unapplied-payments?refunded=1`);
}

async function extendCase(applicationId: string, caseId: string, formData: FormData): Promise<void> {
  'use server';
  const days = Number(String(formData.get('days') ?? '').trim());
  const note = String(formData.get('note') ?? '').trim();
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/unapplied-payments/${encodeURIComponent(caseId)}/extend`,
      body: { days, ...(note ? { note } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/unapplied-payments?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/unapplied-payments?extended=1`);
}

async function dismissCase(applicationId: string, caseId: string, formData: FormData): Promise<void> {
  'use server';
  const note = String(formData.get('note') ?? '').trim();
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/unapplied-payments/${encodeURIComponent(caseId)}/dismiss`,
      body: { note },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/unapplied-payments?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/unapplied-payments?dismissed=1`);
}

// ─── Page ────────────────────────────────────────────────────────────

export default async function UnappliedPaymentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const status =
    typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
      ? (sp.status as UnappliedStatus)
      : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const errorCode = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(errorCode);

  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Unapplied payments"
          description="Money a payment provider captured that Rekey could not match to a subscription."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);

  const { items: cases, page } = await api<Page<UnappliedPaymentRow>>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/unapplied-payments?${qs.toString()}`,
  });

  const basePath = `/applications/${id}/unapplied-payments`;
  const filtered = Boolean(status);
  const extraParams: Record<string, string> = {
    ...(status ? { status } : {}),
    ...(PAGE_SIZE !== DEFAULT_PAGE_SIZE ? { ps: String(PAGE_SIZE) } : {}),
  };

  return (
    <div className="space-y-5">
      <BillingModeBanner applicationId={id} />

      <SectionHeader
        title="Unapplied payments"
        count={`(${cases.length === 0 ? 0 : `${offset + 1}–${offset + cases.length}`})`}
        description="Money a payment provider captured that Rekey could not match to any subscription — usually a checkout that finished after Rekey stopped waiting for it. The customer has most likely paid for something they expect to receive. Rekey never refunds these automatically; the decision is yours."
      />

      {errorCode && (
        <Banner tone="error">
          <ApiErrorText code={errorCode} detail={errorDetail} fix={errorFix} fallback={errorCode} />
        </Banner>
      )}
      {sp.refunded && <SavedBanner message="Refund sent to the provider." />}
      {sp.extended && <SavedBanner message="Access extended and the case closed." />}
      {sp.dismissed && <SavedBanner message="Case closed." />}

      {/* Ordering is the feature, not a detail — say so, because it is the
          opposite of every other list in the panel and looks like a bug
          otherwise. */}
      <Banner tone="info">
        Oldest first. Refund windows close (PayPal at 180 days, Razorpay at six months) while
        card-network dispute windows stay open for about 120 days, so the case at the top is the one
        with the least time left. Provider fees are not returned on a refund.
      </Banner>

      <form className="flex flex-wrap items-end gap-2">
        <label className="block space-y-1">
          <span className="block text-xs font-medium text-[var(--color-fg)]">Status</span>
          <select name="status" defaultValue={status ?? ''} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
        >
          Apply
        </button>
        {filtered && (
          <a
            href={basePath}
            className="px-1 py-2 text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            filtered — clear
          </a>
        )}
      </form>

      {cases.length === 0 ? (
        <EmptyState
          title={filtered ? 'No payments match this filter' : 'Nothing unapplied'}
          description={
            filtered
              ? 'Try clearing the status filter.'
              : 'Every payment your providers captured is matched to a subscription. A payment appears here when one arrives that Rekey cannot apply.'
          }
        />
      ) : (
        <Table minWidth="min-w-[58rem]">
          <THead>
            <TR>
              <TH>Received</TH>
              <TH align="right">Age</TH>
              <TH>Customer</TH>
              <TH>Provider</TH>
              <TH align="right">Amount</TH>
              <TH>Status</TH>
              <TH>Resolution</TH>
              <TH align="right">Decide</TH>
            </TR>
          </THead>
          <TBody>
            {cases.map((c) => (
              <TR key={c.id} hover>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(c.openedAt)}
                </TD>
                <TD align="right" mono className="whitespace-nowrap text-xs">
                  {/* The number stops being neutral information as it grows.
                      Amber from 90 days, where a refund starts competing with a
                      chargeback; red past 120, where the card-network filing
                      window has typically closed and the buyer's remaining move
                      is a dispute rather than a request.

                      Tailwind palette classes with a dark: variant, matching
                      Banner — there is no --color-danger token in this design
                      system, and the class that named one resolved to nothing,
                      so every age rendered in the ordinary foreground colour. */}
                  <span className={ageClass(c.status, c.ageDays)}>{c.ageDays}d</span>
                </TD>
                <TD>
                  {c.endUserId && c.endUserEmail ? (
                    <Link
                      href={`/applications/${id}/end-users/${c.endUserId}`}
                      className="text-sm text-[var(--color-fg)] hover:underline"
                    >
                      {c.endUserEmail}
                    </Link>
                  ) : (
                    // Not a blank: an unattributable payment is a materially
                    // worse case and the operator has to go to the provider
                    // dashboard to work out who paid.
                    // Not muted: an unattributable payment is a materially
                    // worse case — the operator has to go to the provider
                    // dashboard to find out who paid — and greying it out
                    // reads as "nothing here" instead.
                    <span className="text-xs text-amber-700 dark:text-amber-400">unknown</span>
                  )}
                </TD>
                {/* Provider name only. The charge id used to sit here too,
                    and a PayPal sale id is 17 mono characters — enough to push
                    the row past the content width and carry the Decide button
                    off the right edge, where the primary action of the page
                    was reachable only by horizontal scroll. The id is not
                    something you scan a list by; it is what you copy once you
                    are acting on one case, so it lives in the dialog. */}
                <TD muted className="text-xs">
                  {c.provider}
                </TD>
                <TD align="right" mono className="whitespace-nowrap text-xs">
                  {money(c.amount, c.currency)}
                  {c.refundedAmount > 0 && (
                    <span className="block text-[0.7rem] text-[var(--color-muted-fg)]">
                      {money(c.refundedAmount, c.currency)} back
                    </span>
                  )}
                </TD>
                <TD>
                  <StatusPill status={c.status} />
                </TD>
                <TD muted className="max-w-[14rem] truncate text-xs" title={c.resolutionNote ?? ''}>
                  {c.resolutionNote ?? '—'}
                </TD>
                <TD align="right">
                  {c.status === 'OPEN' ? (
                    <DecideModal applicationId={id} row={c} />
                  ) : (
                    <span className="text-xs text-[var(--color-muted-fg)]">—</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Pager
        basePath={basePath}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={cases.length}
        hasMore={page.hasMore}
        extraParams={Object.keys(extraParams).length ? extraParams : undefined}
      />

    </div>
  );
}

/**
 * The decision surface for one open case.
 *
 * All three dispositions live in one dialog rather than behind three separate
 * buttons, because the operator's actual question is "which of these do I
 * do?", and that is only answerable with the amount, the age, the customer and
 * the provider in front of them at once.
 */
function DecideModal({
  applicationId,
  row,
}: {
  applicationId: string;
  row: UnappliedPaymentRow;
}): React.JSX.Element {
  const remainingMajor =
    (row.amount - row.refundedAmount) /
    (ZERO_DECIMAL.has(row.currency.toUpperCase()) ? 1 : 100);

  return (
    <Modal
      modalKey="case"
      modalValue={row.id}
      trigger="Decide"
      triggerClassName="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-surface-muted)]"
      title={`${money(row.amount, row.currency)} from ${row.endUserEmail ?? 'an unknown customer'}`}
      description={`Captured at ${row.provider} ${row.ageDays} days ago${
        row.providerPaymentId ? ` as ${row.providerPaymentId}` : ''
      }. Rekey could not match it to a subscription, so nothing was provisioned and nothing was refunded.`}
    >
      <div className="space-y-5 text-sm">
        {/* Refund. Hidden rather than disabled when the provider cannot do it:
            a greyed-out button still reads as "possible later", which for a
            provider with no refund API it is not. */}
        {row.refundable ? (
          <form
            action={refundCase.bind(null, applicationId, row.id)}
            className="space-y-2 rounded-lg border border-[var(--color-border)] p-3"
          >
            <div className="font-medium text-[var(--color-fg)]">Refund the customer</div>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Leave the amount blank to return everything not already refunded. Your provider keeps
              its original processing fee either way.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block space-y-1">
                <span className="block text-xs font-medium">Amount ({row.currency})</span>
                <input
                  name="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder={String(remainingMajor)}
                  className={inputCls}
                />
              </label>
              <label className="block flex-1 space-y-1">
                <span className="block text-xs font-medium">Reason (shown to the buyer)</span>
                <input name="note" type="text" maxLength={500} className={`${inputCls} w-full`} />
              </label>
              <SubmitButton>Refund</SubmitButton>
            </div>
          </form>
        ) : (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-fg)]">
            Rekey cannot issue refunds through {row.provider}. Refund it in the provider dashboard,
            then close this case with a note saying so.
          </div>
        )}

        {/* Extend — the alternative with no precedent among billing vendors,
            who all credit money instead. Rendered only when Rekey knows who
            paid, because there is nobody to extend otherwise. */}
        {row.endUserId ? (
          <form
            action={extendCase.bind(null, applicationId, row.id)}
            className="space-y-2 rounded-lg border border-[var(--color-border)] p-3"
          >
            <div className="font-medium text-[var(--color-fg)]">Keep it and extend their access</div>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Adds days to their current subscription period and re-provisions entitlements. Use
              this when they still want what they paid for.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block space-y-1">
                <span className="block text-xs font-medium">Days</span>
                <input
                  name="days"
                  type="number"
                  min="1"
                  max="3650"
                  defaultValue="30"
                  required
                  className={inputCls}
                />
              </label>
              <label className="block flex-1 space-y-1">
                <span className="block text-xs font-medium">Note (internal)</span>
                <input name="note" type="text" maxLength={500} className={`${inputCls} w-full`} />
              </label>
              <SubmitButton>Extend</SubmitButton>
            </div>
          </form>
        ) : (
          <div className="rounded-lg border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted-fg)]">
            Rekey does not know which customer this came from, so it cannot extend anyone. Find them
            in the {row.provider} dashboard using the charge id, then extend from their end-user
            page.
          </div>
        )}

        {/* Dismiss. The note is required because this is the only disposition
            that leaves no other record of where the money went. */}
        <form
          action={dismissCase.bind(null, applicationId, row.id)}
          className="space-y-2 rounded-lg border border-[var(--color-border)] p-3"
        >
          <div className="font-medium text-[var(--color-fg)]">Close without moving money</div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            For when you settled it somewhere Rekey cannot see. The note is the only record of what
            happened, so it is required.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 space-y-1">
              <span className="block text-xs font-medium">What happened</span>
              <input
                name="note"
                type="text"
                required
                minLength={1}
                maxLength={500}
                // Names the row's OWN provider. It said "Stripe" for every
                // case, which is wrong example text on a PayPal or Razorpay
                // one and points the operator at the wrong dashboard.
                placeholder={`Refunded by hand in the ${row.provider} dashboard`}
                className={`${inputCls} w-full`}
              />
            </label>
            <SubmitButton>Close case</SubmitButton>
          </div>
        </form>
      </div>
    </Modal>
  );
}
