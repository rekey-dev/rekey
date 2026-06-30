import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, PanelApiError } from '@/lib/api';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SavedBanner } from '@/components/SavedBanner';
import { EmailCredentialsForm } from './EmailCredentialsForm';

type Transport = 'byo_resend' | 'byo_smtp' | 'default_resend' | 'none';

interface EmailConfigRow {
  emailConfig: { fromAddress?: string; fromName?: string; replyTo?: string };
  hasCustomCredentials: boolean;
  transport: Transport;
  provider: 'resend' | 'smtp' | 'default' | 'none';
  effectiveFromAddress: string | null;
}

interface EventRow {
  key: string;
  label: string;
  customised: boolean;
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
      redirect(`/applications/${applicationId}/email?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/email`);
  redirect(`/applications/${applicationId}/email?saved=1`);
}

async function removeCreds(applicationId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-credentials`,
  });
  revalidatePath(`/applications/${applicationId}/email`);
  redirect(`/applications/${applicationId}/email?removed=1`);
}

const TRANSPORT_BLURB: Record<Transport, string> = {
  byo_resend: 'Using your own Resend account. Templates are sent from the address below.',
  byo_smtp: 'Using your own SMTP server. Templates are sent from the address below.',
  default_resend:
    'Falling back to the ReliPay-managed Resend pool. To use your own brand and unlock higher quotas, configure BYO credentials.',
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
  BILLING_CREDENTIALS_INVALID: 'Credentials were rejected — check the values and try again.',
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
  const saved = typeof sp.saved === 'string';
  const removed = typeof sp.removed === 'string';

  const [config, events] = await Promise.all([
    api<EmailConfigRow>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-config`,
    }),
    api<EventRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-templates`,
    }),
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
        <p role="alert" className="rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {ERR[error] ?? error}
        </p>
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
              Send from your own provider — Resend (API key) or any SMTP server (Amazon SES,
              Postmark, SendGrid, Mailgun, Gmail/Workspace, or a custom relay). Credentials are
              encrypted at rest.
            </p>
          </div>
          {config.hasCustomCredentials && (
            <form action={removeCredsBound}>
              <ConfirmButton confirm="Remove BYO credentials? The Application will fall back to the default transport.">
                Remove
              </ConfirmButton>
            </form>
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

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
        <header className="flex items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Templates</h2>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Customize per-event subject + body, or leave the ReliPay defaults.
            </p>
          </div>
        </header>
        <div className="-mx-5 -mb-5 border-t border-[var(--color-border)]">
          <table className="w-full text-sm">
            <tbody>
              {events.map((e) => (
                <tr key={e.key} className="border-b border-[var(--color-border)] last:border-b-0">
                  <td className="px-5 py-3 align-middle">
                    <div className="font-medium">{e.label}</div>
                    <div className="text-xs font-mono text-[var(--color-muted-fg)]">{e.key}</div>
                  </td>
                  <td className="px-5 py-3 align-middle">
                    <span
                      className={
                        'text-xs px-2 py-0.5 rounded-full border ' +
                        (e.customised
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300'
                          : 'bg-neutral-50 border-neutral-200 text-neutral-700 dark:bg-neutral-900 dark:border-neutral-800 dark:text-neutral-300')
                      }
                    >
                      {e.customised ? 'Customized' : 'Default'}
                    </span>
                  </td>
                  <td className="px-5 py-3 align-middle text-right">
                    <Link
                      href={`/applications/${id}/email/${encodeURIComponent(e.key)}`}
                      className="text-sm font-medium text-[var(--color-primary)] hover:underline"
                    >
                      Edit →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
