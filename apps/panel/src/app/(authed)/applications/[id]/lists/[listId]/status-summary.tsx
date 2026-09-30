import * as React from 'react';
import Link from '@/components/Link';
import { Badge } from '@/components/Badge';
import { formatDate } from '@/lib/date';
import { captureState, consentSummary, retentionSummary } from '@/lib/lists';
import type { ListDetail } from './shared';

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The four things that decide whether a form on a site can write to this list. */
export function ListStatusSummary({
  list,
  allowedOrigins,
  settingsHref,
}: {
  list: ListDetail;
  allowedOrigins: readonly string[];
  settingsHref: string;
}): React.JSX.Element {
  const capture = captureState(list.publicCapture, allowedOrigins);
  const [firstSite, ...otherSites] = allowedOrigins.map(hostOf);
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Fact term="Status">
        {list.archivedAt ? (
          <>
            <Badge tone="warning" dot>
              Archived
            </Badge>
            <Detail>Since {formatDate(list.archivedAt)}. Every subscribe is refused.</Detail>
          </>
        ) : (
          <>
            <Badge tone="success" dot>
              Active
            </Badge>
            <Detail>Accepting subscribes.</Detail>
          </>
        )}
      </Fact>
      <Fact term="Public capture" href={`${settingsHref}#capture`}>
        {capture === 'server-only' && (
          <>
            <Badge tone="neutral">Off</Badge>
            <Detail>Only your server, with a secret key, can subscribe.</Detail>
          </>
        )}
        {capture === 'browser' && (
          <>
            <Badge tone="info" dot>
              On
            </Badge>
            <Detail>
              From {firstSite}
              {otherSites.length > 0 && ` and ${otherSites.length} more`}.
            </Detail>
          </>
        )}
        {capture === 'browser-no-sites' && (
          <>
            <Badge tone="warning" dot>
              On, no sites
            </Badge>
            <Detail>Browsers are refused until the Application has an allowed site.</Detail>
          </>
        )}
      </Fact>
      <Fact term="Consent" href={`${settingsHref}#consent`}>
        <span className="text-[var(--color-fg)]">{consentSummary(list)}</span>
        {list.lawfulBasis === 'consent' && list.consentText && (
          <Detail>
            <span className="line-clamp-2" title={list.consentText}>
              &ldquo;{list.consentText}&rdquo;
            </span>
          </Detail>
        )}
      </Fact>
      <Fact term="Submissions" href={`${settingsHref}#data`}>
        <span className="text-[var(--color-fg)]">{retentionSummary(list.submissionRetentionDays)}</span>
        <Detail>
          {list.fieldSchema.length === 0
            ? 'No extra fields, so nothing beyond the address is stored.'
            : `${list.fieldSchema.length} extra ${list.fieldSchema.length === 1 ? 'field' : 'fields'} collected.`}
        </Detail>
      </Fact>
    </dl>
  );
}

function Fact({ term, href, children }: { term: string; href?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="flex items-center justify-between gap-2 text-xs text-[var(--color-muted-fg)]">
        {term}
        {href && (
          <Link href={href} className="text-[11px] text-[var(--color-primary)] hover:underline">
            Change
          </Link>
        )}
      </dt>
      <dd className="space-y-1">{children}</dd>
    </div>
  );
}

function Detail({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="text-xs leading-snug text-[var(--color-muted-fg)]">{children}</div>;
}
