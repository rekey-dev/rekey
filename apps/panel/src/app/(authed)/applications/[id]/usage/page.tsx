import * as React from 'react';
import { redirect } from 'next/navigation';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { Modal } from '@/components/Modal';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { SavedBanner } from '@/components/SavedBanner';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

interface MeterRow {
  id: string;
  slug: string;
  name: string;
  unit: string;
  active: boolean;
  createdAt: string;
}

async function createMeter(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const slug = String(formData.get('slug') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const unit = String(formData.get('unit') ?? '').trim();
  if (!slug || !name || !unit) {
    redirect(`/applications/${applicationId}/usage?error=missing&newMeter=1`);
  }
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/usage-meters`,
      body: { slug, name, unit },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/usage?error=${encodeURIComponent(err.code)}&newMeter=1`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/usage?created=${slug}`);
}

async function setMeterActive(
  applicationId: string,
  slug: string,
  active: boolean,
): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/usage-meters/${encodeURIComponent(slug)}`,
    body: { active },
  });
  redirect(`/applications/${applicationId}/usage`);
}

async function deleteMeter(applicationId: string, slug: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/usage-meters/${encodeURIComponent(slug)}`,
  });
  redirect(`/applications/${applicationId}/usage`);
}

const ERR: Record<string, string> = {
  missing: 'Slug, name, and unit are all required.',
  USAGE_METER_SLUG_TAKEN: 'A meter with that slug already exists in this application.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can add meters.',
};

export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const created = typeof sp.created === 'string' ? sp.created : undefined;

  // Billing master switch off → point at the switch instead of an empty table.
  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Usage meters"
          description="Usage meters define what you charge for — create a meter, then reference it in a usage-based plan."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const meters = await api<MeterRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/usage-meters`,
  });

  return (
    <div className="space-y-5">
      {created && <SavedBanner params={['created']} message={`Meter ${created} created.`} />}

      <SectionHeader
        title="Usage meters"
        count={`(${meters.length})`}
        description={
          <>
            What you charge for. Create a meter, then reference it in a usage-based plan. Your
            backend records consumption via{' '}
            <code className="font-mono text-xs">POST /api/v1/usage/record</code>.
          </>
        }
        action={
          <Modal
            modalKey="newMeter"
            title="Add a usage meter"
            description="Slug is the stable identifier your code reports against. Unit is a free-form label (calls, MB, minutes) — shown back to operators in dashboards but not enforced."
            trigger="+ New meter"
          >
            <form action={createMeter.bind(null, id)} className="space-y-3">
              {error && (
                <Banner tone="error">
                  {ERR[error] ?? error}
                </Banner>
              )}
              <Field label="Slug" hint="URL-safe identifier — what your SDK calls report against.">
                <input
                  type="text" name="slug" required autoFocus placeholder="api_calls"
                  pattern="^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$"
                  className={`${inputCls} font-mono`}
                />
              </Field>
              <Field label="Name" hint="Human label — shown in operator dashboards.">
                <input type="text" name="name" required placeholder="API calls" className={inputCls} />
              </Field>
              <Field label="Unit" hint="Free-form: calls, MB, seats, minutes — anything that reads naturally.">
                <input type="text" name="unit" required placeholder="calls" className={inputCls} />
              </Field>
              <SubmitButton pendingLabel="Adding meter…">Add meter</SubmitButton>
            </form>
          </Modal>
        }
      />

      {meters.length === 0 ? (
        <EmptyState
          title="No meters yet"
          description={
            <>
              Define a meter like “API calls” or “storage (GB)” before building a usage-based plan.
              Your backend reports consumption via{' '}
              <code className="font-mono">POST /api/v1/usage/record</code> with the meter slug + a
              quantity.
            </>
          }
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Slug</TH>
              <TH>Name</TH>
              <TH>Unit</TH>
              <TH>Status</TH>
              <TH>Created</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {meters.map((m) => (
              <TR key={m.id} hover>
                <TD>
                  <Badge tone="neutral" mono>{m.slug}</Badge>
                </TD>
                <TD className="font-medium">{m.name}</TD>
                <TD muted className="text-xs">{m.unit}</TD>
                <TD>
                  {m.active ? (
                    <Badge tone="success" dot>active</Badge>
                  ) : (
                    <Badge tone="neutral" dot>inactive</Badge>
                  )}
                </TD>
                <TD muted className="text-xs">
                  {formatDate(m.createdAt)}
                </TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-3">
                    <form action={setMeterActive.bind(null, id, m.slug, !m.active)} className="inline">
                      <SubmitButton
                        pendingLabel={m.active ? 'Disabling…' : 'Enabling…'}
                        className="rounded text-xs font-medium text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)] disabled:opacity-60"
                      >
                        {m.active ? 'Disable' : 'Enable'}
                      </SubmitButton>
                    </form>
                    <form action={deleteMeter.bind(null, id, m.slug)} className="inline">
                      <ConfirmButton
                        confirm={`Delete meter "${m.slug}"? All recorded usage events for this meter will be deleted too. To preserve history, Disable instead.`}
                      >
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

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
