'use client';

/**
 * Plan-create form. Lives in a client component because the field set
 * changes based on the chosen `kind`:
 *   - SUBSCRIPTION → amount + interval
 *   - LICENSE      → amount + interval + licenseKind + (expires-days | seats)
 *   - USAGE        → amount (base fee) + interval + meterSlug + pricePerUnit
 *
 * The kind selector is presented as three big radio cards at the top — easier
 * to read than a dropdown and shows the trade-offs upfront.
 */

import * as React from 'react';
import { SubmitButton } from './SubmitButton';
import { Banner } from './Banner';

interface MeterOption {
  slug: string;
  name: string;
}

const ERR: Record<string, string> = {
  missing: 'Required fields are empty.',
  PLAN_SLUG_INVALID: 'Slug must be lowercase letters, digits, hyphens, or underscores.',
  PLAN_SLUG_TAKEN: 'A plan with that slug already exists in this Application.',
  PLAN_LICENSE_KIND_REQUIRED: 'Pick a license kind (Perpetual / Timed / Seats).',
  PLAN_LICENSE_DURATION_REQUIRED: 'TIMED licenses need a duration in days.',
  PLAN_LICENSE_SEATS_REQUIRED: 'SEATS licenses need a seats-allowed count.',
  PLAN_USAGE_CONFIG_REQUIRED: 'USAGE plans need a meter + per-unit price.',
  PLAN_USAGE_METER_UNKNOWN: 'That meter is not in this Application. Add it on the Usage tab.',
  PLAN_CREDITS_AMOUNT_REQUIRED: 'Credit packs need a positive credits amount (credits granted per purchase).',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can create plans.',
};

type Kind = 'SUBSCRIPTION' | 'LICENSE' | 'USAGE' | 'CREDIT';

// ── Bundle builder: PlanEntitlements attached to the plan at creation ──
type EntKind = 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';
interface EntDraft {
  kind: EntKind;
  key?: string;
  valueType?: 'BOOL' | 'INT' | 'STRING';
  value?: string;
  quantity?: number;
  licenseKind?: 'PERPETUAL' | 'TIMED' | 'SEATS';
}

function entDraftLabel(e: EntDraft): string {
  switch (e.kind) {
    case 'FEATURE':
      return `feature ${e.key}=${e.value}`;
    case 'CREDIT':
      return `${e.quantity} credits / period`;
    case 'LICENSE':
      return e.licenseKind === 'SEATS' ? `${e.quantity ?? 0}-seat license` : `${e.licenseKind?.toLowerCase()} license`;
    case 'USAGE':
      return `${e.key} ≤ ${e.quantity} / period`;
    default:
      return e.kind;
  }
}

const KIND_CARDS: Array<{
  value: Kind;
  title: string;
  blurb: string;
  icon: React.ReactNode;
}> = [
  {
    value: 'SUBSCRIPTION',
    title: 'Subscription',
    blurb: 'Recurring charge for ongoing access. The default for most SaaS.',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    ),
  },
  {
    value: 'LICENSE',
    title: 'License',
    blurb: 'One purchase auto-issues a software license key (perpetual / timed / seats).',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
      </svg>
    ),
  },
  {
    value: 'USAGE',
    title: 'Usage',
    blurb: 'Metered — bill per unit consumed against a usage meter.',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="20" x2="12" y2="10" />
        <line x1="18" y1="20" x2="18" y2="4" />
        <line x1="6" y1="20" x2="6" y2="16" />
      </svg>
    ),
  },
  {
    value: 'CREDIT',
    title: 'Credit pack',
    blurb: 'One purchase grants a prepaid balance the app draws down per unit (e.g. lead packs).',
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </svg>
    ),
  },
];

export function PlanCreateForm({
  action,
  meters,
  error,
}: {
  action: (formData: FormData) => Promise<void>;
  meters: MeterOption[];
  error?: string;
}): React.JSX.Element {
  const [kind, setKind] = React.useState<Kind>('SUBSCRIPTION');
  const [licenseKind, setLicenseKind] = React.useState<'PERPETUAL' | 'TIMED' | 'SEATS'>('PERPETUAL');

  // Live cents → dollars preview for the Amount field (same pattern as
  // CouponAmountPreview) — removes the cents-vs-dollars ambiguity as you type.
  const [amount, setAmount] = React.useState('');
  const amountNum = Number(amount);
  const amountPreview =
    Number.isFinite(amountNum) && amountNum > 0 ? `= $${(amountNum / 100).toFixed(2)}` : null;

  // Bundle builder state. The list is serialized into a hidden `entitlements`
  // input and applied (one PUT each) by the server action after the plan is
  // created — so a Subscription can ship with credits / usage caps / licenses /
  // feature flags in a single submit.
  const [ents, setEnts] = React.useState<EntDraft[]>([]);
  const [eKind, setEKind] = React.useState<EntKind>('CREDIT');
  const [eKey, setEKey] = React.useState('');
  const [eValueType, setEValueType] = React.useState<'BOOL' | 'INT' | 'STRING'>('BOOL');
  const [eValue, setEValue] = React.useState('');
  const [eQty, setEQty] = React.useState('');
  const [eLicenseKind, setELicenseKind] = React.useState<'PERPETUAL' | 'TIMED' | 'SEATS'>('SEATS');

  const addEnt = (): void => {
    let d: EntDraft | null = null;
    if (eKind === 'FEATURE') {
      if (!eKey.trim() || !eValue.trim()) return;
      d = { kind: 'FEATURE', key: eKey.trim(), valueType: eValueType, value: eValue.trim() };
    } else if (eKind === 'CREDIT') {
      const q = Number(eQty);
      if (!Number.isFinite(q) || q <= 0) return;
      d = { kind: 'CREDIT', quantity: q };
    } else if (eKind === 'LICENSE') {
      const q = Number(eQty);
      // A SEATS license needs a positive seat count — the API rejects it
      // otherwise (PLAN_ENTITLEMENT_INVALID), so guard here before adding.
      if (eLicenseKind === 'SEATS' && (!Number.isFinite(q) || q <= 0)) return;
      d = { kind: 'LICENSE', licenseKind: eLicenseKind, ...(eLicenseKind === 'SEATS' ? { quantity: q } : {}) };
    } else {
      const q = Number(eQty);
      if (!eKey.trim() || !Number.isFinite(q) || q <= 0) return;
      d = { kind: 'USAGE', key: eKey.trim(), quantity: q };
    }
    setEnts((prev) => [...prev, d as EntDraft]);
    setEKey('');
    setEValue('');
    setEQty('');
  };

  return (
    <form action={action} className="space-y-4">
      {error && (
        <Banner tone="error">
          {ERR[error] ?? error}
        </Banner>
      )}

      {/* Kind cards */}
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-[var(--color-fg)] mb-1">What is this plan?</legend>
        <div className="grid sm:grid-cols-3 gap-2">
          {KIND_CARDS.map((c) => (
            <label
              key={c.value}
              className={
                'cursor-pointer rounded-lg border p-3 transition-colors ' +
                (kind === c.value
                  ? 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary-soft)_40%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)]'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]')
              }
            >
              <input
                type="radio"
                name="kind"
                value={c.value}
                checked={kind === c.value}
                onChange={() => setKind(c.value)}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <span className={kind === c.value ? 'text-[var(--color-primary)]' : 'text-[var(--color-faint-fg)]'}>
                  {c.icon}
                </span>
                <span className="text-sm font-medium">{c.title}</span>
              </div>
              <p className="text-[11px] text-[var(--color-muted-fg)] mt-1.5 leading-snug">{c.blurb}</p>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Core fields */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Slug" required hint="URL-safe identifier — used by your app and SDK">
          <input
            type="text"
            name="slug"
            required
            placeholder="pro_monthly"
            autoFocus
            pattern="^[a-z0-9](?:[a-z0-9_\-]{0,38}[a-z0-9])?$"
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label="Name" required hint="Shown to end-users at checkout.">
          <input type="text" name="name" required placeholder="Pro" className={inputCls} />
        </Field>
        <Field
          label={kind === 'USAGE' ? 'Base fee (cents)' : kind === 'CREDIT' ? 'Pack price (cents)' : 'Amount (cents)'}
          required
          hint={
            <>
              {kind === 'USAGE' ? '0 = pure pay-as-you-go.' : kind === 'CREDIT' ? 'One-time charge for the pack. 4999 = $49.99' : '999 = $9.99'}
              <span aria-live="polite" className="ml-1 font-medium text-[var(--color-fg)]">
                {amountPreview}
              </span>
            </>
          }
        >
          <input
            type="number"
            name="amount"
            required
            min={0}
            step={1}
            placeholder={kind === 'USAGE' ? '0' : '999'}
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label="Currency" hint="ISO 4217">
          <input type="text" name="currency" defaultValue="USD" maxLength={3} minLength={3} className={`${inputCls} font-mono`} />
        </Field>
        {kind !== 'CREDIT' && (
          <Field label="Billing interval" hint={kind === 'LICENSE' ? 'Ignored for perpetual licenses.' : undefined}>
            <select name="interval" defaultValue="MONTH" className={inputCls}>
              <option value="MONTH">Monthly</option>
              <option value="YEAR">Yearly</option>
            </select>
          </Field>
        )}
      </div>

      {/* LICENSE-kind block */}
      {kind === 'LICENSE' && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 space-y-3">
          <div>
            <p className="text-xs font-medium">License configuration</p>
            <p className="text-[11px] text-[var(--color-muted-fg)] mt-0.5">
              On payment, a license key is auto-issued to the buyer. They (or their software)
              verify with <code className="font-mono text-[10px]">POST /api/v1/licenses/verify</code>.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="License kind">
              <select
                name="licenseKind"
                value={licenseKind}
                onChange={(e) => setLicenseKind(e.currentTarget.value as typeof licenseKind)}
                className={inputCls}
              >
                <option value="PERPETUAL">Perpetual</option>
                <option value="TIMED">Timed</option>
                <option value="SEATS">Seats</option>
              </select>
            </Field>
            {licenseKind === 'TIMED' && (
              <Field label="Duration (days)" hint="365 = one year">
                <input type="number" name="licenseDurationDays" min={1} placeholder="365" className={`${inputCls} font-mono`} />
              </Field>
            )}
            {licenseKind === 'SEATS' && (
              <Field label="Seats allowed" hint="Concurrent activations">
                <input type="number" name="licenseSeatsAllowed" min={1} placeholder="5" className={`${inputCls} font-mono`} />
              </Field>
            )}
          </div>
        </div>
      )}

      {/* USAGE-kind block */}
      {kind === 'USAGE' && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 space-y-3">
          <div>
            <p className="text-xs font-medium">Usage configuration</p>
            <p className="text-[11px] text-[var(--color-muted-fg)] mt-0.5">
              <span className="text-amber-700 dark:text-amber-400">Note:</span> records persist
              locally + appear on invoices, but provider-side metered subscription wiring (Stripe)
              is scaffolded — invoice push lands in a follow-up.
            </p>
          </div>
          {meters.length === 0 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              No usage meters defined yet. Create one on the <strong>Usage</strong> tab first, then
              return here.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Meter" required hint="Plan bills against records on this meter.">
                <select name="meterSlug" required defaultValue="" className={`${inputCls} font-mono`}>
                  <option value="" disabled>Pick a meter…</option>
                  {meters.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.slug} — {m.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Price per unit (cents)" required hint="5 = $0.05/unit">
                <input type="number" name="pricePerUnitCents" min={0} step={1} placeholder="5" className={`${inputCls} font-mono`} />
              </Field>
            </div>
          )}
        </div>
      )}

      {/* CREDIT-kind block */}
      {kind === 'CREDIT' && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 space-y-3">
          <div>
            <p className="text-xs font-medium">Credit pack configuration</p>
            <p className="text-[11px] text-[var(--color-muted-fg)] mt-0.5">
              On payment, the buyer&apos;s balance is topped up by the credits below. The app draws it
              down via <code className="font-mono text-[10px]">POST /api/v1/credits/consume</code> (one
              lead = one credit, say). <strong>Amount</strong> above is the price of the pack.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Credits granted" required hint="100 = buyer gets 100 credits per purchase">
              <input type="number" name="creditsAmount" min={1} step={1} placeholder="100" className={`${inputCls} font-mono`} />
            </Field>
          </div>
        </div>
      )}

      {/* Add-ons — bundle entitlements onto the plan at creation */}
      <fieldset className="rounded-lg border border-[var(--color-border)] p-3 space-y-3">
        <legend className="px-1 text-xs font-medium">Add-ons (optional)</legend>
        <p className="text-[11px] text-[var(--color-muted-fg)] -mt-1">
          Benefits granted on purchase — credits, usage caps, licenses, feature flags. A Subscription
          can bundle any of these; they materialize onto the buyer (or their org) when it activates.
        </p>

        {ents.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {ents.map((e, i) => (
              <li
                key={i}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-surface-muted)] px-2 py-1 text-[11px]"
              >
                <span>{entDraftLabel(e)}</span>
                <button
                  type="button"
                  onClick={() => setEnts((p) => p.filter((_, j) => j !== i))}
                  className="text-[var(--color-faint-fg)] hover:text-red-500"
                  aria-label={`Remove ${entDraftLabel(e)}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <select
            value={eKind}
            onChange={(e) => setEKind(e.currentTarget.value as EntKind)}
            className={inputCls}
            aria-label="Add-on kind"
          >
            <option value="CREDIT">Credits (granted per period)</option>
            <option value="USAGE">Usage cap (included units / period)</option>
            <option value="LICENSE">License (seats / perpetual / timed)</option>
            <option value="FEATURE">Feature flag / limit</option>
          </select>

          {eKind === 'CREDIT' && (
            <input
              type="number"
              min={1}
              value={eQty}
              onChange={(e) => setEQty(e.currentTarget.value)}
              placeholder="Credits per period — e.g. 500"
              className={`${inputCls} font-mono`}
            />
          )}
          {eKind === 'USAGE' && (
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={eKey}
                onChange={(e) => setEKey(e.currentTarget.value)}
                placeholder="meter slug — api_calls"
                className={`${inputCls} font-mono`}
              />
              <input
                type="number"
                min={1}
                value={eQty}
                onChange={(e) => setEQty(e.currentTarget.value)}
                placeholder="included / period — 10000"
                className={`${inputCls} font-mono`}
              />
            </div>
          )}
          {eKind === 'LICENSE' && (
            <div className="grid grid-cols-2 gap-2">
              <select
                value={eLicenseKind}
                onChange={(e) => setELicenseKind(e.currentTarget.value as 'PERPETUAL' | 'TIMED' | 'SEATS')}
                className={inputCls}
              >
                <option value="SEATS">Seats</option>
                <option value="PERPETUAL">Perpetual</option>
                <option value="TIMED">Timed</option>
              </select>
              {eLicenseKind === 'SEATS' && (
                <input
                  type="number"
                  min={1}
                  value={eQty}
                  onChange={(e) => setEQty(e.currentTarget.value)}
                  placeholder="seats — 5"
                  className={`${inputCls} font-mono`}
                />
              )}
            </div>
          )}
          {eKind === 'FEATURE' && (
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text"
                value={eKey}
                onChange={(e) => setEKey(e.currentTarget.value)}
                placeholder="key — advanced_reporting"
                className={`${inputCls} font-mono`}
              />
              <select
                value={eValueType}
                onChange={(e) => setEValueType(e.currentTarget.value as 'BOOL' | 'INT' | 'STRING')}
                className={inputCls}
              >
                <option value="BOOL">Boolean</option>
                <option value="INT">Number</option>
                <option value="STRING">String</option>
              </select>
              <input
                type="text"
                value={eValue}
                onChange={(e) => setEValue(e.currentTarget.value)}
                placeholder="true / 50 / pro"
                className={`${inputCls} font-mono`}
              />
            </div>
          )}

          <button
            type="button"
            onClick={addEnt}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
          >
            + Add add-on
          </button>
        </div>

        {/* Serialized for the server action — applied (one PUT each) after create. */}
        <input type="hidden" name="entitlements" value={JSON.stringify(ents)} />
      </fieldset>

      <SubmitButton
        pendingLabel="Creating plan…"
        className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        Create plan
      </SubmitButton>
    </form>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">
        {label}
        {required && <span className="text-[var(--color-primary)] ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
