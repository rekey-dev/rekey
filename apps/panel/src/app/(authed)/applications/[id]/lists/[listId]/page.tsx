/**
 * Members of one list: who joined, how, and the consent proof. An operator
 * can take someone off but never add them back; only the person can, through
 * the Application's own server.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import type { ContactListMemberRowDto } from '@rekey.dev/shared-types';
import { api, apiGet, errorQuery, getApplication, readErrorFlash, unlessBusy, PanelApiError } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { formatDateTime } from '@/lib/date';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { ActionForm } from '@/components/ActionForm';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FilterChips } from '@/components/FilterChips';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { ApiErrorText } from '@/components/api-error';
import { fieldInputCls } from '@/components/Field';
import { getList } from './shared';

const SOURCE_LABEL: Record<string, string> = {
  publishable: 'Browser',
  secret: 'Your server',
  operator: 'Operator',
};

const ERR: Record<string, string> = {
  LIST_MEMBER_NOT_FOUND: 'That member is no longer on this list.',
  CONTACT_LIST_QUOTA_EXCEEDED: 'This workspace is at its list limit, so this list cannot be restored. Archive another list first.',
  SCOPE_INSUFFICIENT: 'Your access does not let you change lists.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
};

async function unsubscribeMember(applicationId: string, listId: string, memberId: string): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/lists/${listId}`;
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}/unsubscribe`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${base}?unsubscribed=1`);
}

export default async function ListMembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; listId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, listId } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail, fix } = await readErrorFlash(error);
  const status = sp.status === 'subscribed' || sp.status === 'unsubscribed' ? sp.status : undefined;
  const search = typeof sp.search === 'string' ? sp.search.trim() : '';
  const pageSize = readPageSize(sp);
  const offset = readOffset(sp);

  const qs = new URLSearchParams({ limit: String(pageSize) });
  if (offset) qs.set('offset', String(offset));
  if (status) qs.set('status', status);
  if (search) qs.set('search', search);

  const [list, application, page] = await Promise.all([
    getList(id, listId),
    getApplication(id),
    apiGet<Page<ContactListMemberRowDto>>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/lists/${encodeURIComponent(listId)}/members?${qs.toString()}`,
      { interruptOnAccessError: false },
    ).catch(unlessBusy(() => null)),
  ]);
  const base = `/applications/${id}/lists/${listId}`;
  const canExport = application.access?.level === 'workspace-admin';
  const filterParams: Record<string, string> = {
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
  };
  const hrefFor = (value: string | undefined): string => {
    const p = new URLSearchParams({ ...(search ? { search } : {}), ...(value ? { status: value } : {}) });
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <div className="space-y-4">
      {sp.unsubscribed === '1' && <Banner tone="success">Taken off the list.</Banner>}
      {sp.done === 'archived' && <Banner tone="success">List archived. Restore it any time from the header.</Banner>}
      {sp.done === 'restored' && <Banner tone="success">List restored. Forms can subscribe people again.</Banner>}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterChips
          label="Filter members by status"
          active={status}
          hrefFor={hrefFor}
          chips={[
            { value: undefined, label: 'All' },
            { value: 'subscribed', label: 'Subscribed', count: list.counts.subscribed },
            { value: 'unsubscribed', label: 'Unsubscribed', count: list.counts.unsubscribed },
          ]}
        />
        <div className="flex items-center gap-2">
          <form method="get" className="flex items-center gap-2">
            {status && <input type="hidden" name="status" value={status} />}
            <input
              name="search"
              defaultValue={search}
              placeholder="Search email or name"
              aria-label="Search members"
              className={`${fieldInputCls} w-56 text-[var(--color-fg)]`}
            />
          </form>
          {canExport && (
            <a
              href={`${base}/export`}
              className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-muted)]"
            >
              Export CSV
            </a>
          )}
        </div>
      </div>

      {page === null ? (
        <Banner tone="error">
          The members could not be read. This is <strong>not</strong> an empty list.
        </Banner>
      ) : page.items.length === 0 ? (
        <EmptyState
          variant="inline"
          title={search || status ? 'No members match' : 'Nobody has joined yet'}
          description={
            search || status
              ? 'Clear the search or the filter to see everyone.'
              : 'Put a form on your site and people who join appear here, with what they agreed to.'
          }
          action={
            search || status ? undefined : (
              <Link
                href={`${base}/embed`}
                className="inline-flex rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)]"
              >
                Get the form code
              </Link>
            )
          }
        />
      ) : (
        <Table minWidth="min-w-[52rem]">
          <THead>
            <TR>
              <TH>Person</TH>
              <TH>Status</TH>
              <TH>Joined through</TH>
              <TH>Consent</TH>
              <TH>Joined</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((m) => (
              <TR key={m.memberId} hover>
                <TD>
                  <div className="font-medium">{m.email}</div>
                  {m.name && <div className="text-xs text-[var(--color-muted-fg)]">{m.name}</div>}
                  {m.endUserId && (
                    <Link
                      href={`/applications/${id}/end-users/${encodeURIComponent(m.endUserId)}`}
                      className="text-[11px] text-[var(--color-primary)] hover:underline"
                    >
                      Also an end user
                    </Link>
                  )}
                </TD>
                <TD>
                  {m.status === 'subscribed' ? (
                    <Badge tone="success">Subscribed</Badge>
                  ) : (
                    <Badge tone="neutral" title={m.unsubscribedAt ? `Left ${formatDateTime(m.unsubscribedAt)}` : undefined}>
                      Unsubscribed
                    </Badge>
                  )}
                </TD>
                <TD muted>
                  {SOURCE_LABEL[m.source] ?? m.source}
                  {m.sourceUrl && <div className="max-w-[16rem] truncate text-[11px]" title={m.sourceUrl}>{m.sourceUrl}</div>}
                </TD>
                <TD muted className="text-xs">
                  {m.consentVersion !== null ? (
                    <>
                      <div>Version {m.consentVersion}</div>
                      {m.consentAt && <div>{formatDateTime(m.consentAt)}</div>}
                      {m.consentIpPrefix && <div className="font-mono text-[11px]">{m.consentIpPrefix}</div>}
                    </>
                  ) : (
                    'Not recorded'
                  )}
                </TD>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(m.subscribedAt)}
                </TD>
                <TD align="right">
                  {m.status === 'subscribed' && (
                    <ActionForm action={unsubscribeMember.bind(null, id, listId, m.memberId)} className="inline">
                      <ConfirmButton
                        title={`Take ${m.email} off this list?`}
                        confirm="They stop being a member and your webhook gets contact.unsubscribed. Only they can join again, through your site."
                        confirmLabel="Take off the list"
                      >
                        Unsubscribe
                      </ConfirmButton>
                    </ActionForm>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {page && (
        <Pager
          basePath={base}
          offset={offset}
          pageSize={pageSize}
          count={page.items.length}
          hasMore={page.page.hasMore}
          extraParams={Object.keys(filterParams).length > 0 ? filterParams : undefined}
        />
      )}
    </div>
  );
}
