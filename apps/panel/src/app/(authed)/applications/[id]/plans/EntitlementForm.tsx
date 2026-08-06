'use client';

import * as React from 'react';
import { SubmitButton } from '@/components/SubmitButton';
import { Banner } from '@/components/Banner';

type Kind = 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const ERR: Record<string, string> = {
  PLAN_ENTITLEMENT_INVALID: 'The entitlement is missing required fields for its kind.',
  PLAN_ENTITLEMENT_NOT_FOUND: 'Entitlement not found.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage plan entitlements.',
};

/**
 * Add/update one plan entitlement. Client component so the field set follows
 * the chosen kind. The write is a server action passed in as `action`.
 */
export function EntitlementForm({
  action,
  error,
}: {
  action: (formData: FormData) => void | Promise<void>;
  error?: string;
}): React.JSX.Element {
  const [kind, setKind] = React.useState<Kind>('FEATURE');

  return (
    <form action={action} className="space-y-3">
      <p className="text-xs text-[var(--color-muted-fg)]">
        Bundle items onto this plan — feature flags, extra licenses, usage allowances, or bonus
        credits. Optional.
      </p>
      {error && (
        <Banner tone="error">
          {ERR[error] ?? 'Something went wrong. Please try again.'}
        </Banner>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium">Kind</span>
        <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={inputCls}>
          <option value="FEATURE">Feature flag / limit</option>
          <option value="CREDIT">Credits (granted per period)</option>
          <option value="LICENSE">License (seats)</option>
          <option value="USAGE">Usage allowance (included units)</option>
        </select>
      </label>

      {kind === 'FEATURE' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block space-y-1 sm:col-span-1">
            <span className="text-xs font-medium">Key</span>
            <input type="text" name="key" required placeholder="advanced_reporting" className={`${inputCls} font-mono`} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Type</span>
            <select name="valueType" defaultValue="BOOL" className={inputCls}>
              <option value="BOOL">Boolean</option>
              <option value="INT">Number</option>
              <option value="STRING">String</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Value</span>
            <input type="text" name="value" required placeholder="true / 50 / pro" className={`${inputCls} font-mono`} />
          </label>
        </div>
      )}

      {kind === 'CREDIT' && (
        <label className="block space-y-1">
          <span className="text-xs font-medium">Credits per period</span>
          <input type="number" name="quantity" required min={1} placeholder="500" className={`${inputCls} font-mono`} />
        </label>
      )}

      {kind === 'LICENSE' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium">License kind</span>
            <select name="licenseKind" defaultValue="SEATS" className={inputCls}>
              <option value="PERPETUAL">Perpetual</option>
              <option value="TIMED">Timed</option>
              <option value="SEATS">Seats</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Seats (SEATS only)</span>
            <input type="number" name="quantity" min={1} placeholder="5" className={`${inputCls} font-mono`} />
          </label>
        </div>
      )}

      {kind === 'USAGE' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium">Meter slug</span>
            <input type="text" name="key" required placeholder="api_calls" className={`${inputCls} font-mono`} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Included units / period</span>
            <input type="number" name="quantity" required min={0} placeholder="10000" className={`${inputCls} font-mono`} />
            <span className="block text-xs text-[var(--color-muted-fg)]">
              0 with a price below = charge from the first unit. A price of 0
              meters without charging.
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Credits per unit past the allowance</span>
            <input
              type="number"
              name="creditsPerUnit"
              min={0}
              placeholder="Leave empty for a hard cap"
              className={`${inputCls} font-mono`}
            />
            <span className="block text-xs text-[var(--color-muted-fg)]">
              Empty = usage past the allowance is refused. Set it and the excess
              is drawn from the subscriber&apos;s credit balance instead.
            </span>
          </label>
        </div>
      )}

      <SubmitButton pendingLabel="Saving entitlement…">Save entitlement</SubmitButton>
      <p className="text-xs text-[var(--color-muted-fg)]">
        Upserts by (kind, key). A USAGE allowance with no price is a hard cap:
        usage past the included units per calendar month is refused (402
        USAGE_QUOTA_EXCEEDED). Priced, the excess is charged to the
        subscriber&apos;s credit balance, and a balance too low is refused the
        same way — never billed into the negative.
      </p>
    </form>
  );
}
