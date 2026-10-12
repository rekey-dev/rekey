import * as React from 'react';
import type { PlanPrice } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { minorToMajorText } from '@/lib/money-input';
import {
  amountLockReason,
  parsePriceCurrency,
  planLocalPricesChoices,
  priceCountriesLabel,
  registrationNote,
  removalLockReason,
} from '@/lib/plan-prices';
import { amountRule } from '@/lib/price-currencies';
import { savedStateKey } from '@/lib/saved-state-key';
import { ActionForm } from '@/components/ActionForm';
import { ApiErrorText } from '@/components/api-error';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { dangerButtonClass } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Field, FieldRowAction, fieldInputCls, fieldRowCls } from '@/components/Field';
import { SavedBanner } from '@/components/SavedBanner';
import { SubmitButton } from '@/components/SubmitButton';
import { PlanLocalPricesControl } from './PlanLocalPricesControl';
import { PlanPriceAddForm } from './PlanPriceAddForm';
import { removePlanPrice, savePlanPrice, savePlanPriceAmount, savePlanPriceCountries } from './price-actions';

/**
 * Copy for the refusals this section can explain better than the API can.
 * Every other code shows the API's own message and fix, which name the
 * provider or the subscribers involved.
 */
const PRICE_ERR: Record<string, string> = {
  currency: 'Enter a three-letter currency code, such as INR.',
  amount: 'Enter the amount as the currency is written, such as 1499 or 19.99, with no more decimals than the currency has.',
  countries: 'Countries must be two-letter codes separated by commas, such as IN, NP.',
  PLAN_PRICE_IS_DEFAULT:
    'That is the currency of the plan’s default price. Add a different currency here, or change the default price above.',
  PLAN_PRICE_IMMUTABLE:
    'A payment provider has registered this price, so its amount can no longer change. You can still change its countries.',
  PLAN_PRICE_REFERENCED:
    'A subscription, an open checkout or a payment names this price, so its amount stays as it is. Once nobody is on it, remove it and add the new amount. You can still change its countries.',
  PLAN_PRICE_NOT_FOUND:
    'That price is no longer on this plan, so there was nothing to change. It may have been removed in another tab.',
};

/** What the last price action left in the URL for this plan's dialog. */
export interface PlanPriceFlash {
  error?: string | undefined;
  errorDetail?: string | undefined;
  errorFix?: string | undefined;
  saved?: string | undefined;
  /** Set by a successful add only, with a new value each time. */
  added?: string | undefined;
  removed?: string | undefined;
  /** The local prices rule the plan was just switched to. */
  localPrices?: string | undefined;
}

const secondaryButton =
  'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60';

/**
 * Every price a plan sells at: the default one marked, each with where it
 * stands at the payment provider, its countries, its amount edit and its
 * removal, and the form that adds a currency. A control the API would refuse
 * is shown disabled with the reason on it.
 */
export function PlanPricesSection({
  applicationId,
  plan,
  flash,
  unchargeable,
}: {
  applicationId: string;
  plan: { id: string; slug: string; prices: PlanPrice[]; localPrices: 'INHERIT' | 'TRUSTED' | 'OFF' };
  flash: PlanPriceFlash;
  /** Why no enabled provider can charge a currency and what would fix it, or null when one can. */
  unchargeable: (currency: string) => string | null;
}): React.JSX.Element {
  const ref = { id: plan.id, slug: plan.slug };
  const saved = flash.saved ? parsePriceCurrency(flash.saved) : null;
  const removed = flash.removed ? parsePriceCurrency(flash.removed) : null;
  const ownCopy = flash.error !== undefined && Object.hasOwn(PRICE_ERR, flash.error);
  const defaultPrice = plan.prices.find((price) => price.isDefault);
  const defaultCurrency = defaultPrice?.currency ?? '';
  const switchedTo = planLocalPricesChoices(defaultCurrency).find((choice) => choice.value === flash.localPrices);

  return (
    <section className="space-y-3 border-t border-[var(--color-border)] pt-4">
      <div>
        <h3 className="text-sm font-medium text-[var(--color-fg)]">Prices</h3>
        <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
          A buyer in a country where one of these applies is charged that price. Everyone else is
          charged the default price in {defaultCurrency}. A subscriber keeps the currency they
          started in. When no enabled provider can charge a price, the buyer is charged the default
          price instead and the billing log records it.
        </p>
      </div>

      {saved && <SavedBanner message={`${saved} price saved.`} params={['priceSaved', 'priceAdded', 'editSlug']} />}
      {removed && <SavedBanner message={`${removed} price removed.`} params={['priceRemoved', 'editSlug']} />}
      {switchedTo && (
        <SavedBanner message={`Local prices on this plan: ${switchedTo.label.toLowerCase()}.`} params={['localPricesSaved', 'editSlug']} />
      )}
      {flash.error && (
        <Banner tone="error">
          <ApiErrorText
            code={flash.error}
            detail={flash.errorDetail}
            fix={flash.errorFix}
            map={ownCopy ? PRICE_ERR : {}}
            fallback="That price could not be saved."
          />
        </Banner>
      )}

      <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
        {plan.prices.map((price) => (
          <PriceRow
            key={price.id}
            applicationId={applicationId}
            planRef={ref}
            price={price}
            defaultCurrency={defaultCurrency}
            unchargeable={unchargeable(price.currency)}
          />
        ))}
      </ul>

      <PlanLocalPricesControl applicationId={applicationId} plan={plan} defaultCurrency={defaultCurrency} />

      <PlanPriceAddForm
        action={savePlanPrice.bind(null, applicationId, ref)}
        taken={plan.prices.map((price) => price.currency)}
        addedToken={flash.added}
      />
    </section>
  );
}

function PriceRow({
  applicationId,
  planRef,
  price,
  defaultCurrency,
  unchargeable,
}: {
  applicationId: string;
  planRef: { id: string; slug: string };
  price: PlanPrice;
  defaultCurrency: string;
  unchargeable: string | null;
}): React.JSX.Element {
  const note = registrationNote(price.registration.status);
  const noteId = `price-registration-${price.id}`;
  const amountLocked = amountLockReason(price);
  const removalLocked = removalLockReason(price);
  const removalReasonId = `price-removal-${price.id}`;
  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
        <span className="min-w-0 text-[var(--color-fg)]">
          <Badge tone="neutral" mono className="mr-1.5">{price.currency}</Badge>
          <span className="font-mono">{formatMoney(price.amount, price.currency)}</span>
          {price.isDefault ? (
            <Badge tone="brand" className="ml-1.5">default</Badge>
          ) : (
            <span className="ml-1.5 text-xs text-[var(--color-muted-fg)]">{priceCountriesLabel(price)}</span>
          )}
          <Badge tone={note.tone} dot className="ml-1.5">{note.label}</Badge>
        </span>
        {price.isDefault ? (
          <span className="text-xs text-[var(--color-muted-fg)]">Charged when no other price applies. It cannot be removed.</span>
        ) : removalLocked !== null ? (
          <span className="flex max-w-[20rem] flex-col items-end gap-1 text-right">
            <button
              type="button"
              disabled
              aria-describedby={removalReasonId}
              className={`${dangerButtonClass('xs')} cursor-not-allowed opacity-60`}
            >
              Remove
            </button>
            <span id={removalReasonId} className="text-xs text-[var(--color-muted-fg)]">
              {removalLocked}
            </span>
          </span>
        ) : (
          <ActionForm action={removePlanPrice.bind(null, applicationId, planRef, price.currency)}>
            <ConfirmButton
              confirm={`Remove the ${price.currency} price from ${planRef.slug}? New buyers it applied to are charged the default price in ${defaultCurrency} instead. If past subscriptions or payments used this price it is archived, so their records keep what they paid.`}
            >
              Remove
            </ConfirmButton>
          </ActionForm>
        )}
      </div>
      <p id={noteId} className="text-xs text-[var(--color-muted-fg)]">
        {note.detail}
        {price.registration.error && (
          <span className="mt-0.5 block text-red-700 dark:text-red-400">Provider said: {price.registration.error}</span>
        )}
      </p>
      {unchargeable !== null && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
          {unchargeable}{' '}
          {price.isDefault
            ? 'Until then nobody can buy this plan at its default price.'
            : `Until then a buyer this price applies to is charged the default price in ${defaultCurrency}.`}
        </p>
      )}
      {!price.isDefault && (
        <>
          {amountLocked !== null ? (
            <div className={`${fieldRowCls} sm:grid-cols-[1fr_auto]`}>
              <Field label={`Amount in ${price.currency}`} hint={amountLocked}>
                <input
                  type="text"
                  disabled
                  value={minorToMajorText(price.amount, price.currency) ?? ''}
                  readOnly
                  className={`${fieldInputCls} cursor-not-allowed font-mono opacity-60`}
                />
              </Field>
              <FieldRowAction>
                <button type="button" disabled className={`${secondaryButton} cursor-not-allowed`}>
                  Save amount
                </button>
              </FieldRowAction>
            </div>
          ) : (
            <ActionForm
              key={savedStateKey({ amount: price.amount })}
              action={savePlanPriceAmount.bind(null, applicationId, planRef, price.currency)}
              className={`${fieldRowCls} sm:grid-cols-[1fr_auto]`}
            >
              <Field label={`Amount in ${price.currency}`} hint={amountRule(price.currency)}>
                <input
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  required
                  defaultValue={minorToMajorText(price.amount, price.currency) ?? ''}
                  aria-describedby={noteId}
                  className={`${fieldInputCls} font-mono`}
                />
              </Field>
              <FieldRowAction>
                <SubmitButton pendingLabel="Saving…" className={secondaryButton}>
                  Save amount
                </SubmitButton>
              </FieldRowAction>
            </ActionForm>
          )}
          <ActionForm
            key={savedStateKey(price.countries)}
            action={savePlanPriceCountries.bind(null, applicationId, planRef, price.currency)}
            className={`${fieldRowCls} sm:grid-cols-[1fr_auto]`}
          >
            <Field label={`Countries for ${price.currency}`}>
              <input
                name="countries"
                defaultValue={price.countries.join(', ')}
                placeholder={`Empty: where ${price.currency} is the local currency`}
                autoComplete="off"
                className={`${fieldInputCls} font-mono uppercase`}
              />
            </Field>
            <FieldRowAction>
              <SubmitButton pendingLabel="Saving…" className={secondaryButton}>
                Save countries
              </SubmitButton>
            </FieldRowAction>
          </ActionForm>
        </>
      )}
    </li>
  );
}
