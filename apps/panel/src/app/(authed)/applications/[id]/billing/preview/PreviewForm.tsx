'use client';

import * as React from 'react';
import { CurrencyInput } from '@/components/CurrencyCatalog';
import { fieldInputCls } from '@/components/Field';
import { UNAVAILABLE_CURRENCY, type UnavailableCurrencyRule } from '@/lib/billing-config';
import { COUNTRY_SOURCES, countryName, SERVER_ONLY_REASON, type CountrySource, type PreviewFields } from '@/lib/routing-preview';

const labelCls = 'block text-xs font-medium text-[var(--color-fg)]';
const hintCls = 'block text-xs text-[var(--color-muted-fg)]';

/**
 * The routing preview's inputs. A GET form, so the preview is in the URL. A
 * client component for the two things it says while the operator chooses:
 * the country's name, and why a currency cannot be named from a browser.
 */
export function PreviewForm({
  initial,
  plans,
  providers,
  applicationDefault,
}: {
  initial: PreviewFields;
  /** The Application's `billingConfig.onUnavailableCurrency`, which a checkout that sends no rule gets. */
  applicationDefault: UnavailableCurrencyRule;
  plans: ReadonlyArray<{ slug: string; name: string }>;
  providers: ReadonlyArray<{ name: string; label: string }>;
}): React.JSX.Element {
  const [country, setCountry] = React.useState(initial.country);
  const [source, setSource] = React.useState<CountrySource>(initial.countrySource);
  const [currency, setCurrency] = React.useState(initial.currency);
  const ids = React.useId();
  const serverOnlyId = `${ids}-server-only`;
  const server = source === 'declared';
  const named = countryName(country);

  return (
    <form className="space-y-4" aria-label="Preview a checkout">
      <div className="grid items-start gap-3 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className={labelCls}>
            Buyer&rsquo;s country<span className="ml-0.5 text-[var(--color-primary)]">*</span>
          </span>
          <input
            name="country"
            required
            minLength={2}
            maxLength={2}
            pattern="[A-Za-z]{2}"
            placeholder="IN"
            autoComplete="off"
            value={country}
            onChange={(e) => setCountry(e.currentTarget.value.toUpperCase())}
            className={`${fieldInputCls} font-mono uppercase`}
          />
          <span className={hintCls} aria-live="polite">
            {named ?? 'A two-letter country code, such as IN, DE or US.'}
          </span>
        </label>
        <label className="block space-y-1">
          <span className={labelCls}>Plan</span>
          <select name="plan" defaultValue={initial.plan} className={fieldInputCls}>
            <option value="">Every active plan</option>
            {plans.map((plan) => (
              <option key={plan.slug} value={plan.slug}>
                {plan.name} ({plan.slug})
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className={labelCls}>Coupon code</span>
          <input
            name="couponCode"
            defaultValue={initial.couponCode}
            maxLength={64}
            placeholder="None"
            autoComplete="off"
            className={`${fieldInputCls} font-mono uppercase`}
          />
          <span className={hintCls}>Optional. Shows what it takes off, or why it is refused.</span>
        </label>
      </div>

      <label className="block max-w-xl space-y-1">
        <span className={labelCls}>Who opens the checkout</span>
        <select
          name="countrySource"
          value={source}
          onChange={(e) => setSource(COUNTRY_SOURCES.find((entry) => entry.value === e.currentTarget.value)?.value ?? 'vouched')}
          className={fieldInputCls}
        >
          {COUNTRY_SOURCES.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
        <span className={hintCls} aria-live="polite">
          {COUNTRY_SOURCES.find((entry) => entry.value === source)?.help}
        </span>
      </label>

      <details className="rounded-md border border-[var(--color-border)] px-3 py-2" open={Boolean(initial.endUserId || initial.provider || initial.currency)}>
        <summary className="cursor-pointer text-sm text-[var(--color-fg)]">More: an existing customer, a named provider, a named currency</summary>
        <div className="mt-3 grid items-start gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className={labelCls}>End-user id</span>
            <input name="endUserId" defaultValue={initial.endUserId} maxLength={64} autoComplete="off" className={`${fieldInputCls} font-mono`} />
            <span className={hintCls}>
              Previews for this customer, given what they already pay for. A subscriber is kept on their currency and their provider.
            </span>
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>Provider the checkout names</span>
            <select name="provider" defaultValue={initial.provider} className={fieldInputCls}>
              <option value="">None: let Rekey route</option>
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.label}
                </option>
              ))}
            </select>
            <span className={hintCls}>From a browser, a named provider that cannot charge the selected price is ignored.</span>
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>Currency the server names</span>
            {server ? (
              <CurrencyInput name="currency" value={currency} onChange={setCurrency} placeholder="None" className={fieldInputCls} />
            ) : (
              <input disabled value="" placeholder="None" aria-describedby={serverOnlyId} className={`${fieldInputCls} opacity-60`} readOnly />
            )}
          </label>
          <label className="block space-y-1">
            <span className={labelCls}>If that currency cannot be charged</span>
            <select
              name="onUnavailableCurrency"
              defaultValue={initial.onUnavailableCurrency}
              disabled={!server}
              aria-describedby={server ? undefined : serverOnlyId}
              className={`${fieldInputCls} disabled:opacity-60`}
            >
              <option value="">
                The request does not say: {UNAVAILABLE_CURRENCY[applicationDefault].label.toLowerCase()}, this Application&rsquo;s default
              </option>
              <option value="fallback">The request says: {UNAVAILABLE_CURRENCY.fallback.label.toLowerCase()}</option>
              <option value="refuse">The request says: {UNAVAILABLE_CURRENCY.refuse.label.toLowerCase()}</option>
            </select>
            <span className={hintCls}>A request that names its own choice wins over the Application default.</span>
          </label>
          {!server && (
            <p id={serverOnlyId} className={`${hintCls} sm:col-span-2`}>
              {SERVER_ONLY_REASON}
            </p>
          )}
        </div>
      </details>

      <button
        type="submit"
        className="rounded-md bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
      >
        Preview
      </button>
    </form>
  );
}
