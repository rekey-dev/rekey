/**
 * Subscription imports: start one, and see the ones already run.
 *
 * Starting an import does NOT import anything. It reads the provider and
 * produces a preview, which is the whole design: an import is a bulk write
 * against somebody else's data, matching strangers to local accounts by email,
 * and a one-click version of that is a mistake you cannot take back.
 *
 * So this page's job is mostly to say what is about to happen, clearly enough
 * that the operator understands the preview is a step and not a delay.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { errorMessage } from '@/lib/error-message';
import { api, apiGet, getApplication, PanelApiError } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { formatDateTime } from '@/lib/date';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';

interface ImportRun {
  id: string;
  provider: string;
  mode: string;
  status: string;
  matchStrategy: string;
  counts: Record<string, number>;
  error: string | null;
  createdAt: string;
  /** `applying` with no heartbeat for five minutes: the apply was interrupted. */
  stale: boolean;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  ready: 'info',
  applied: 'success',
  failed: 'danger',
  running: 'neutral',
  applying: 'neutral',
  queued: 'neutral',
};

const START_ERR: Record<string, string> = {
  PROVIDER_CANNOT_LIST_SUBSCRIPTIONS:
    'That provider has no list API, so there is nothing to import from. Only a billing system that exposes its subscriptions can be read.',
  EXTERNAL_PULL_NOT_CONFIGURED:
    'No subscriptions endpoint is configured for the external provider. Set the URL and pull token under Billing → Providers.',
  EXTERNAL_PULL_URL_REFUSED:
    'That subscriptions endpoint is not a permitted target. It must be a public HTTPS URL.',
  EXTERNAL_PULL_UNREACHABLE: 'The subscriptions endpoint did not respond in time.',
  EXTERNAL_PULL_FAILED:
    'The subscriptions endpoint refused the request. A 401 usually means the pull token or the signature check disagrees.',
  EXTERNAL_PULL_MALFORMED:
    'The endpoint replied with something other than a JSON object containing an `items` array.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can import subscriptions.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
};

async function startImport(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const provider = String(formData.get('provider') ?? 'external');
  const matchStrategy = String(formData.get('matchStrategy') ?? 'email');
  const base = `/applications/${applicationId}/imports`;
  let runId: string;
  try {
    const res = await api<{ runId: string }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/subscription-imports`,
      body: { provider, matchStrategy },
    });
    runId = res.runId;
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?startError=${encodeURIComponent(err.code)}&start=1`);
    }
    throw err;
  }
  redirect(`${base}/${runId}`);
}

export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const startError = typeof sp.startError === 'string' ? sp.startError : undefined;

  const [application, runs] = await Promise.all([
    getApplication(id),
    apiGet<Page<ImportRun>>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/subscription-imports?limit=25`,
      { interruptOnAccessError: false },
    ).catch(() => null),
  ]);

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Import subscriptions"
        description="Bring in what a billing system already sold, before it was connected to Rekey. Starting an import previews it; nothing is written until you apply."
        action={<StartButton applicationId={id} error={startError} />}
      />

      {startError && <Banner tone="error">{errorMessage(START_ERR, startError)}</Banner>}

      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">Before you start</h3>
        <ul className="list-disc space-y-1 pl-5 text-xs text-[var(--color-muted-fg)]">
          <li>
            Subscribers are matched by <strong>email</strong>. Somebody whose address differs
            between the two systems will not match, and will be reported rather than guessed at.
          </li>
          <li>
            An end-user who already has a live subscription in Rekey is <strong>skipped</strong>.
            An import never overwrites entitlement somebody already has.
          </li>
          <li>
            Importing <strong>announces</strong> <code className="font-mono">subscription.activated</code>{' '}
            to your webhook endpoints for every row, the same as a real sale. If something
            downstream provisions on that event, it will run for all of them.
          </li>
          <li>
            Provider plans map to Rekey plans by slug, or by a provider id recorded on the plan.
            Unmapped rows are reported so you can fix the mapping and run again.
          </li>
          <li>
            For your own billing system, the endpoint Rekey reads is specified in{' '}
            <code className="font-mono">docs/external-billing-pull.md</code>.
          </li>
        </ul>
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Recent runs" count={runs ? `(${runs.page.total})` : undefined} />
        {runs === null ? (
          <Banner tone="error">Import runs could not be read.</Banner>
        ) : runs.items.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No imports yet"
            description={`Nothing has been imported into ${application.name}.`}
          />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>Started</TH>
                <TH>Provider</TH>
                <TH>Status</TH>
                <TH>Rows</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {runs.items.map((r) => (
                <TR key={r.id} hover>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(r.createdAt)}
                  </TD>
                  <TD muted className="text-xs">
                    {r.provider}
                  </TD>
                  <TD>
                    <Badge tone={r.stale ? 'warning' : (STATUS_TONE[r.status] ?? 'neutral')} dot>
                      {r.stale ? 'interrupted' : r.status}
                    </Badge>
                    {r.error && (
                      <div className="mt-0.5 max-w-[18rem] truncate text-[11px] text-[var(--color-muted-fg)]" title={r.error}>
                        {r.error}
                      </div>
                    )}
                  </TD>
                  <TD muted className="text-xs tabular-nums">
                    {r.counts.total ?? 0}
                    {typeof r.counts.imported === 'number' && ` · ${r.counts.imported} imported`}
                  </TD>
                  <TD align="right">
                    <Link
                      href={`/applications/${id}/imports/${r.id}`}
                      className="text-sm font-medium text-[var(--color-primary)] hover:underline"
                    >
                      {r.status === 'ready' || r.stale ? 'Review →' : 'View →'}
                    </Link>
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

function StartButton({
  applicationId,
  error,
}: {
  applicationId: string;
  error?: string | undefined;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="start"
      title="Import subscriptions"
      description="This reads your billing system and shows you what it found. Nothing is written until you review the result and apply it."
      trigger="Import subscriptions"
    >
      <ActionForm action={startImport.bind(null, applicationId)} className="space-y-3">
        {error && <Banner tone="error">{errorMessage(START_ERR, error)}</Banner>}
        <Field
          label="Provider"
          hint="Only a provider that exposes a list API can be read. For your own billing system, that is the external provider's subscriptions endpoint."
        >
          <input
            type="text"
            name="provider"
            defaultValue="external"
            className={inputCls}
            readOnly
          />
        </Field>
        <Field
          label="People Rekey does not know"
          hint="Matching is by email. This decides what happens when an address has no Rekey account."
        >
          <select name="matchStrategy" defaultValue="email" className={inputCls}>
            <option value="email">Skip them, and list them for me</option>
            <option value="email_or_create">Create an unlinked end-user for them</option>
          </select>
        </Field>
        <Banner tone="info">
          An unlinked end-user has no password and an unverified address. They get in through the
          normal recovery paths: magic link, password reset, or OAuth.
        </Banner>
        <SubmitButton pendingLabel="Reading…">Preview the import</SubmitButton>
      </ActionForm>
    </Modal>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
