/**
 * List detail shell: the list's identity, the state that decides whether a
 * form can write to it, archive and restore, and its tabs. Members,
 * Submissions, Settings and Embed are real routes so a link can point at one.
 */

import * as React from 'react';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { RecordHeader } from '@/components/RecordHeader';
import { getApplication } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { KIND_LABEL } from '@/lib/lists';
import { getList } from './shared';
import { ListStatusSummary } from './status-summary';
import { ArchiveListButton } from './archive-button';

export default async function ListLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string; listId: string }>;
}): Promise<React.JSX.Element> {
  const { id, listId } = await params;
  const [list, application] = await Promise.all([getList(id, listId), getApplication(id)]);
  const base = `/applications/${id}/lists/${listId}`;
  const canWrite = hasScope(application.access?.scopes ?? null, 'audience:write');

  return (
    <div className="space-y-5">
      <RecordHeader
        crumbs={[{ label: 'Lists', href: `/applications/${id}/lists` }, { label: list.name }]}
        title={
          <>
            <span className="min-w-0 truncate">{list.name}</span>
            <Badge tone="neutral">{KIND_LABEL[list.kind]}</Badge>
          </>
        }
        meta={
          <>
            <span className="font-mono">{list.key}</span>
            {list.description && <span> · {list.description}</span>}
          </>
        }
        action={
          canWrite ? (
            <ArchiveListButton applicationId={id} listId={listId} name={list.name} archived={list.archivedAt !== null} />
          ) : undefined
        }
        summary={<ListStatusSummary list={list} allowedOrigins={application.corsOrigins ?? []} settingsHref={`${base}/settings`} />}
        segmentsLabel="List sections"
        segments={[
          { href: base, label: `Members (${list.counts.subscribed})`, exact: true },
          { href: `${base}/submissions`, label: `Submissions (${list.counts.submissions})` },
          { href: `${base}/settings`, label: 'Settings' },
          { href: `${base}/embed`, label: 'Embed' },
        ]}
      />
      {list.archivedAt && (
        <Banner tone="warning">
          This list is archived, so every form that writes to it is refused. Its members and submissions are kept.
          Restore it with the button above.
        </Banner>
      )}
      <div>{children}</div>
    </div>
  );
}
