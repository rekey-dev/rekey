import * as React from 'react';
import { redirect } from 'next/navigation';
import Link from '@/components/Link';
import { api, getMe, type MemberRow } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { formatDate } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { MemberRoleSelect } from '@/components/MemberRoleSelect';
import { savedStateKey } from '@/lib/saved-state-key';

async function removeMember(membershipId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}`,
  });
  redirect('/team');
}

async function changeRole(membershipId: string, formData: FormData): Promise<void> {
  'use server';
  const role = String(formData.get('role') ?? 'MEMBER');
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}`,
    body: { role },
  });
  redirect('/team');
}

function accessSummary(m: MemberRow): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (m.role !== 'MEMBER') return { label: 'All applications', tone: 'neutral' };
  const grants = (m.grants ?? []).length;
  if (grants > 0) return { label: `${grants} application${grants === 1 ? '' : 's'}`, tone: 'success' };
  // Zero grants is no access at all (#326), unless the API flags the
  // membership as grandfathered by the backfill.
  return m.legacyWorkspaceRead
    ? { label: 'All, read-only (legacy)', tone: 'warning' }
    : { label: 'No access yet', tone: 'warning' };
}

export default async function TeamMembersPage(): Promise<React.JSX.Element> {
  const [me, memberPage] = await Promise.all([
    getMe(),
    api<Page<MemberRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }),
  ]);
  const members = memberPage.items;
  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';

  return (
    <section className="space-y-3" aria-labelledby="members-heading">
      <SectionHeader
        title={<span id="members-heading">Members</span>}
        count={`(${members.length})`}
        description={
          <>
            Owners and admins manage the workspace and see every application. Members see only the
            applications you grant them on{' '}
            <Link href="/team/access" className="underline hover:text-[var(--color-fg)]">
              Application access
            </Link>
            .
          </>
        }
      />
      <Table minWidth="min-w-[44rem]">
        <THead>
          <TR>
            <TH>Email</TH>
            <TH>Name</TH>
            <TH>Role</TH>
            <TH>Access</TH>
            <TH>Joined</TH>
            <TH align="right">
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {members.map((m) => {
            const isSelf = m.tenantUserId === me.user.id;
            const access = accessSummary(m);
            return (
              <TR key={m.membershipId} hover>
                <TD>
                  {m.email}
                  {isSelf && <span className="ml-1.5 text-xs text-[var(--color-muted-fg)]">(you)</span>}
                </TD>
                <TD muted>{m.name ?? '—'}</TD>
                <TD>
                  {canManage && !isSelf ? (
                    <ActionForm key={savedStateKey(m.role)} action={changeRole.bind(null, m.membershipId)}>
                      <MemberRoleSelect email={m.email} currentRole={m.role} />
                    </ActionForm>
                  ) : (
                    <Badge tone="neutral">{m.role}</Badge>
                  )}
                </TD>
                <TD>
                  {m.role === 'MEMBER' ? (
                    <Link
                      href="/team/access"
                      className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    >
                      <Badge tone={access.tone}>{access.label}</Badge>
                    </Link>
                  ) : (
                    <span className="text-xs text-[var(--color-muted-fg)]">{access.label}</span>
                  )}
                </TD>
                <TD muted className="text-xs">
                  {formatDate(m.joinedAt)}
                </TD>
                <TD align="right">
                  {canManage && !isSelf && (
                    <ActionForm action={removeMember.bind(null, m.membershipId)}>
                      <ConfirmButton
                        confirm={`Remove ${m.email} from this workspace? They'll lose all access immediately.`}
                      >
                        Remove
                      </ConfirmButton>
                    </ActionForm>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </section>
  );
}
