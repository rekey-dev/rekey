import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { errorQuery, readErrorFlash, api, PanelApiError } from '@/lib/api';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { EmailCredentialsForm } from './EmailCredentialsForm';
import { Banner } from '@/components/Banner';

type Transport = 'byo_resend' | 'byo_smtp' | 'default_resend' | 'none';

interface EmailConfigRow {
  emailConfig: { fromAddress?: string; fromName?: string; replyTo?: string };
  hasCustomCredentials: boolean;
  transport: Transport;
  provider: 'resend' | 'smtp' | 'default' | 'none';
  effectiveFromAddress: string | null;
}

interface SendControl {
  emailsEnabled: boolean;
  events: Array<{ key: string; label: string; enabled: boolean; customised: boolean }>;
}

interface SendStats {
  sent: number;
  error: number;
  noTransport: number;
  suppressed: number;
}

/** The master switch. Templates and per-event switches live on their own tab. */
async function setEmailsEnabled(applicationId: string, enabled: boolean): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/email`;
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-send-control`,
      body: { emailsEnabled: enabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${base}?saved=1`);
}

async function saveCreds(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const provider = String(formData.get('provider') ?? 'resend');
  const fromAddress = String(formData.get('fromAddress') ?? '').trim();
  const fromName = String(formData.get('fromName') ?? '').trim();
  const replyTo = String(formData.get('replyTo') ?? '').trim();
  if (!fromAddress) redirect(`/applications/${applicationId}/email?error=missing`);

  let body: Record<string, unknown>;
  if (provider === 'smtp') {
    const host = String(formData.get('host') ?? '').trim();
    const user = String(formData.get('user') ?? '').trim();
    const pass = String(formData.get('pass') ?? '');
    const port = Number(String(formData.get('port') ?? '').trim());
    const secure = formData.get('secure') === 'on';
    if (!host || !user || !pass || !Number.isInteger(port) || port < 1 || port > 65535) {
      redirect(`/applications/${applicationId}/email?error=smtp_missing`);
    }
    body = {
      provider: 'smtp',
      host,
      port,
      secure,
      user,
      pass,
      fromAddress,
      ...(fromName ? { fromName } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
  } else {
    const apiKey = String(formData.get('apiKey') ?? '').trim();
    if (!apiKey) redirect(`/applications/${applicationId}/email?error=missing`);
    body = {
      provider: 'resend',
      apiKey,
      fromAddress,
      ...(fromName ? { fromName } : {}),
      ...(replyTo ? { replyTo } : {}),
    };
  }

  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-credentials`,
      body,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/email?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/email?saved=1`);
}

async function removeCreds(applicationId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-credentials`,
  });
  redirect(`/applications/${applicationId}/email?removed=1`);
}

const TRANSPORT_BLURB: Record<Transport, string> = {
  byo_resend: 'Using your own Resend account. Templates are sent from the address below.',
  byo_smtp: 'Using your own SMTP server. Templates are sent from the address below.',
  default_resend:
    'Falling back to the Rekey-managed Resend pool. To use your own brand and unlock higher quotas, configure BYO credentials.',
  none:
    'No transport configured. /forgot-password and /send-verification fall back to returning the raw token to the caller for manual delivery.',
};

const TRANSPORT_LABEL: Record<Transport, string> = {
  byo_resend: 'BYO Resend',
  byo_smtp: 'BYO SMTP',
  default_resend: 'Default Resend',
  none: 'No transport',
};

const ERR: Record<string, string> = {
  missing: 'Required fields are empty.',
  smtp_missing: 'SMTP needs host, a valid port (1–65535), username, and password.',
  BILLING_CREDENTIALS_INVALID: 'Credentials were rejected. Check the values and try again.',
};

export default async function EmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string';
  const removed = typeof sp.removed === 'string';

  const [config, control, stats] = await Promise.all([
    api<EmailConfigRow>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-config`,
    }),
    api<SendControl>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-send-control`,
    }),
    api<SendStats>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-stats?hours=24`,
    }).catch(() => null),
  ]);

  const saveCredsBound = saveCreds.bind(null, id);
  const removeCredsBound = removeCreds.bind(null, id);

  return (
    <div className="space-y-6">
      {(saved || removed) && (
        <SavedBanner
          params={['saved', 'removed']}
          message={saved ? 'Email settings saved.' : 'BYO credentials removed; using the default transport now.'}
        />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
        </Banner>
      )}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">Email transport</h2>
          <div className="flex items-center gap-3">
            <Link
              href={`/applications/${id}/email/logs`}
              className="text-xs font-medium text-[var(--color-primary)] hover:underline"
            >
              View send logs →
            </Link>
            <span
              className={
                'text-xs px-2 py-0.5 rounded-full border ' +
                (config.transport === 'byo_resend' || config.transport === 'byo_smtp'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300'
                  : config.transport === 'default_resend'
                    ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-300'
                    : 'bg-neutral-50 border-neutral-200 text-neutral-700 dark:bg-neutral-900 dark:border-neutral-800 dark:text-neutral-300')
              }
            >
              {TRANSPORT_LABEL[config.transport]}
            </span>
          </div>
        </div>
        <p className="text-sm text-[var(--color-muted-fg)]">
          {TRANSPORT_BLURB[config.transport]}
        </p>
        {config.effectiveFromAddress && (
          <p className="text-xs font-mono text-[var(--color-muted-fg)]">
            From: {config.effectiveFromAddress}
          </p>
        )}
      </section>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <header className="flex items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">BYO email transport</h2>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Send from your own provider: Resend (API key) or any SMTP server (Amazon SES,
              Postmark, SendGrid, Mailgun, Gmail/Workspace, or a custom relay). Credentials are
              encrypted at rest.
            </p>
          </div>
          {config.hasCustomCredentials && (
            <ActionForm action={removeCredsBound}>
              <ConfirmButton confirm="Remove BYO credentials? The Application will fall back to the default transport.">
                Remove
              </ConfirmButton>
            </ActionForm>
          )}
        </header>
        <EmailCredentialsForm
          action={saveCredsBound}
          defaults={{
            fromAddress: config.emailConfig.fromAddress ?? '',
            fromName: config.emailConfig.fromName ?? '',
            replyTo: config.emailConfig.replyTo ?? '',
          }}
          hasCustomCredentials={config.hasCustomCredentials}
          currentProvider={
            config.provider === 'smtp' ? 'smtp' : config.provider === 'resend' ? 'resend' : null
          }
        />
      </section>

      {stats && (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-2">
          <h2 className="text-base font-semibold">Last 24 hours</h2>
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
            <Stat label="Sent" value={stats.sent} />
            <Stat label="Failed" value={stats.error} tone={stats.error > 0 ? 'warn' : undefined} />
            <Stat
              label="Suppressed"
              value={stats.suppressed}
              tone={stats.suppressed > 0 ? 'warn' : undefined}
            />
            <Stat label="No transport" value={stats.noTransport} />
          </div>
          <p className="text-xs text-[var(--color-muted-fg)]">
            <strong>Suppressed</strong> means Rekey deliberately did not send: the switch below, the
            event, or the address. It is an outcome, not a failure, and the detail is on{' '}
            <Link
              href={`/applications/${id}/email/logs`}
              className="font-medium text-[var(--color-primary)] hover:underline"
            >
              Delivery
            </Link>
            .
          </p>
        </section>
      )}

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">
              {control.emailsEnabled ? 'Email is on' : 'Email is off'}
            </h2>
            <p className="max-w-2xl text-xs text-[var(--color-muted-fg)]">
              The master switch for every email this Application sends to its end-users. Turning it
              off stops all of them: verification, reset, magic link, welcome, dunning. Attempted
              sends are still recorded on Delivery, so &ldquo;why did they not get it&rdquo; stays
              answerable.
            </p>
            <p className="mt-1 max-w-2xl text-xs text-[var(--color-muted-fg)]">
              Workspace mail (operator invitations and the like) is unaffected. And this does{' '}
              <strong>not</strong> hand you the tokens instead: a suppressed send withholds the
              reset or magic-link token rather than returning it. If your own backend delivers
              those, leave email on and remove the transport credentials below.
            </p>
          </div>
          <ActionForm action={setEmailsEnabled.bind(null, id, !control.emailsEnabled)}>
            {control.emailsEnabled ? (
              <ConfirmButton
                confirm="Stop every email this Application sends to its end-users? Password resets, verification and magic links stop arriving. Events that a live sign-in method depends on are protected individually, but this switch overrides all of them."
                title="Turn all email off?"
                confirmLabel="Turn email off"
              >
                Turn email off
              </ConfirmButton>
            ) : (
              <SubmitButton pendingLabel="Turning on…">Turn email on</SubmitButton>
            )}
          </ActionForm>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'warn' | undefined;
}): React.JSX.Element {
  return (
    <div>
      <div
        className={`text-2xl font-semibold tabular-nums ${
          tone === 'warn' ? 'text-amber-600 dark:text-amber-500' : ''
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-[var(--color-muted-fg)]">{label}</div>
    </div>
  );
}
