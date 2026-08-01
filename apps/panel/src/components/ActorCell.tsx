import * as React from 'react';
import Link from 'next/link';
import { Badge } from '@/components/Badge';
import type { ActorEmails } from '@/lib/security-events';

/**
 * Who did this — by email, linked, the way Payments and Dunning already do it.
 *
 * The audit log and Activity used to print `actorId` verbatim: a 25-character
 * CUID, truncated to 12rem, with the person's identity available nowhere on
 * the page. "Who is cmsa91v4c000nv5h5txnjvvry?" had no answer inside the
 * product. Emails are resolved a page at a time by `resolveActorEmails`; an
 * unresolved id falls back to the CUID rather than to nothing.
 */
export function ActorCell({
  actorType,
  actorId,
  applicationId,
  emails,
}: {
  actorType: string;
  actorId: string | null;
  applicationId: string | null;
  emails: ActorEmails;
}): React.JSX.Element {
  const email = actorId ? emails.get(actorId) : undefined;
  const tone = actorType === 'operator' ? 'info' : actorType === 'end_user' ? 'brand' : 'neutral';
  // An end-user has a page; an operator's identity lives on /team, which lists
  // rather than deep-links, so only end-users get a link.
  const href =
    actorType === 'end_user' && actorId && applicationId
      ? `/applications/${applicationId}/end-users/${actorId}`
      : null;

  return (
    <>
      <Badge tone={tone}>{actorType.replace('_', '-')}</Badge>
      {actorId !== null && (
        <div className="mt-1 max-w-[16rem] truncate text-xs" title={actorId}>
          {email !== undefined ? (
            href !== null ? (
              <Link
                href={href}
                className="text-[var(--color-fg)] underline decoration-[var(--color-border)] underline-offset-2 hover:decoration-[var(--color-fg)]"
              >
                {email}
              </Link>
            ) : (
              <span className="text-[var(--color-fg)]">{email}</span>
            )
          ) : (
            <span className="font-mono text-[var(--color-muted-fg)]">{actorId}</span>
          )}
        </div>
      )}
    </>
  );
}
