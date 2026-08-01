import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
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

/**
 * Per-endpoint delivery health over the last 24 hours.
 *
 * An endpoint with 12 of 12 deliveries failing rendered "● Enabled" in green,
 * pixel-identical to a working one — "enabled" is a config flag, and the list
 * was showing configuration where the operator needed behaviour. Finding the
 * dead one meant opening Details on every endpoint in turn.
 *
 * There is no tenant-side aggregate to read. `/admin/metrics/webhook-endpoint-
 * health` computes exactly this, but it is `requireSuperAdmin` and
 * deployment-wide, so an operator cannot call it. The only tenant source is
 * `GET .../webhooks/:endpointId/deliveries`, which takes no query parameters at
 * all: no status filter, no time window, no limit (the route pins the service's
 * page size to 50). So the panel fans out one request per endpoint — bounded by
 * the endpoint count, not by volume — and counts the rows inside the window.
 *
 * The 50-row cap is a real limit and the UI does not hide it: when the page is
 * saturated AND its oldest row is still inside 24h, the counts are a floor and
 * the cell says so.
 */
interface DeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  nextAttemptAt: string | null;
}

interface EndpointHealth {
  succeeded: number;
  failed: number;
  pending: number;
  total: number;
  /** True when the 50-row page couldn't cover the whole 24h window. */
  truncated: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The route hardwires the service's page size; mirrored so `truncated` is right. */
const DELIVERY_PAGE_SIZE = 50;

async function endpointHealth(
  applicationId: string,
  endpointId: string,
): Promise<EndpointHealth | null> {
  const rows = await api<DeliveryRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/deliveries`,
  }).catch(() => null);
  if (rows === null) return null;

  const cutoff = Date.now() - DAY_MS;
  const recent = rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
  const oldest = rows[rows.length - 1];
  const truncated =
    rows.length >= DELIVERY_PAGE_SIZE &&
    oldest !== undefined &&
    new Date(oldest.createdAt).getTime() >= cutoff;

  return {
    succeeded: recent.filter((r) => r.status === 'SUCCEEDED').length,
    failed: recent.filter((r) => r.status === 'FAILED').length,
    pending: recent.filter((r) => r.status === 'PENDING').length,
    total: recent.length,
    truncated,
  };
}

/**
 * Colour by how bad it is, not by whether anything failed at all: a single
 * failure among fifty is noise, everything failing is an outage. Thresholds
 * match how the super-admin dashboard reads its own success rate.
 */
function HealthCell({ health }: { health: EndpointHealth | null }): React.JSX.Element {
  if (health === null) {
    return <span className="text-xs text-[var(--color-muted-fg)]">—</span>;
  }
  if (health.total === 0) {
    return <span className="text-xs text-[var(--color-muted-fg)]">No deliveries</span>;
  }
  const failRate = health.failed / health.total;
  const tone = failRate === 0 ? 'success' : failRate >= 0.5 ? 'danger' : 'warning';
  const suffix = health.truncated ? '+' : '';
  return (
    <span
      className="inline-flex flex-col items-start gap-0.5"
      title={
        `Last 24h: ${health.succeeded} succeeded, ${health.failed} failed, ${health.pending} pending.` +
        (health.truncated
          ? ' Counted from the most recent 50 attempts, which do not reach back a full 24 hours — the real totals are higher.'
          : '')
      }
    >
      {health.failed === 0 ? (
        <Badge tone="success">
          {health.total}
          {suffix} delivered
        </Badge>
      ) : (
        <Badge tone={tone} dot>
          {health.failed}/{health.total}
          {suffix} failed
        </Badge>
      )}
      {health.pending > 0 && (
        <span className="text-[10px] text-[var(--color-muted-fg)]">
          {health.pending} in flight
        </span>
      )}
    </span>
  );
}

const ERR: Record<string, string> = {
  missing: 'A URL and at least one event are required.',
  WEBHOOK_URL_UNSAFE:
    'That URL is not allowed — use a public HTTPS URL (private/internal hosts are blocked).',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage webhook endpoints.',
  APPLICATION_NOT_FOUND: 'Application not found.',
};

// These actions deliberately redirect without revalidatePath — pairing the two
// is what blanked this page after an endpoint was added. Reasoning in
// `(authed)/layout.tsx`.

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
  jar.set('rekey_reveal_whsec', secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/applications/${applicationId}/webhooks`,
    maxAge: 120,
  });
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
  redirect(`/applications/${applicationId}/webhooks?removed=1`);
}

async function toggleEndpoint(applicationId: string, endpointId: string, enabled: boolean): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}`,
    body: { enabled },
  });
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
  const secret = (await cookies()).get('rekey_reveal_whsec')?.value ?? null;
  const removed = typeof sp.removed === 'string';
  const toggled = typeof sp.toggled === 'string';
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const endpoints = await api<EndpointRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/webhooks`,
  });
  // One request per endpoint, in parallel. The endpoint list is capped at 100
  // API-side and is realistically a handful.
  const healths = await Promise.all(endpoints.map((e) => endpointHealth(id, e.id)));
  const healthById = new Map(endpoints.map((e, i) => [e.id, healths[i] ?? null]));
  const failingCount = healths.filter((h) => h !== null && h.failed > 0).length;

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
          href="https://rekey.dev/docs/webhooks"
          target="_blank"
          rel="noopener noreferrer"
        >
          payload &amp; verification guide on rekey.dev/docs/webhooks
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

      {failingCount > 0 && (
        <Banner tone="warning">
          {failingCount === 1
            ? 'One endpoint has failed deliveries in the last 24 hours.'
            : `${failingCount} endpoints have failed deliveries in the last 24 hours.`}{' '}
          Open Details to see the payload and the response your server returned.
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
              <TH>Last 24h</TH>
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
                <TD>
                  <HealthCell health={healthById.get(e.id) ?? null} />
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
