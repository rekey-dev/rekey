import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { api } from '@/lib/api';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { formatDateTime } from '@/lib/date';
import { CopyButton } from '@/components/CopyButton';
import { CopyLinkButton } from '@/components/CopyLinkButton';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';

interface EndpointRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

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
  /**
   * Both are STORED (`WebhookDelivery.payload` / `.responseBody`, the latter
   * already capped at 4 KB on write) and both are loaded by the service — but
   * the tenant route's serializer drops them before responding, so today these
   * arrive `undefined` on every row.
   *
   * They are declared optional rather than omitted because the UI below is the
   * consumer that makes fixing it worthwhile: the moment the serializer
   * includes them, the expanded row starts rendering real content with no
   * further panel change. Until then the row explains the gap instead of
   * showing an empty box.
   */
  payload?: unknown;
  responseBody?: string | null;
}

/** Response bodies can be 4 KB of nginx HTML; show the head of it. */
const RESPONSE_BODY_LIMIT = 600;

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  return s.length <= max
    ? { text: s, truncated: false }
    : { text: s.slice(0, max), truncated: true };
}

async function rotateSecret(applicationId: string, endpointId: string): Promise<void> {
  'use server';
  const result = await api<{ secret: string }>({
    method: 'POST',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/rotate-secret`,
  });
  // One-time secret via a short-lived httpOnly cookie, not the URL.
  const jar = await cookies();
  jar.set('rekey_reveal_whsec', result.secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/applications/${applicationId}/webhooks/${endpointId}`,
    maxAge: 120,
  });
  redirect(`/applications/${applicationId}/webhooks/${endpointId}?rotated=1`);
}

async function retryDelivery(
  applicationId: string,
  endpointId: string,
  deliveryId: string,
): Promise<void> {
  'use server';
  await api({
    method: 'POST',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
  });
  redirect(`/applications/${applicationId}/webhooks/${endpointId}?retried=1`);
}

/**
 * Requeue every non-succeeded delivery on this endpoint.
 *
 * A dead endpoint produces a page of a dozen failures and the only control was
 * a per-row Retry — twelve clicks, each a full page navigation, to recover from
 * one outage. There is no bulk endpoint API-side (`retry-all` does not exist on
 * any surface), so this fans out the per-delivery call. Sequential rather than
 * Promise.all: these all hit the same customer URL that just failed, and a
 * dozen simultaneous POSTs is the wrong way to greet a server coming back up.
 *
 * Failures are counted, not thrown — one delivery that has since been evicted
 * shouldn't abandon the other eleven.
 */
async function retryAllFailed(applicationId: string, endpointId: string): Promise<void> {
  'use server';
  const rows = await api<DeliveryRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/deliveries`,
  });
  const failed = rows.filter((r) => r.status === 'FAILED');
  let queued = 0;
  for (const d of failed) {
    try {
      await api({
        method: 'POST',
        path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/deliveries/${encodeURIComponent(d.id)}/retry`,
      });
      queued += 1;
    } catch {
      /* already retried, evicted, or raced — keep going */
    }
  }
  redirect(
    `/applications/${applicationId}/webhooks/${endpointId}?retriedAll=${queued}&of=${failed.length}`,
  );
}

const STATUS_TONE: Record<DeliveryRow['status'], BadgeTone> = {
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
};

/** What we sent and what came back, for one delivery. */
function DeliveryDetail({ delivery: d }: { delivery: DeliveryRow }): React.JSX.Element {
  const payloadText =
    d.payload === undefined || d.payload === null
      ? null
      : typeof d.payload === 'string'
        ? d.payload
        : JSON.stringify(d.payload, null, 2);
  const body =
    d.responseBody === undefined || d.responseBody === null
      ? null
      : truncate(d.responseBody, RESPONSE_BODY_LIMIT);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delivery id" value={d.id} mono />
        <Field label="Event id" value={d.eventId} mono />
        <Field
          label="Response status"
          value={d.responseStatus === null ? 'no response (network error or timeout)' : String(d.responseStatus)}
        />
        <Field
          label="Next attempt"
          value={d.nextAttemptAt === null ? '—' : formatDateTime(d.nextAttemptAt)}
        />
      </div>

      {d.error && (
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">
            Error
          </div>
          <p className="mt-1 break-all font-mono text-xs text-red-700 dark:text-red-400">{d.error}</p>
        </div>
      )}

      <div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">
          Request payload
        </div>
        {payloadText === null ? (
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
            Stored, but not returned by the API — the tenant delivery endpoint omits{' '}
            <code className="font-mono">payload</code> from its response. This panel renders it as
            soon as the field is served.
          </p>
        ) : (
          <pre className="mt-1 max-h-64 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] text-[var(--color-fg)]">
            {payloadText}
          </pre>
        )}
      </div>

      <div>
        <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">
          Response body
        </div>
        {body === null ? (
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">
            Stored (capped at 4 KB), but not returned by the API — the tenant delivery endpoint
            omits <code className="font-mono">responseBody</code> from its response.
          </p>
        ) : body.text === '' ? (
          <p className="mt-1 text-xs text-[var(--color-muted-fg)]">Empty body.</p>
        ) : (
          <>
            <pre className="mt-1 max-h-48 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2 font-mono text-[11px] text-[var(--color-fg)]">
              {body.text}
            </pre>
            {body.truncated && (
              <p className="mt-1 text-[10px] text-[var(--color-muted-fg)]">
                Truncated to the first {RESPONSE_BODY_LIMIT} characters.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)]">
        {label}
      </div>
      <div className={`truncate text-xs text-[var(--color-fg)] ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
    </div>
  );
}

export default async function WebhookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; endpointId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, endpointId } = await params;
  const sp = await searchParams;
  const rotated = typeof sp.rotated === 'string';
  const rotatedSecret = (await cookies()).get('rekey_reveal_whsec')?.value ?? null;
  const retried = typeof sp.retried === 'string';
  const retriedAll = typeof sp.retriedAll === 'string' ? sp.retriedAll : null;
  const retriedAllOf = typeof sp.of === 'string' ? sp.of : null;

  const [endpoints, deliveries] = await Promise.all([
    api<EndpointRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/webhooks`,
    }),
    api<DeliveryRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/webhooks/${encodeURIComponent(endpointId)}/deliveries`,
    }),
  ]);

  const backLink = (
    <Link
      href={`/applications/${id}/webhooks`}
      className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
    >
      ← Webhooks
    </Link>
  );

  const failedCount = deliveries.filter((d) => d.status === 'FAILED').length;
  const endpoint = endpoints.find((e) => e.id === endpointId);
  if (!endpoint) {
    return (
      <div className="space-y-5">
        <PageHeader
        level={2} eyebrow={backLink} title="Endpoint not found" />
        <EmptyState
          variant="inline"
          title="This webhook endpoint no longer exists"
          description="It may have been deleted. Head back to the webhooks list to see the current endpoints."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        level={2}
        eyebrow={backLink}
        title={<span className="break-all font-mono text-lg">{endpoint.url}</span>}
        description={
          endpoint.events.includes('*')
            ? 'Subscribed to all events.'
            : `Subscribed to: ${endpoint.events.join(', ')}`
        }
        action={
          <div className="flex items-center gap-2">
            <Badge tone={endpoint.enabled ? 'success' : 'neutral'} dot>
              {endpoint.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <CopyLinkButton />
          </div>
        }
      />

      {rotated && rotatedSecret && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950/60 space-y-2">
          <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
            New signing secret — shown once
          </div>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Update your consumer immediately. Old signatures stop verifying right away.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md border border-amber-200 bg-[var(--color-surface)] px-3 py-2 font-mono text-xs dark:border-amber-800">
              {rotatedSecret}
            </code>
            <CopyButton value={rotatedSecret} label="Copy" />
          </div>
        </div>
      )}
      {retried && <SavedBanner params={['retried']} message="Retry queued." />}
      {retriedAll !== null && (
        <SavedBanner
          params={['retriedAll', 'of']}
          message={`Requeued ${retriedAll} of ${retriedAllOf ?? retriedAll} failed deliveries.`}
        />
      )}

      <Card className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Signing secret</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            We don't store the raw secret — rotate to generate a new one.
          </p>
        </div>
        <form action={rotateSecret.bind(null, id, endpointId)}>
          <ConfirmButton confirm="Rotate the signing secret? Old signatures stop verifying immediately — update your consumer with the new value before the next delivery.">
            Rotate secret
          </ConfirmButton>
        </form>
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title="Recent deliveries"
          count={`${deliveries.length} of last 50`}
          action={
            failedCount > 0 ? (
              <form action={retryAllFailed.bind(null, id, endpointId)}>
                <SubmitButton
                  pendingLabel={`Queuing ${failedCount}…`}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                >
                  Retry all failed ({failedCount})
                </SubmitButton>
              </form>
            ) : undefined
          }
        />
        {deliveries.length === 0 ? (
          <EmptyState
            title="No deliveries yet"
            description="Trigger an event (sign-up, password change, MFA enroll) to see one here."
          />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Event</TH>
                <TH>Status</TH>
                <TH>Attempts</TH>
                <TH>Created</TH>
                <TH align="right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {deliveries.map((d) => (
                <React.Fragment key={d.id}>
                  <TR hover className="border-b-0">
                    <TD>
                      <div className="font-mono text-xs">{d.eventType}</div>
                      <div title={d.eventId} className="max-w-[14rem] truncate font-mono text-[10px] text-[var(--color-muted-fg)]">
                        {d.eventId}
                      </div>
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONE[d.status]} dot>
                        {d.status}
                        {d.responseStatus ? ` · ${d.responseStatus}` : ''}
                      </Badge>
                      {d.error && (
                        <div title={d.error} className="mt-1 max-w-[18rem] truncate text-[10px] text-[var(--color-muted-fg)]">
                          {d.error}
                        </div>
                      )}
                    </TD>
                    <TD className="text-xs">{d.attempts}</TD>
                    <TD muted className="text-xs">
                      {formatDateTime(d.createdAt)}
                    </TD>
                    <TD align="right">
                      {d.status !== 'SUCCEEDED' && (
                        <form action={retryDelivery.bind(null, id, endpointId, d.id)} className="inline">
                          <SubmitButton
                            pendingLabel="Queuing…"
                            className="text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-60"
                          >
                            Retry
                          </SubmitButton>
                        </form>
                      )}
                    </TD>
                  </TR>
                  {/* Expandable detail. A native <details> keeps this a server
                      component — no client JS, keyboard-operable, and each row
                      opens independently. Debugging a failed delivery meant
                      leaving the product entirely before this existed: neither
                      what we sent nor what came back was visible anywhere. */}
                  <TR className="!bg-transparent">
                    <TD colSpan={5} className="!py-0">
                      <details className="group pb-3">
                        <summary className="cursor-pointer list-none text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]">
                          <span className="inline-block w-3 transition-transform group-open:rotate-90">
                            ›
                          </span>{' '}
                          Payload &amp; response
                        </summary>
                        <div className="mt-2 space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
                          <DeliveryDetail delivery={d} />
                        </div>
                      </details>
                    </TD>
                  </TR>
                </React.Fragment>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
