/**
 * Support mode for one Application: who is in it, and the capability catalogue
 * a support case picks from.
 *
 * A case never expires, so this list is the control that keeps one from being
 * forgotten: open cases come oldest first, with their age.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { api, apiGet, errorQuery, getApplication, PanelApiError, readErrorFlash, unlessBusy } from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { ActionForm } from '@/components/ActionForm';
import { Banner } from '@/components/Banner';
import { CapabilityBadges } from '@/components/CapabilityBadges';
import { SectionHeader } from '@/components/Card';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { FilterChips } from '@/components/FilterChips';
import { Modal } from '@/components/Modal';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { SavedBanner } from '@/components/SavedBanner';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDateTime } from '@/lib/date';
import { hasScope } from '@/lib/operator-scopes';
import type { Page } from '@/lib/paginate';
import {
  CAPABILITY_NAME_MAX,
  CAPABILITY_NAME_PATTERN,
  caseAgeLabel,
  caseScopeLabel,
  closedCauseLabel,
  getSupportCapabilities,
  operatorName,
  SUPPORT_ERR,
  type SupportCaseDto,
} from '@/lib/support-mode';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const pageUrl = (id: string): string => `/applications/${id}/support`;
const catalogueApi = (id: string): string =>
  `/api/v1/tenant/applications/${encodeURIComponent(id)}/support-capabilities`;

async function createSupportCapability(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  try {
    await api({
      method: 'POST',
      path: catalogueApi(applicationId),
      body: { name, ...(description ? { description } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId)}?${await errorQuery(err, { newCapability: '1' })}`);
    }
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?capabilityCreated=${encodeURIComponent(name)}`);
}

async function deleteSupportCapability(applicationId: string, name: string): Promise<void> {
  'use server';
  try {
    await api({ method: 'DELETE', path: `${catalogueApi(applicationId)}/${encodeURIComponent(name)}` });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${pageUrl(applicationId)}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?capabilityDeleted=${encodeURIComponent(name)}`);
}

export default async function SupportModePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const str = (k: string): string | undefined => (typeof sp[k] === 'string' ? (sp[k] as string) : undefined);
  const error = str('error');
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const newCapabilityError = sp.newCapability === '1' ? error : undefined;
  const status = str('status') === 'closed' ? 'closed' : 'open';
  const pageSize = readPageSize(sp);
  const offset = readOffset(sp);

  const qs = new URLSearchParams({ status, limit: String(pageSize), offset: String(offset) });
  const [application, cases, catalogue] = await Promise.all([
    getApplication(id),
    apiGet<Page<SupportCaseDto>>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/support-cases?${qs.toString()}`,
      { interruptOnAccessError: false },
    ).catch(unlessBusy(() => null)),
    getSupportCapabilities(id),
  ]);
  const canWrite = hasScope(application.access.scopes, 'end-users:write');
  const showingClosed = status === 'closed';

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHeader
          title={showingClosed ? 'Closed support cases' : 'Accounts in support mode'}
          count={cases ? `(${cases.page.total})` : undefined}
          description="A support case turns on capabilities for one end-user until an operator ends it. Cases never expire, so open ones are listed oldest first; closed ones are listed most recently opened first. Open or change a case from the end-user's Support mode tab."
        />
        <FilterChips
          label="Filter support cases by status"
          chips={[
            { value: undefined, label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
          active={showingClosed ? 'closed' : undefined}
          hrefFor={(value) => (value ? `${pageUrl(id)}?status=${value}` : pageUrl(id))}
        />

        {cases === null ? (
          <Banner tone="error">
            The support cases could not be read. Either the request failed, or your access to this
            Application does not cover it. This does <strong>not</strong> mean no account is in
            support mode. Reload; if it persists, check the API and your access.
          </Banner>
        ) : cases.items.length === 0 ? (
          <EmptyState
            title={showingClosed ? 'No closed cases' : 'No account is in support mode'}
            description={
              showingClosed
                ? 'A case appears here once it is ended, the end-user is banned, erased or deleted, or its last device is released or blocked.'
                : "Open a case from an end-user's Support mode tab. It shows here until someone ends it."
            }
          />
        ) : (
          <Table minWidth="min-w-[56rem]">
            <THead>
              <TR>
                <TH>End-user</TH>
                <TH>Capabilities</TH>
                <TH>Applies to</TH>
                <TH>Opened by</TH>
                <TH>Reason</TH>
                <TH>{showingClosed ? 'Closed' : 'Open for'}</TH>
              </TR>
            </THead>
            <TBody>
              {cases.items.map((c) => (
                <TR key={c.id} hover>
                  <TD>
                    <Link
                      href={`/applications/${id}/end-users/${c.endUserId}/support-mode`}
                      className="text-sm text-[var(--color-fg)] hover:underline"
                    >
                      {c.endUserEmail ?? 'erased or deleted end-user'}
                    </Link>
                  </TD>
                  <TD>
                    <CapabilityBadges names={c.capabilities} />
                  </TD>
                  <TD className="whitespace-nowrap text-xs">{caseScopeLabel(c)}</TD>
                  <TD className="text-xs">{operatorName(c.openedByEmail, c.openedBy)}</TD>
                  <TD className="max-w-[20rem] whitespace-pre-wrap break-words text-sm">
                    {c.reason ?? <span className="text-[var(--color-muted-fg)]">none recorded</span>}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {showingClosed ? (
                      <>
                        {c.closedAt ? formatDateTime(c.closedAt) : 'unknown'}, {closedCauseLabel(c.closedCause)}
                      </>
                    ) : (
                      <span title={`Opened ${formatDateTime(c.openedAt)}`}>{caseAgeLabel(c.openedAt)}</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {cases && (
          <Pager
            basePath={pageUrl(id)}
            offset={offset}
            pageSize={pageSize}
            count={cases.items.length}
            hasMore={cases.page.hasMore}
            extraParams={showingClosed ? { status: 'closed' } : undefined}
          />
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Capabilities"
          count={catalogue ? `(${catalogue.length})` : undefined}
          description={
            <>
              The names a support case can turn on. Your app reads them from{' '}
              <code className="font-mono text-xs">/auth/me?include=support</code> and decides what
              each one does; Rekey stores and reports them and enforces none. A name is a contract
              with your app, so it cannot be renamed.
            </>
          }
          action={
            canWrite && catalogue !== null ? (
              <NewCapabilityModal
                applicationId={id}
                error={newCapabilityError}
                errorDetail={errorDetail}
                errorFix={errorFix}
              />
            ) : undefined
          }
        />

        {str('capabilityCreated') && (
          <SavedBanner
            params={['capabilityCreated']}
            message={`Capability ${str('capabilityCreated')} added.`}
          />
        )}
        {str('capabilityDeleted') && (
          <SavedBanner
            params={['capabilityDeleted']}
            message={`Capability ${str('capabilityDeleted')} deleted.`}
          />
        )}
        {error && !newCapabilityError && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={SUPPORT_ERR} />
          </Banner>
        )}

        {catalogue === null ? (
          <Banner tone="error">
            The capability catalogue could not be read. This does <strong>not</strong> mean it is
            empty. Reload; if it persists, check the API and your access.
          </Banner>
        ) : catalogue.length === 0 ? (
          <EmptyState
            title="No capabilities yet"
            description={
              <>
                Add the names your app understands, such as{' '}
                <code className="font-mono text-xs">diagnostics.debug</code>. A support case cannot
                be opened until there is at least one.
              </>
            }
          />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Description</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {catalogue.map((c) => (
                <TR key={c.id} hover>
                  <TD mono>{c.name}</TD>
                  <TD muted className="text-xs">
                    {c.description ?? 'none'}
                  </TD>
                  <TD align="right">
                    {canWrite && (
                      <ActionForm action={deleteSupportCapability.bind(null, id, c.name)} className="inline">
                        <ConfirmButton
                          title={`Delete ${c.name}?`}
                          confirm="Support cases can no longer turn it on. The delete is refused while an open case uses it. Closed cases keep the name in their history."
                          confirmLabel="Delete capability"
                        >
                          Delete
                        </ConfirmButton>
                      </ActionForm>
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

function NewCapabilityModal({
  applicationId,
  error,
  errorDetail,
  errorFix,
}: {
  applicationId: string;
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="newCapability"
      title="Add a capability"
      description="A name a support case can turn on for an end-user. Your app decides what it does."
      trigger="+ New capability"
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
    >
      <ActionForm action={createSupportCapability.bind(null, applicationId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={SUPPORT_ERR} />
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">
            Name<span className="ml-0.5 text-[var(--color-primary)]">*</span>
          </span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            maxLength={CAPABILITY_NAME_MAX}
            pattern={CAPABILITY_NAME_PATTERN}
            placeholder="diagnostics.debug"
            className={`${inputCls} font-mono`}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Lowercase letters and digits, separated by single dots, hyphens or underscores. Up to{' '}
            {CAPABILITY_NAME_MAX} characters. It cannot be renamed later.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Description (optional)</span>
          <input
            type="text"
            name="description"
            maxLength={240}
            placeholder="Lets the customer export full debug output"
            className={inputCls}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Shown to operators when they open a case.
          </span>
        </label>
        <SubmitButton pendingLabel="Adding…">Add capability</SubmitButton>
      </ActionForm>
    </Modal>
  );
}
