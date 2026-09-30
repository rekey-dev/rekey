import * as React from 'react';
import { Modal } from '@/components/Modal';
import { CopyLinkButton } from '@/components/CopyLinkButton';
import {
  CREATED_VIA_OPTIONS,
  ONBOARDING_STATES,
  PLATFORMS,
  RANGE_LABEL,
  RANGE_PRESETS,
  SIGN_IN_METHODS,
  activeFilterCount,
  defaultCustomDates,
  filterChips,
  createdViaName,
  platformName,
  usersHref,
  viaName,
  withoutFilters,
  type UsersFilters,
  type UsersView,
} from '@/lib/users-filters';
import { AutoSubmitSelect } from './auto-submit';

const control =
  'h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
const button =
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]';

/**
 * The Users overview filter bar. Everything is a GET form (no `action`, so it
 * submits to this page) or a link, so the
 * URL is the state and the page works without JavaScript; the selects only
 * submit themselves on change as a convenience.
 */
export function FilterBar({
  appId,
  filters,
  view,
  canFilterPlan,
  canFilterOrg,
}: {
  appId: string;
  filters: UsersFilters;
  view: UsersView;
  canFilterPlan: boolean;
  canFilterOrg: boolean;
}): React.JSX.Element {
  const chips = filterChips(filters);
  const defaults = defaultCustomDates();
  const count = activeFilterCount(filters);
  const hidden = (omit: readonly string[]): React.ReactNode =>
    hiddenInputs(filters, view, omit).map(([k, v]) => <input key={`${k}=${v}`} type="hidden" name={k} value={v} />);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <form method="get" className="flex flex-wrap items-center gap-2">
          {hidden(['range', 'from', 'to', 'compare'])}
          <label className="sr-only" htmlFor="uo-range">
            Date range
          </label>
          <AutoSubmitSelect id="uo-range" name="range" defaultValue={filters.range} className={control}>
            {RANGE_PRESETS.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABEL[r]}
              </option>
            ))}
          </AutoSubmitSelect>
          {filters.range === 'custom' && (
            <span className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="uo-from">
                From
              </label>
              <input id="uo-from" type="date" name="from" defaultValue={filters.from ?? defaults.from} className={control} required />
              <span className="text-xs text-[var(--color-muted-fg)]">to</span>
              <label className="sr-only" htmlFor="uo-to">
                To
              </label>
              <input id="uo-to" type="date" name="to" defaultValue={filters.to ?? defaults.to} className={control} required />
            </span>
          )}
          <label className="sr-only" htmlFor="uo-compare">
            Compare with
          </label>
          <AutoSubmitSelect
            id="uo-compare"
            name="compare"
            defaultValue={filters.compare}
            className={`${control} hidden sm:block`}
          >
            <option value="prev">Compare: previous period</option>
            <option value="none">No comparison</option>
          </AutoSubmitSelect>
          {filters.range === 'custom' ? (
            <button type="submit" className={button}>
              Apply
            </button>
          ) : (
            <noscript>
              <button type="submit" className={button}>
                Apply
              </button>
            </noscript>
          )}
        </form>

        <Modal
          title="Filter users"
          description="Platform, country and sign-in method describe each user's most recent values. Onboarding, email, MFA and billing filters, or two of the others together, read live data and cover at most 63 days."
          trigger={
            <span className="inline-flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 5h18M6 12h12M10 19h4" />
              </svg>
              {count > 0 ? `Filters (${count})` : 'Add filter'}
            </span>
          }
          triggerClassName={button}
        >
          <form method="get" className="space-y-4">
            {hidden(['platform', 'country', 'via', 'createdVia', 'onboarding', 'verified', 'mfa', 'plan', 'paying', 'org', 'compare'])}
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted-fg)]">Platform</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {PLATFORMS.map((p) => (
                  <label key={p} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="platform" value={p} defaultChecked={filters.platform.includes(p)} />
                    {platformName(p)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted-fg)]">Last sign-in method</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {SIGN_IN_METHODS.map((v) => (
                  <label key={v} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="via" value={v} defaultChecked={filters.via.includes(v)} />
                    {viaName(v)}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-[var(--color-muted-fg)]">Sign-up source</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {CREATED_VIA_OPTIONS.map((v) => (
                  <label key={v} className="flex items-center gap-1.5 text-sm">
                    <input type="checkbox" name="createdVia" value={v} defaultChecked={filters.createdVia.includes(v)} />
                    {createdViaName(v)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-[var(--color-muted-fg)]">
                Country
                <input
                  type="text"
                  name="country"
                  defaultValue={filters.country.join(',')}
                  placeholder="DE,US"
                  pattern="[A-Za-z]{2}(,[A-Za-z]{2})*"
                  className={`${control} mt-1 w-full uppercase`}
                  aria-describedby="uo-country-hint"
                />
                <span id="uo-country-hint" className="mt-1 block font-normal text-[var(--color-faint-fg)]">
                  Two-letter codes, comma separated.
                </span>
              </label>
              <SelectField label="Onboarding" name="onboarding" value={filters.onboarding}>
                {ONBOARDING_STATES.map((o) => (
                  <option key={o} value={o}>
                    {o.charAt(0).toUpperCase() + o.slice(1)}
                  </option>
                ))}
              </SelectField>
              <SelectField label="Email" name="verified" value={boolValue(filters.verified)}>
                <option value="true">Verified</option>
                <option value="false">Not verified</option>
              </SelectField>
              <SelectField label="MFA" name="mfa" value={boolValue(filters.mfa)}>
                <option value="true">On</option>
                <option value="false">Off</option>
              </SelectField>
              {canFilterPlan && (
                <SelectField label="Billing" name="paying" value={filters.paying ? 'true' : undefined}>
                  <option value="true">Paying users only</option>
                </SelectField>
              )}
              <SelectField label="Compare with" name="compare" value={filters.compare} anyLabel={null}>
                <option value="prev">Previous period</option>
                <option value="none">No comparison</option>
              </SelectField>
            </div>
            {(filters.plan || filters.org) && (
              <p className="text-xs text-[var(--color-muted-fg)]">
                {filters.plan && canFilterPlan && <input type="hidden" name="plan" value={filters.plan} />}
                {filters.org && canFilterOrg && <input type="hidden" name="org" value={filters.org} />}
                Plan and organization filters are kept. Remove them from the chips on the page.
              </p>
            )}
            <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border)] pt-3">
              <a href={usersHref(appId, withoutFilters(filters), view)} className="text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline">
                Clear filters
              </a>
              <button
                type="submit"
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
              >
                Apply
              </button>
            </div>
          </form>
        </Modal>

        <span className="ml-auto">
          <CopyLinkButton />
        </span>
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((c) => (
            <a
              key={c.key}
              href={usersHref(appId, c.without, view)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] px-2 py-0.5 text-xs text-[var(--color-fg)] hover:bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)]"
            >
              {c.label}
              <span aria-hidden="true" className="text-[var(--color-muted-fg)]">
                ×
              </span>
              <span className="sr-only">(remove)</span>
            </a>
          ))}
          <a
            href={usersHref(appId, withoutFilters(filters), view)}
            className="ml-1 text-xs text-[var(--color-muted-fg)] underline-offset-2 hover:text-[var(--color-fg)] hover:underline"
          >
            Clear all
          </a>
        </div>
      )}
    </div>
  );
}

function SelectField({
  label,
  name,
  value,
  children,
  anyLabel = 'Any',
}: {
  label: string;
  name: string;
  value: string | undefined;
  children: React.ReactNode;
  anyLabel?: string | null;
}): React.JSX.Element {
  return (
    <label className="block text-xs font-medium text-[var(--color-muted-fg)]">
      {label}
      <select name={name} defaultValue={value ?? ''} className={`${control} mt-1 w-full`}>
        {anyLabel !== null && <option value="">{anyLabel}</option>}
        {children}
      </select>
    </label>
  );
}

function boolValue(b: boolean | undefined): string | undefined {
  return b === undefined ? undefined : String(b);
}


/** Every param of the current state except `omit`, so a form keeps what it does not edit. */
function hiddenInputs(f: UsersFilters, view: UsersView, omit: readonly string[]): Array<[string, string]> {
  const url = new URL(usersHref('x', f, view), 'http://panel.invalid');
  return [...url.searchParams.entries()].filter(([k]) => !omit.includes(k));
}
