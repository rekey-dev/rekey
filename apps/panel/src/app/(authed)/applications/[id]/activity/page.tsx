import * as React from 'react';
import { formatDateTime } from '@/lib/date';
import { api, type SecurityEventRow } from '@/lib/api';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';

/**
 * Per-application Activity log. End-user-scoped events (sign-ups, sign-ins,
 * password/passkey/email changes) recorded best-effort in the API auth routes
 * and read back filtered to `actorType=end_user` for this application.
 */

const TYPE_LABEL: Record<string, string> = {
  'user.signed_up': 'Signed up',
  'user.signed_in': 'Signed in',
  'user.password_changed': 'Password changed',
  'user.password_reset': 'Password reset',
  'user.email_verified': 'Email verified',
  'user.passkey_added': 'Passkey added',
  'user.passkey_removed': 'Passkey removed',
  'user.sessions_revoked': 'Signed out everywhere',
};

function viaLabel(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'via' in metadata) {
    const via = (metadata as { via?: unknown }).via;
    if (typeof via === 'string') return via.replace(/_/g, ' ');
  }
  return null;
}

export default async function ActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const { events } = await api<{ events: SecurityEventRow[] }>({
    method: 'GET',
    path: `/api/v1/tenant/security-events?applicationId=${encodeURIComponent(id)}&actorType=end_user&limit=200`,
  });

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Activity"
        description="End-user events for this application — sign-ups, sign-ins, and credential changes. Newest first. Captured best-effort; informational, not a billing-grade audit trail."
      />

      {events.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No end-user activity yet"
          description="Events appear here as your users sign up and sign in."
        />
      ) : (
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Event</TH>
              <TH>End-user</TH>
              <TH>IP</TH>
              <TH>When</TH>
            </TR>
          </THead>
          <TBody>
            {events.map((e) => {
              const via = viaLabel(e.metadata);
              return (
                <TR key={e.id} hover>
                  <TD>
                    <div className="flex items-center gap-2 font-medium text-[var(--color-fg)]">
                      {TYPE_LABEL[e.type] ?? e.type}
                      {via && (
                        <Badge tone="neutral" className="font-normal">
                          {via}
                        </Badge>
                      )}
                    </div>
                    <div className="font-mono text-xs text-[var(--color-muted-fg)]">{e.type}</div>
                  </TD>
                  <TD className="text-xs">
                    {e.actorId ? (
                      <span title={e.actorId} className="inline-block max-w-[14rem] truncate font-mono text-[var(--color-muted-fg)]">
                        {e.actorId}
                      </span>
                    ) : (
                      <span className="text-[var(--color-muted-fg)]">—</span>
                    )}
                  </TD>
                  <TD mono muted>
                    {e.ip ?? '—'}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(e.createdAt)}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
