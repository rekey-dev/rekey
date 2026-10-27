import * as React from 'react';
import { UNAVAILABLE_CURRENCY } from '@/lib/billing-config';
import Link from '@/components/Link';
import { getApplication, readErrorFlash } from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { dangerButtonClass } from '@/components/Button';
import { SavedBanner } from '@/components/SavedBanner';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { currencyRecord } from '@rekey.dev/shared-types/currency';
import { CurrencyCatalog } from '@/components/CurrencyCatalog';
import { hasScope } from '@/lib/operator-scopes';
import { setBillingSubject, setDunningEnabled, setLocalPrices, setOnUnavailableCurrency, setReportingCurrency } from '../actions';
import { ReportingCurrencyForm } from './ReportingCurrencyForm';
import { BillingOffState } from '../notices';
import { BILLING_ERR } from '../shared';

const SUBJECT_LABEL = { user: 'Individual users', org: 'Organizations' } as const;

const LOCAL_PRICES = {
  trusted: {
    label: 'Verified country only',
    help: 'Only a country your server passes to checkout, or one a trusted proxy vouches for, can select a local price. A buyer whose country comes from their own browser is charged the plan’s default price.',
  },
  any: {
    label: 'Any country',
    help: 'A country reported by the buyer’s browser can select a local price too. A buyer can choose their price by changing their country.',
  },
} as const;

const UNAVAILABLE_RULES = ['fallback', 'refuse'] as const;

const choiceButton =
  'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60';
const chosenButton =
  'cursor-default rounded-md border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] px-3 py-1.5 text-sm text-[var(--color-primary)]';

export default async function BillingSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string' ? sp.saved : undefined;
  const app = await getApplication(id);
  const billingEnabled = app.billingConfig.enabled;
  const dunningEnabled = app.billingConfig.dunningEnabled ?? false;
  const subject = app.billingConfig.billingSubject ?? 'user';
  const { localPrices, reportingCurrency, onUnavailableCurrency } = app.billingConfig;
  const canWrite = hasScope(app.access.scopes, 'billing:write');
  const orgsEnabled = app.authConfig.organizationsEnabled === true;

  if (!billingEnabled && !orgsEnabled) {
    return <BillingOffState applicationId={id} what="billing settings" />;
  }

  return (
    <div className="space-y-5">
      {saved === 'subject' && <SavedBanner message="Billing subject updated." />}
      {saved === 'localPrices' && (
        <SavedBanner message={`Local prices now follow: ${LOCAL_PRICES[localPrices].label.toLowerCase()}.`} />
      )}
      {saved === 'unavailableCurrency' && (
        <SavedBanner
          message={`A checkout that names a currency nobody can charge ${onUnavailableCurrency === 'refuse' ? 'is now refused' : 'now pays the default price'}, unless the request says otherwise.`}
        />
      )}
      {saved === 'reportingCurrency' && (
        <SavedBanner message={`This Application now reports in ${reportingCurrency}.`} />
      )}
      {saved === 'dunning' && (
        <SavedBanner message={`Failed-payment recovery ${dunningEnabled ? 'turned on' : 'turned off'} for this application.`} />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={BILLING_ERR} />
        </Banner>
      )}

      {/* Who a subscription bills and benefits by default. It only means
          something once organizations are on. */}
      <Card className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Who pays?</h2>
          <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
            {orgsEnabled ? (
              <>
                Bill each end-user on their own, or bill the organization they belong to. With{' '}
                <strong className="font-medium text-[var(--color-fg)]">Organizations</strong>, members
                share feature access and credits, and the owner pays. A checkout call can still pass{' '}
                <code className="text-xs">organizationId</code> to override this.
              </>
            ) : (
              <>
                Each end-user pays for their own subscription. To bill a whole team instead,{' '}
                <Link href={`/applications/${id}/auth`} className="underline hover:text-[var(--color-fg)]">
                  turn on organizations
                </Link>{' '}
                first.
              </>
            )}
          </p>
        </div>
        {orgsEnabled && (
          <div role="group" aria-label="Who pays" className="flex flex-wrap items-center gap-2">
            {(['user', 'org'] as const).map((s) => (
              <ActionForm key={s} action={setBillingSubject.bind(null, id, s)}>
                {subject === s ? (
                  <button type="button" disabled aria-pressed="true" className={chosenButton}>
                    {SUBJECT_LABEL[s]} ✓
                  </button>
                ) : (
                  <SubmitButton
                    pendingLabel="Switching…"
                    aria-pressed="false"
                    className={choiceButton}
                  >
                    {SUBJECT_LABEL[s]}
                  </SubmitButton>
                )}
              </ActionForm>
            ))}
          </div>
        )}
      </Card>

      {billingEnabled && (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Reporting currency</h2>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              The currency this Application&rsquo;s figures lead with: the headline on the Billing
              overview, the currency offered first for a new price or coupon, and the currency
              shown for a plan with no flat price. There is no conversion. Your totals stay per
              currency and this one is listed first. Changing it changes no price, no subscription
              and no payment.
            </p>
          </div>
          <CurrencyCatalog providers={null} first={reportingCurrency}>
            <ReportingCurrencyForm
              key={reportingCurrency}
              action={setReportingCurrency.bind(null, id)}
              current={reportingCurrency}
              currentName={currencyRecord(reportingCurrency)?.name ?? reportingCurrency}
              writeRefusal={
                canWrite ? null : 'Your access to this Application does not include billing changes, so you can read this and not change it.'
              }
            />
          </CurrencyCatalog>
        </Card>
      )}

      {billingEnabled && (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Local prices</h2>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              A plan can have a price in more than one currency, and the buyer’s country decides
              which one they are charged. This setting decides whose word about that country
              counts. It changes nothing for a plan with one price, or for a checkout where your
              server names the currency.
            </p>
          </div>
          <dl className="max-w-prose space-y-2 text-sm">
            {(['trusted', 'any'] as const).map((choice) => (
              <div key={choice}>
                <dt className="font-medium text-[var(--color-fg)]">{LOCAL_PRICES[choice].label}</dt>
                <dd className="text-[var(--color-muted-fg)]">{LOCAL_PRICES[choice].help}</dd>
              </div>
            ))}
          </dl>
          <div role="group" aria-label="Local prices" className="flex flex-wrap items-center gap-2">
            {(['trusted', 'any'] as const).map((choice) => (
              <ActionForm key={choice} action={setLocalPrices.bind(null, id, choice)}>
                {localPrices === choice ? (
                  <button type="button" disabled aria-pressed="true" className={chosenButton}>
                    {LOCAL_PRICES[choice].label} ✓
                  </button>
                ) : choice === 'any' ? (
                  <ConfirmButton
                    title="Let any country select a local price?"
                    confirm="A buyer will be able to choose their price by changing their country, for example with a VPN. Do this only if your local prices are a convenience and not a discount."
                    confirmLabel="Allow any country"
                    triggerClassName={choiceButton}
                    triggerPressed={false}
                  >
                    {LOCAL_PRICES[choice].label}
                  </ConfirmButton>
                ) : (
                  <SubmitButton pendingLabel="Switching…" aria-pressed="false" className={choiceButton}>
                    {LOCAL_PRICES[choice].label}
                  </SubmitButton>
                )}
              </ActionForm>
            ))}
          </div>
        </Card>
      )}

      {billingEnabled && (
        <Card className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">When a currency cannot be charged</h2>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              Your server can open a checkout in a currency it names. When none of your enabled
              providers can charge that currency, this setting decides what happens. It is the
              default for this Application: a request that names its own choice wins, by sending{' '}
              <code className="text-xs">onUnavailableCurrency</code>.
            </p>
          </div>
          <dl className="max-w-prose space-y-2 text-sm">
            {UNAVAILABLE_RULES.map((choice) => (
              <div key={choice}>
                <dt className="font-medium text-[var(--color-fg)]">{UNAVAILABLE_CURRENCY[choice].label}</dt>
                <dd className="text-[var(--color-muted-fg)]">
                  {UNAVAILABLE_CURRENCY[choice].consequence}
                  {choice === 'fallback' && (
                    <>
                      {' '}
                      Each one is counted under{' '}
                      <Link href={`/applications/${id}/billing-log/fallbacks`} className="underline hover:text-[var(--color-fg)]">
                        Billing log, Default price used
                      </Link>
                      , with the provider change that would stop it.
                    </>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <div role="group" aria-label="When a named currency cannot be charged" className="flex flex-wrap items-center gap-2">
            {UNAVAILABLE_RULES.map((choice) =>
              onUnavailableCurrency === choice ? (
                <button key={choice} type="button" disabled aria-pressed="true" className={chosenButton}>
                  {UNAVAILABLE_CURRENCY[choice].label} ✓
                </button>
              ) : canWrite ? (
                <ActionForm key={choice} action={setOnUnavailableCurrency.bind(null, id, choice)}>
                  <SubmitButton pendingLabel="Switching…" aria-pressed="false" className={choiceButton}>
                    {UNAVAILABLE_CURRENCY[choice].label}
                  </SubmitButton>
                </ActionForm>
              ) : (
                <button
                  key={choice}
                  type="button"
                  disabled
                  aria-pressed="false"
                  aria-describedby="unavailable-currency-read-only"
                  className={choiceButton}
                >
                  {UNAVAILABLE_CURRENCY[choice].label}
                </button>
              ),
            )}
          </div>
          {!canWrite && (
            <p id="unavailable-currency-read-only" className="text-xs text-[var(--color-muted-fg)]">
              Your access to this Application does not include billing changes, so you can read this and not change it.
            </p>
          )}
          <dl className="max-w-prose space-y-2 text-sm">
            <div>
              <dt className="font-medium text-[var(--color-fg)]">What this setting does not change</dt>
              <dd className="text-[var(--color-muted-fg)]">
                A local price selected by the buyer&rsquo;s country always falls back to the default
                price when nobody can charge it: a buyer who named no currency is not refused over
                one. A subscriber who already pays in a currency is never moved to another one, and
                a default price nobody can charge has nothing to fall back to. Both of those are
                refused whichever choice is made here, and the second shows on the Plans page as a
                plan that cannot be bought.
              </dd>
            </div>
          </dl>
          <p className="text-xs text-[var(--color-muted-fg)]">
            To see what one buyer would get, use{' '}
            <Link href={`/applications/${id}/billing/preview`} className="underline hover:text-[var(--color-fg)]">
              Routing preview
            </Link>
            .
          </p>
        </Card>
      )}

      {billingEnabled && (
        <Card className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">Failed-payment recovery</h2>
              <Badge tone={dunningEnabled ? 'success' : 'neutral'} dot>
                {dunningEnabled ? 'on' : 'off'}
              </Badge>
            </div>
            <p className="mt-1 max-w-prose text-sm text-[var(--color-muted-fg)]">
              {dunningEnabled
                ? 'When a subscription goes past due, Rekey emails the customer on day 0, 3 and 7, then cancels the subscription on day 14 if it is still unpaid, at the provider too. A successful payment in between closes the case.'
                : 'A past-due subscription gets no reminder emails and is not cancelled by Rekey, though the provider still retries the charge. Turn this on to have Rekey chase failed payments and cancel after 14 days.'}{' '}
              <Link href={`/applications/${id}/dunning`} className="underline hover:text-[var(--color-fg)]">
                See open cases
              </Link>
              .
            </p>
          </div>
          <ActionForm action={setDunningEnabled.bind(null, id, !dunningEnabled)} className="shrink-0">
            {dunningEnabled ? (
              <ConfirmButton title="Turn off failed-payment recovery?"
                confirm="Turn off failed-payment recovery? New past-due subscriptions will get no reminder emails and won’t be auto-cancelled. Cases already in progress finish on their existing schedule."
                variant="danger"
                triggerClassName={dangerButtonClass('sm')}
              >
                Turn off
              </ConfirmButton>
            ) : (
              <SubmitButton
                pendingLabel="Turning on…"
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
              >
                Turn on
              </SubmitButton>
            )}
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
