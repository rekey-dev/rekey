/**
 * The import preview, the screen the whole feature exists for.
 *
 * An import is a bulk write against somebody else's data, matching strangers to
 * local accounts by email. A one-click version of that is a mistake nobody can
 * take back, so the run stops here and shows its working: what would happen to
 * every row, and for every refusal, why.
 *
 * The refusals are the important half. A preview that says "412 rows, 30
 * importable" and nothing else is a black box an operator has to trust; the
 * counts below are therefore all clickable, and every skipped row carries its
 * reason.
 */

import * as React from 'react';
import { errorMessage } from '@/lib/error-message';
import { ActionForm } from '@/components/ActionForm';
import { FilterChips } from '@/components/FilterChips';
import { RecordHeader } from '@/components/RecordHeader';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { api, apiGet, getApplication, PanelApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import { Card } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';

interface ImportItem {
  id: string;
  externalId: string;
  email: string | null;
  planRef: string | null;
  outcome: string;
  endUserId: string | null;
  planSlug: string | null;
  subscriptionId: string | null;
  detail: { reason?: string; hint?: string };
}

interface RunDetail {
  run: {
    id: string;
    provider: string;
    mode: string;
    status: string;
    matchStrategy: string;
    counts: Record<string, number>;
    error: string | null;
    createdAt: string;
    completedAt: string | null;
    /** `applying` with no heartbeat for five minutes: the apply was interrupted. */
    stale: boolean;
  };
  items: { items: ImportItem[]; page: { total: number; hasMore: boolean } };
}

/** Outcome → how it reads, and whether it is going to happen. */
const OUTCOME: Record<string, { label: string; tone: BadgeTone; willImport: boolean }> = {
  match: { label: 'existing user', tone: 'success', willImport: true },
  create: { label: 'new user', tone: 'info', willImport: true },
  skip_no_plan: { label: 'no plan mapped', tone: 'warning', willImport: false },
  skip_active: { label: 'already subscribed', tone: 'neutral', willImport: false },
  skip_invalid: { label: 'cannot import', tone: 'neutral', willImport: false },
  error: { label: 'failed', tone: 'danger', willImport: false },
};

const ORDER = ['match', 'create', 'skip_no_plan', 'skip_active', 'skip_invalid', 'error'];

const APPLY_ERR: Record<string, string> = {
  IMPORT_CONFIRM_MISMATCH: 'The confirmation did not match the application slug.',
  IMPORT_RUN_NOT_READY:
    'This run cannot be applied. It has already been applied, it is being applied right now, or it did not finish.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can apply an import.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow billing writes.',
};

async function applyImport(
  applicationId: string,
  runId: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/imports/${runId}`;
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/subscription-imports/${encodeURIComponent(runId)}/apply`,
      body: { confirm: String(formData.get('confirm') ?? '') },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${base}?applyError=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`${base}?applied=1`);
}

export default async function ImportRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, runId } = await params;
  const sp = await searchParams;
  const outcome = typeof sp.outcome === 'string' ? sp.outcome : undefined;
  const applyError = typeof sp.applyError === 'string' ? sp.applyError : undefined;
  const applied = sp.applied === '1';

  const q = new URLSearchParams({ limit: '100' });
  if (outcome) q.set('outcome', outcome);

  const [application, detail] = await Promise.all([
    getApplication(id),
    apiGet<RunDetail>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/subscription-imports/${encodeURIComponent(runId)}?${q.toString()}`,
      { interruptOnAccessError: false },
    ).catch(() => null),
  ]);

  if (detail === null) {
    return <Banner tone="error">That import run could not be read.</Banner>;
  }

  const { run, items } = detail;
  const counts = run.counts ?? {};
  const willImport = (counts.match ?? 0) + (counts.create ?? 0);
  const base = `/applications/${id}/imports/${runId}`;

  return (
    <div className="space-y-5">
      {/* Breadcrumb, not a right-aligned "All runs" link, matching the other
          detail pages, and the only way out of a page four levels deep. */}
      <RecordHeader
        crumbs={[
          { label: 'Imports', href: `/applications/${id}/imports` },
          { label: 'Preview' },
        ]}
        title="Import preview"
        description={
          <>
            Read from <strong>{run.provider}</strong> {formatDateTime(run.createdAt)}.{' '}
            {run.matchStrategy === 'email_or_create'
              ? 'Unknown addresses will be created as unlinked end-users.'
              : 'Unknown addresses are skipped.'}
          </>
        }
      />

      {applied && (
        <Banner tone="success">
          Import applied. Entitlements are live and{' '}
          <code className="font-mono">subscription.activated</code> was announced for every imported
          row.
        </Banner>
      )}
      {applyError && <Banner tone="error">{errorMessage(APPLY_ERR, applyError)}</Banner>}
      {run.status === 'failed' && (
        <Banner tone="error">
          This run failed before it finished reading: {run.error ?? 'no reason recorded'}. Nothing
          was written.
        </Banner>
      )}

      {run.stale && (
        <Banner tone="warning">
          This apply was interrupted before it finished, most likely by a restart. Rows that already
          landed are kept. Resume it below to import the rest; nothing is imported twice.
        </Banner>
      )}
      {run.status === 'applying' && !run.stale && (
        <Banner tone="info">
          This import is being applied right now. Reload to see it finish.
        </Banner>
      )}

      {/* The counts are the summary AND the filter, an operator who wants to
          know what the 382 skipped rows were should not have to scroll. */}
      <FilterChips
        chips={[
          { value: undefined, label: 'All', count: counts.total ?? 0 },
          ...ORDER.filter((o) => (counts[o] ?? 0) > 0).map((o) => ({
            value: o,
            label: OUTCOME[o]!.label,
            count: counts[o] ?? 0,
          })),
        ]}
        active={outcome}
        hrefFor={(v) => (v ? `${base}?outcome=${v}` : base)}
        label="Filter preview rows by outcome"
      />

      {(run.status === 'ready' || run.stale) && (
        <Card className="space-y-3 border-amber-300 dark:border-amber-800">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">
              {run.stale ? 'Resume this import' : 'Apply this import'}
            </h3>
            <p className="max-w-2xl text-xs text-[var(--color-muted-fg)]">
              This writes <strong>{willImport}</strong> subscription{willImport === 1 ? '' : 's'} for
              real customers, materialises the plan entitlements onto them, and announces{' '}
              <code className="font-mono">subscription.activated</code> for each one to your webhook
              endpoints, so anything downstream that provisions on a sale will run{' '}
              {willImport === 1 ? 'once' : `${willImport} times`}. Rows that are skipped above stay
              skipped. It cannot be undone from here.
            </p>
          </div>
          {willImport === 0 ? (
            <p className="text-xs text-[var(--color-muted-fg)]">
              Nothing in this run would be imported. Fix the plan mapping, or re-run allowing
              unlinked users to be created, then preview again.
            </p>
          ) : (
            <ActionForm action={applyImport.bind(null, id, runId)}>
              <TypedConfirmButton
                expected={application.slug}
                title={`Import ${willImport} subscription${willImport === 1 ? '' : 's'}?`}
                description={`This writes real entitlement for real customers and announces a sale for each one. Type the application slug to confirm.`}
                triggerLabel={run.stale ? 'Resume import' : `Apply and import ${willImport}`}
                confirmLabel="Import them"
                triggerClassName="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-amber-400 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950"
              />
            </ActionForm>
          )}
        </Card>
      )}

      {run.status === 'applied' && (
        <Banner tone="info">
          Applied {run.completedAt ? formatDateTime(run.completedAt) : ''}:{' '}
          {counts.imported ?? 0} imported, {counts.failed ?? 0} failed. The rows are kept so this
          stays auditable.
        </Banner>
      )}

      {items.items.length === 0 ? (
        <EmptyState variant="inline" title="Nothing in this view" />
      ) : (
        <Table minWidth="min-w-[52rem]">
          <THead>
            <TR>
              <TH>Customer</TH>
              <TH>Outcome</TH>
              <TH>Plan</TH>
              <TH>Why</TH>
              <TH>Provider id</TH>
            </TR>
          </THead>
          <TBody>
            {items.items.map((i) => {
              const o = OUTCOME[i.outcome] ?? {
                label: i.outcome,
                tone: 'neutral' as BadgeTone,
                willImport: false,
              };
              return (
                <TR key={i.id} hover>
                  <TD>
                    {i.endUserId ? (
                      <Link
                        href={`/applications/${id}/end-users/${i.endUserId}`}
                        className="underline underline-offset-2"
                      >
                        {i.email ?? i.endUserId}
                      </Link>
                    ) : (
                      (i.email ?? <span className="text-[var(--color-muted-fg)]">no email</span>)
                    )}
                  </TD>
                  <TD>
                    <Badge tone={o.tone} dot={o.willImport}>
                      {o.label}
                    </Badge>
                  </TD>
                  <TD muted className="text-xs">
                    {i.planSlug ?? i.planRef ?? '—'}
                    {i.planSlug && i.planRef && i.planSlug !== i.planRef && (
                      <span className="block text-[11px]">from {i.planRef}</span>
                    )}
                  </TD>
                  <TD muted className="max-w-[20rem] text-xs">
                    {i.detail.reason ?? '—'}
                    {i.detail.hint && (
                      <span className="block text-[11px] opacity-80">{i.detail.hint}</span>
                    )}
                  </TD>
                  <TD mono muted className="max-w-[10rem] truncate text-[11px]">
                    {i.externalId}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {items.page.hasMore && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          Showing the first {items.items.length} of {items.page.total}. Filter by outcome above to
          narrow it.
        </p>
      )}
    </div>
  );
}

