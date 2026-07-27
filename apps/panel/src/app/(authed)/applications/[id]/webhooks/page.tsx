import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { api, PanelApiError } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { CopyButton } from '@/components/CopyButton';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

interface EndpointRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

const ALL_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  'session.revoked',
  'mfa.enabled',
  'mfa.disabled',
  'password.changed',
  'email.verified',
  'subscription.activated',
  'subscription.canceled',
  'subscription.past_due',
  'payment.succeeded',
  'payment.failed',
];

const ERR: Record<string, string> = {
  missing: 'A URL and at least one event are required.',
  WEBHOOK_URL_UNSAFE:
    'That URL is not allowed — use a public HTTPS URL (private/internal hosts are blocked).',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage webhook endpoints.',
  APPLICATION_NOT_FOUND: 'Application not found.',
};

async function createEndpoint(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const url = String(formData.get('url') ?? '').trim();
  const events = formData.getAll('events').map(String).filter(Boolean);
  const wildcard = String(formData.get('wildcard') ?? '');
  const selected = wildcard ? ['*'] : events.length > 0 ? events : [];
  if (!url || selected.length === 0) {
    redirect(`/applications/${applicationId}/webhooks?error=missing&newWebhook=1`);
  }
  let secret = '';
  try {
    const result = await api<{ id: string; secret: string }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks`,
      body: { url, events: selected },
    });
    secret = result.secret;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/webhooks?error=${encodeURIComponent(err.code)}&newWebhook=1`);
    }
    throw err;
  }
  // One-time signing secret via a short-lived httpOnly cookie, not the URL.
  const jar = await cookies();
  jar.set('relipay_reveal_whsec', secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/applications/${applicationId}/webhooks`,
    maxAge: 120,
  });
  revalidatePath(`/applications/${applicationId}/webhooks`);
  redirect(
    `/applications/${applicationId}/webhooks?created=1&e=webhook_created`,
  );
}

async function deleteEndpoint(applicationId: string, endpointId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}`,
  });
  revalidatePath(`/applications/${applicationId}/webhooks`);
  redirect(`/applications/${applicationId}/webhooks?removed=1`);
}

async function toggleEndpoint(applicationId: string, endpointId: string, enabled: boolean): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}`,
    body: { enabled },
  });
  revalidatePath(`/applications/${applicationId}/webhooks`);
  redirect(`/applications/${applicationId}/webhooks?toggled=1`);
}

export default async function WebhooksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const created = typeof sp.created === 'string';
  const secret = (await cookies()).get('relipay_reveal_whsec')?.value ?? null;
  const removed = typeof sp.removed === 'string';
  const toggled = typeof sp.toggled === 'string';
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const endpoints = await api<EndpointRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/webhooks`,
  });

  const createBound = createEndpoint.bind(null, id);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Webhook endpoints"
        description={
          <>
            Events Rekey sends to your backend when things happen (sign-ups, payments, dunning).
            Each endpoint gets a signing secret — deliveries carry an HMAC-SHA256 signature in{' '}
            <code className="font-mono">X-Rekey-Signature</code>.
          </>
        }
        action={
        <Modal
          trigger="+ Add endpoint"
          title="Add webhook endpoint"
          description="Rekey POSTs user lifecycle events to the URL with an HMAC-signed body."
          modalKey="newWebhook"
        >
          <form action={createBound} className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">URL</span>
              <input
                type="url"
                name="url"
                required
                placeholder="https://your-app.example.com/api/rekey/webhook"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
              />
            </label>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Events</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="wildcard" value="1" defaultChecked />
                <span>Subscribe to all events (recommended for new endpoints)</span>
              </label>
              <details className="rounded-md border border-[var(--color-border)] px-3 py-2">
                <summary className="text-xs text-[var(--color-muted-fg)] cursor-pointer">
                  Or pick specific events…
                </summary>
                <div className="grid grid-cols-2 gap-1 mt-2">
                  {ALL_EVENTS.map((e) => (
                    <label key={e} className="flex items-center gap-2 text-xs font-mono">
                      <input type="checkbox" name="events" value={e} />
                      <span>{e}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-[var(--color-muted-fg)] mt-2">
                  Untick the wildcard checkbox above to use this list. Otherwise it's ignored.
                </p>
              </details>
            </fieldset>
            <SubmitButton pendingLabel="Creating endpoint…">Create endpoint</SubmitButton>
          </form>
        </Modal>
        }
      />

      <p className="text-xs text-[var(--color-muted-fg)]">
        New to webhooks? The{' '}
        <a
          className="underline hover:text-[var(--color-fg)]"
          href="https://relipay.dev/docs/webhooks"
          target="_blank"
          rel="noopener noreferrer"
        >
          payload &amp; verification guide on relipay.dev/docs/webhooks
        </a>{' '}
        covers the JSON envelope Rekey sends, the full event list, and how to verify the{' '}
        <code className="font-mono">X-Rekey-Signature</code> header in your handler.
      </p>

      {created && secret && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/60 space-y-2">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Signing secret — shown once
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Store this now. You'll use it to verify the{' '}
            <code className="font-mono">X-Rekey-Signature</code> header on every inbound
            delivery. Rekey never displays it again — rotate from the endpoint detail page if lost.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md border border-amber-200 bg-[var(--color-surface)] px-3 py-2 font-mono text-xs dark:border-amber-800">
              {secret}
            </code>
            <CopyButton value={secret} label="Copy" />
          </div>
        </div>
      )}
      {(removed || toggled) && (
        <SavedBanner
          params={['removed', 'toggled']}
          message={removed ? 'Endpoint removed.' : 'Endpoint updated.'}
        />
      )}
      {error && (
        <Banner tone="error">
          {ERR[error] ?? 'Something went wrong. Please try again.'}
        </Banner>
      )}

      {endpoints.length === 0 ? (
        <EmptyState
          title="No webhook endpoints yet"
          description="Add one above to start receiving user lifecycle events."
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>URL</TH>
              <TH>Events</TH>
              <TH>Status</TH>
              <TH align="right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {endpoints.map((e) => (
              <TR key={e.id} hover>
                <TD mono className="max-w-[24rem] truncate" title={e.url}>{e.url}</TD>
                <TD className="text-xs">
                  {e.events.includes('*') ? (
                    <span className="text-[var(--color-muted-fg)]">All events</span>
                  ) : (
                    <span>{e.events.length} event{e.events.length === 1 ? '' : 's'}</span>
                  )}
                </TD>
                <TD>
                  <Badge tone={e.enabled ? 'success' : 'neutral'} dot>
                    {e.enabled ? 'Enabled' : 'Disabled'}
                  </Badge>
                </TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/applications/${id}/webhooks/${e.id}`}
                      className="text-xs font-medium text-[var(--color-fg)] hover:underline"
                    >
                      Details
                    </Link>
                    <form action={toggleEndpoint.bind(null, id, e.id, !e.enabled)} className="inline">
                      <SubmitButton
                        pendingLabel={e.enabled ? 'Disabling…' : 'Enabling…'}
                        className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline disabled:opacity-60"
                      >
                        {e.enabled ? 'Disable' : 'Enable'}
                      </SubmitButton>
                    </form>
                    <form action={deleteEndpoint.bind(null, id, e.id)} className="inline">
                      <ConfirmButton confirm="Delete this webhook endpoint? Pending deliveries are cancelled and history is removed.">
                        Delete
                      </ConfirmButton>
                    </form>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
