import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
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
}

async function rotateSecret(applicationId: string, endpointId: string): Promise<void> {
  'use server';
  const result = await api<{ secret: string }>({
    method: 'POST',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}/rotate-secret`,
  });
  // One-time secret via a short-lived httpOnly cookie, not the URL.
  const jar = await cookies();
  jar.set('relipay_reveal_whsec', result.secret, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/applications/${applicationId}/webhooks/${endpointId}`,
    maxAge: 120,
  });
  revalidatePath(`/applications/${applicationId}/webhooks/${endpointId}`);
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
  revalidatePath(`/applications/${applicationId}/webhooks/${endpointId}`);
  redirect(`/applications/${applicationId}/webhooks/${endpointId}?retried=1`);
}

const STATUS_TONE: Record<DeliveryRow['status'], BadgeTone> = {
  SUCCEEDED: 'success',
  PENDING: 'warning',
  FAILED: 'danger',
};

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
  const rotatedSecret = (await cookies()).get('relipay_reveal_whsec')?.value ?? null;
  const retried = typeof sp.retried === 'string';

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
      className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"
    >
      ← Webhooks
    </Link>
  );

  const endpoint = endpoints.find((e) => e.id === endpointId);
  if (!endpoint) {
    return (
      <div className="space-y-5">
        <PageHeader eyebrow={backLink} title="Endpoint not found" />
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
        <SectionHeader title="Recent deliveries" count={`${deliveries.length} of last 50`} />
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
                <TR key={d.id} hover>
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
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
