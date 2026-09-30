import * as React from 'react';
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
import { setBillingSubject, setDunningEnabled } from '../actions';
import { BillingOffState } from '../notices';
import { BILLING_ERR } from '../shared';

const SUBJECT_LABEL = { user: 'Individual users', org: 'Organizations' } as const;

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
  const orgsEnabled = app.authConfig.organizationsEnabled === true;

  if (!billingEnabled && !orgsEnabled) {
    return <BillingOffState applicationId={id} what="billing settings" />;
  }

  return (
    <div className="space-y-5">
      {saved === 'subject' && <SavedBanner message="Billing subject updated." />}
      {saved === 'dunning' && (
        <SavedBanner message={`Failed-payment recovery ${dunningEnabled ? 'turned on' : 'turned off'} for this application.`} />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={BILLING_ERR} fallback={error} />
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
                  <button
                    type="button"
                    disabled
                    aria-pressed="true"
                    className="cursor-default rounded-md border border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] px-3 py-1.5 text-sm text-[var(--color-primary)]"
                  >
                    {SUBJECT_LABEL[s]} ✓
                  </button>
                ) : (
                  <SubmitButton
                    pendingLabel="Switching…"
                    aria-pressed="false"
                    className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
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
              <ConfirmButton
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
