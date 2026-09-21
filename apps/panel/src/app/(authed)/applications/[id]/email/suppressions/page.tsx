/**
 * Addresses this Application must not email.
 *
 * The narrowest of the three gates and the only one about a person rather than
 * about configuration: a bounce, a spam complaint, an unsubscribe, or somebody
 * who asked to be left alone. It outranks everything, including a password
 * reset, an address that hard-bounced cannot receive one anyway, and mailing a
 * complainant again is how a sending domain gets blocked.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { errorMessage } from '@/lib/error-message';
import { api, apiGet, PanelApiError } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { formatDateTime } from '@/lib/date';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Field } from '@/components/Field';

interface SuppressionRow {
  id: string;
  address: string;
  reason: 'manual' | 'bounce' | 'complaint' | 'unsubscribe';
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

const REASON_TONE: Record<SuppressionRow['reason'], BadgeTone> = {
  bounce: 'danger',
  complaint: 'danger',
  unsubscribe: 'warning',
  manual: 'neutral',
};

async function addSuppression(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const address = String(formData.get('address') ?? '').trim();
  const reason = String(formData.get('reason') ?? 'manual');
  const note = String(formData.get('note') ?? '').trim();
  const base = `/applications/${applicationId}/email/suppressions`;
  if (!address) redirect(`${base}?err=ADDRESS_REQUIRED`);
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-suppressions`,
      body: { address, reason, ...(note ? { note } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?err=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect(`${base}?added=1`);
}

async function removeSuppression(applicationId: string, address: string): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/email/suppressions`;
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-suppressions/${encodeURIComponent(address)}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?err=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect(`${base}?removed=1`);
}

const ERR: Record<string, string> = {
  ADDRESS_REQUIRED: 'Enter an email address.',
  VALIDATION_ERROR: 'That does not look like an email address.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change email settings on this Application.',
};

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';

export default async function EmailSuppressionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const err = typeof sp.err === 'string' ? sp.err : undefined;

  const page = await apiGet<Page<SuppressionRow>>(
    `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-suppressions?limit=100`,
    { interruptOnAccessError: false },
  ).catch(() => null);

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Suppressions"
        count={page ? `(${page.page.total})` : undefined}
        description="Addresses this Application will not email, whatever it is trying to send. This outranks every other setting, including a password reset."
      />

      {sp.added === '1' && <Banner tone="success">Address suppressed.</Banner>}
      {sp.removed === '1' && <Banner tone="success">Address removed; email resumes to it.</Banner>}
      {err && <Banner tone="error">{errorMessage(ERR, err)}</Banner>}

      <Card className="space-y-3">
        <ActionForm action={addSuppression.bind(null, id)} className="grid items-end gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]">
          <Field label="Address" required>
            <input type="email" name="address" required maxLength={254} className={inputCls} />
          </Field>
          <Field label="Reason">
            <select name="reason" defaultValue="manual" className={inputCls}>
              <option value="manual">Manual</option>
              <option value="bounce">Bounce</option>
              <option value="complaint">Complaint</option>
              <option value="unsubscribe">Unsubscribe</option>
            </select>
          </Field>
          <Field label="Note" hint="Optional.">
            <input type="text" name="note" maxLength={500} className={inputCls} />
          </Field>
          <SubmitButton pendingLabel="Adding…">Suppress</SubmitButton>
        </ActionForm>
        <p className="text-[11px] text-[var(--color-muted-fg)]">
          Rekey does not add these itself yet. No provider bounce webhooks are consumed, so every
          row here was added by a person. The reason is carried so that when Rekey does start
          recording bounces, a bounce and a manual entry stay distinguishable.
        </p>
      </Card>

      {page === null ? (
        <Banner tone="error">
          The suppression list could not be read. Either the request failed, or your access to this
          Application does not cover it. This is <strong>not</strong> an empty list.
        </Banner>
      ) : page.items.length === 0 ? (
        <EmptyState
          variant="inline"
          title="Nothing suppressed"
          description="Every address this Application knows about can receive email."
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Address</TH>
              <TH>Reason</TH>
              <TH>Note</TH>
              <TH>Added</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((s) => (
              <TR key={s.id} hover>
                <TD mono>{s.address}</TD>
                <TD>
                  <Badge tone={REASON_TONE[s.reason]}>{s.reason}</Badge>
                </TD>
                <TD muted className="max-w-[16rem] truncate text-xs">
                  {s.note ?? '—'}
                </TD>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(s.createdAt)}
                </TD>
                <TD align="right">
                  <ActionForm action={removeSuppression.bind(null, id, s.address)}>
                    <ConfirmButton
                      variant="subtle"
                      title="Start emailing this address again?"
                      confirm="Removing a suppression resumes email to this address. If it was added because of a hard bounce or a spam complaint, sending again risks your domain's reputation."
                      confirmLabel="Remove"
                    >
                      Remove
                    </ConfirmButton>
                  </ActionForm>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </div>
  );
}
