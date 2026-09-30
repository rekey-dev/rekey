/**
 * What people typed into this list's form, newest first. Rendered as text:
 * React escapes every value, so a submission can never become markup here.
 */

import * as React from 'react';
import type { ContactSubmissionRowDto } from '@rekey.dev/shared-types';
import { apiGet, unlessBusy } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { formatDateTime } from '@/lib/date';
import { Card } from '@/components/Card';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { getList } from '../shared';

export default async function ListSubmissionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; listId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, listId } = await params;
  const sp = await searchParams;
  const pageSize = readPageSize(sp);
  const offset = readOffset(sp);
  const qs = new URLSearchParams({ limit: String(pageSize), ...(offset ? { offset: String(offset) } : {}) });
  const [list, page] = await Promise.all([
    getList(id, listId),
    apiGet<Page<ContactSubmissionRowDto>>(
      `/api/v1/tenant/applications/${encodeURIComponent(id)}/lists/${encodeURIComponent(listId)}/submissions?${qs.toString()}`,
      { interruptOnAccessError: false },
    ).catch(unlessBusy(() => null)),
  ]);
  const labels = new Map(list.fieldSchema.map((f) => [f.name, f.label]));

  return (
    <div className="space-y-4">
      <p className="text-xs text-[var(--color-muted-fg)]">
        {list.submissionRetentionDays
          ? `Submissions are deleted ${list.submissionRetentionDays} days after they arrive.`
          : 'Submissions are kept until the person is erased. Set a retention period in Settings to delete them sooner.'}
      </p>
      {page === null ? (
        <Banner tone="error">
          The submissions could not be read. This is <strong>not</strong> an empty list.
        </Banner>
      ) : page.items.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No submissions"
          description={
            list.fieldSchema.length === 0
              ? 'This list has no extra fields, so subscribes store no submission. Add fields in Settings to collect a message or other details.'
              : 'A submission is stored each time a subscribe carries values for this list’s fields.'
          }
        />
      ) : (
        <div className="space-y-3">
          {page.items.map((s) => (
            <Card key={s.id} className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{s.email}</span>
                <span className="text-xs text-[var(--color-muted-fg)]">{formatDateTime(s.createdAt)}</span>
              </div>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
                {Object.entries(s.fields).map(([name, value]) => (
                  <React.Fragment key={name}>
                    <dt className="text-xs text-[var(--color-muted-fg)]">{labels.get(name) ?? name}</dt>
                    <dd className="whitespace-pre-wrap break-words">{String(value)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </Card>
          ))}
        </div>
      )}
      {page && (
        <Pager
          basePath={`/applications/${id}/lists/${listId}/submissions`}
          offset={offset}
          pageSize={pageSize}
          count={page.items.length}
          hasMore={page.page.hasMore}
        />
      )}
    </div>
  );
}
