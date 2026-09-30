/**
 * Copy-paste code for putting this list's form on a site, filled in with the
 * list's key, fields and current consent version.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { getApplication } from '@/lib/api';
import { captureState, listSnippets } from '@/lib/lists';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { CopyButton } from '@/components/CopyButton';
import { getList } from '../shared';

export default async function ListEmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; listId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, listId } = await params;
  const sp = await searchParams;
  const [list, application] = await Promise.all([getList(id, listId), getApplication(id)]);
  const capture = captureState(list.publicCapture, application.corsOrigins ?? []);
  const browserReady = capture === 'browser';
  const snippets = listSnippets(list);
  const settingsHref = `/applications/${id}/lists/${listId}/settings`;

  return (
    <div className="space-y-4">
      {sp.created === '1' && (
        <Banner tone="success">
          List created. The first example works straight away with your secret key; nothing else needs turning on.
        </Banner>
      )}
      {list.archivedAt && (
        <Banner tone="warning">None of these work while the list is archived.</Banner>
      )}
      <Card className="space-y-2 text-sm">
        <p>
          Your code subscribes with the key <code className="font-mono">{list.key}</code>
          {list.lawfulBasis === 'consent' ? (
            <>
              {' '}
              and consent version <strong>{list.consentVersion}</strong>. After you change the consent text, update the
              version in your form, or read it from <code className="font-mono">rekey.lists.get(&apos;{list.key}&apos;)</code>{' '}
              so it follows on its own.
            </>
          ) : (
            '. Its lawful basis needs no consent checkbox.'
          )}
        </p>
        <p className="text-xs text-[var(--color-muted-fg)]">
          {browserReady ? (
            'Public capture is on, so every example below works.'
          ) : (
            <>
              Public capture is off, so the examples marked &ldquo;needs Public capture&rdquo; are refused. The
              others work as they are.{' '}
              <Link href={`${settingsHref}#capture`} className="text-[var(--color-primary)] hover:underline">
                Change in Settings
              </Link>
            </>
          )}
        </p>
      </Card>
      {snippets.map((s, i) => (
        <Card key={s.label} className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {s.label}
                {i === 0 && <Badge tone="brand">Recommended</Badge>}
                {s.needsPublicCapture && (
                  <Badge tone={browserReady ? 'neutral' : 'warning'}>Needs Public capture</Badge>
                )}
              </h3>
              <p className="text-xs text-[var(--color-muted-fg)]">{s.when}</p>
            </div>
            <CopyButton value={s.code} label="Copy" />
          </div>
          <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs">
            <code>{s.code}</code>
          </pre>
        </Card>
      ))}
    </div>
  );
}
