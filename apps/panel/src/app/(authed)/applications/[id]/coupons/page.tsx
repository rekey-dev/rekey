import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, PanelApiError, type CouponRow, getApplication } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { formatDate } from '@/lib/date';
import { Modal } from '@/components/Modal';
import { CouponAmountPreview } from '@/components/CouponAmountPreview';
import { Pager, readPageSize } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { formatMoney } from '@/lib/format';
import { BillingModeBanner } from '@/components/BillingModeBanner';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

async function createCoupon(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const code = String(formData.get('code') ?? '').trim();
  const discountType = String(formData.get('discountType') ?? 'PERCENT');
  const amountOffRaw = String(formData.get('amountOff') ?? '0').trim();
  const currency = String(formData.get('currency') ?? '').trim().toUpperCase();
  const planSlugsRaw = String(formData.get('planSlugs') ?? '').trim();
  const maxRedemptionsRaw = String(formData.get('maxRedemptions') ?? '').trim();
  const maxPerUserRaw = String(formData.get('maxRedemptionsPerUser') ?? '').trim();
  const endsAtRaw = String(formData.get('endsAt') ?? '').trim();

  if (!code || !amountOffRaw) {
    redirect(`/applications/${applicationId}/coupons?error=missing&newCoupon=1`);
  }
  // PERCENT: amountOff is basis points (percent × 100; the service divides by 10000) (1500 = 15%). UI accepts a percent (e.g. 15) and converts.
  let amountOff: number;
  if (discountType === 'PERCENT') {
    const pct = Number(amountOffRaw);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      redirect(`/applications/${applicationId}/coupons?error=missing&newCoupon=1`);
    }
    amountOff = Math.round(pct * 100);
  } else {
    amountOff = Number(amountOffRaw);
    if (!Number.isInteger(amountOff) || amountOff <= 0) {
      redirect(`/applications/${applicationId}/coupons?error=missing&newCoupon=1`);
    }
  }

  const body: Record<string, unknown> = { code, discountType, amountOff };
  if (discountType === 'AMOUNT' && currency.length === 3) body.currency = currency;
  if (planSlugsRaw) {
    body.planSlugs = planSlugsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (maxRedemptionsRaw) body.maxRedemptions = Number(maxRedemptionsRaw);
  if (maxPerUserRaw) body.maxRedemptionsPerUser = Number(maxPerUserRaw);
  if (endsAtRaw) body.endsAt = new Date(endsAtRaw).toISOString();

  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/coupons`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/coupons?error=${encodeURIComponent(err.code)}&newCoupon=1`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/coupons?created=${encodeURIComponent(code)}&e=coupon_created`);
}

async function setCouponActive(
  applicationId: string,
  code: string,
  active: boolean,
): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/coupons/${encodeURIComponent(code)}`,
    body: { active },
  });
  redirect(`/applications/${applicationId}/coupons`);
}

const ERR: Record<string, string> = {
  missing: 'Code and a valid amount are required. PERCENT must be 1–100; AMOUNT must be a positive integer (cents).',
  COUPON_CODE_TAKEN: 'A coupon with that code already exists.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can create coupons.',
};

function formatDiscount(c: CouponRow): string {
  if (c.discountType === 'PERCENT') {
    return `${(c.amountOff / 100).toFixed(c.amountOff % 100 === 0 ? 0 : 2)}%`;
  }
  const major = (c.amountOff / 100).toFixed(2);
  return `${major} ${c.currency ?? ''}`.trim();
}

export default async function CouponsPage({
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
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;

  // Billing master switch off → point at the switch instead of an empty table.
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Coupons"
          description="Discount codes applied at checkout."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const { items: coupons, page } = await api<Page<CouponRow>>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/coupons?limit=${PAGE_SIZE}&offset=${offset}`,
  });
  const action = createCoupon.bind(null, id);

  const active = coupons.filter((c) => c.active);
  const inactive = coupons.filter((c) => !c.active);

  return (
    <div className="space-y-5">
      <BillingModeBanner applicationId={id} />
      {created && <SavedBanner params={['created']} message={`Coupon ${created} created.`} />}

      <SectionHeader
        title="Coupons"
        count={`(${coupons.length})`}
        description="Discount codes applied at checkout. Codes are case-insensitive and unique per Application. Validation happens before payment — bad codes fail the whole checkout."
        action={
          <Modal
            modalKey="newCoupon"
            title="Add a coupon"
            description="Pick PERCENT (e.g. 15 = 15% off) or AMOUNT (e.g. 500 = $5.00 off — enter the value in cents). Caps and expiry are optional."
            trigger="+ New coupon"
          >
            <form action={action} className="space-y-3">
              {error && (
                <Banner tone="error">
                  {ERR[error] ?? error}
                </Banner>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Code" hint="Shown to end-users at checkout (case-insensitive)">
                  <input
                    type="text" name="code" required placeholder="LAUNCH50" maxLength={40} autoFocus
                    className={`${inputCls} font-mono uppercase`}
                  />
                </Field>
                <CouponAmountPreview inputClassName={inputCls} />
                <Field label="Restrict to plans" hint="Comma-separated plan slugs; leave empty to apply to all. e.g. pro, team">
                  <input
                    type="text" name="planSlugs" placeholder="pro_monthly, pro_yearly"
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label="Expires at" hint="Optional — leave blank for no expiry">
                  <input type="datetime-local" name="endsAt" className={inputCls} />
                </Field>
                <Field label="Max total redemptions" hint="Optional cap across all users">
                  <input
                    type="number" name="maxRedemptions" min={1} step={1}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
                <Field label="Max redemptions per user" hint="How many times one end-user can redeem this; empty = unlimited.">
                  <input
                    type="number" name="maxRedemptionsPerUser" min={1} step={1}
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </div>
              <SubmitButton pendingLabel="Adding coupon…">Add coupon</SubmitButton>
            </form>
          </Modal>
        }
      />

      {coupons.length === 0 ? (
        <EmptyState
          title="No coupons yet"
          description="Coupons grant a percentage or flat-amount discount at checkout. Codes are case-insensitive and unique per Application."
          // /applications offers a CTA from its empty state and this page did
          // not, so the one screen with nothing on it also had nothing to do.
          // The link carries the modal's own reopen flag rather than mounting a
          // second Modal with a duplicate modalKey.
          action={
            <Link
              href={`/applications/${id}/coupons?newCoupon=1`}
              className="inline-block rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
            >
              + New coupon
            </Link>
          }
        />
      ) : (
        <CouponsTable rows={[...active, ...inactive]} applicationId={id} />
      )}

      <Pager
        basePath={`/applications/${id}/coupons`}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={coupons.length}
        hasMore={page.hasMore}
      />
    </div>
  );
}

function CouponsTable({
  rows,
  applicationId,
}: {
  rows: CouponRow[];
  applicationId: string;
}): React.JSX.Element {
  return (
    <Table minWidth="min-w-[56rem]">
      <THead>
        <TR>
          <TH>Code</TH>
          <TH align="right">Discount</TH>
          <TH align="right">Used</TH>
          <TH align="right">Discount issued</TH>
          <TH>Plans</TH>
          <TH>Expires</TH>
          <TH>Status</TH>
          <TH align="right"> </TH>
        </TR>
      </THead>
      <TBody>
        {rows.map((c) => (
          <TR key={c.id} hover>
            <TD>
              <Badge tone="neutral" mono className="uppercase">{c.code}</Badge>
            </TD>
            <TD align="right" mono>{formatDiscount(c)}</TD>
            <TD align="right" mono className="text-xs">
              {c.redemptionCount}
              {c.maxRedemptions !== null && (
                <span className="text-[var(--color-muted-fg)]"> / {c.maxRedemptions}</span>
              )}
            </TD>
            <TD align="right" mono className="text-xs">
              {c.redemptionCount === 0 ? '—' : formatMoney(c.totalDiscountIssued, c.currency ?? 'USD')}
            </TD>
            <TD muted className="text-xs">
              {c.planSlugs.length === 0 ? 'all' : c.planSlugs.join(', ')}
            </TD>
            <TD muted className="text-xs">
              {c.endsAt ? formatDate(c.endsAt) : '—'}
            </TD>
            <TD>
              {c.active ? (
                <Badge tone="success" dot>active</Badge>
              ) : (
                <Badge tone="neutral" dot>inactive</Badge>
              )}
            </TD>
            <TD align="right">
              <form
                action={setCouponActive.bind(null, applicationId, c.code, !c.active)}
                className="inline"
              >
                {c.active ? (
                  <ConfirmButton
                    confirm={`Deactivate coupon "${c.code}"? It can no longer be redeemed at checkout.`}
                  >
                    Deactivate
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
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
