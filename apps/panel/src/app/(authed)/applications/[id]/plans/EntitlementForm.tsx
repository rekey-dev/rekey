'use client';

import * as React from 'react';
import { SubmitButton } from '@/components/SubmitButton';

type Kind = 'FEATURE' | 'CREDIT' | 'LICENSE' | 'USAGE';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

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
        <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
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
            <input type="number" name="quantity" required min={1} placeholder="10000" className={`${inputCls} font-mono`} />
          </label>
        </div>
      )}

      <SubmitButton pendingLabel="Saving entitlement…">Save entitlement</SubmitButton>
      <p className="text-xs text-[var(--color-muted-fg)]">
        Upserts by (kind, key). USAGE add-ons enforce a hard cap — usage past the included units
        per calendar month is rejected (402 USAGE_QUOTA_EXCEEDED).
      </p>
    </form>
  );
}
