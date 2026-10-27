import * as React from 'react';
import Link from '@/components/Link';
import { api, getMe, readErrorFlash, unlessBusy, type ApplicationRow, type InvitationRow, type MemberRow } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { RevealActionForm } from '@/components/RevealActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { WhileUrlHas } from '@/components/WhileUrlHas';
import { ApiErrorText } from '@/components/api-error';
import { formatDate } from '@/lib/date';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { MemberRoleSelect } from '@/components/MemberRoleSelect';
import { savedStateKey } from '@/lib/saved-state-key';
import { assignableRoles, roleLabel, workspaceRoleOptions } from '@/lib/workspace-roles';
import { changeRole, removeMember, resendInvite, revokeInvite } from './actions';
import { InviteDialog } from './invite-dialog';
import { RoleGuide } from './role-guide';

const ERR: Record<string, string> = {
  CANNOT_REMOVE_LAST_OWNER: 'A workspace needs at least one owner. Make someone else an owner first.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change that person. Ask an owner.',
  INVITATION_NOT_USABLE: 'That invitation was already accepted or withdrawn.',
  INVITATION_NOT_FOUND: 'That invitation no longer exists.',
  MEMBERSHIP_NOT_FOUND: 'That person is no longer in this workspace.',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function accessSummary(m: MemberRow): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (m.role !== 'MEMBER') return { label: 'Every app', tone: 'neutral' };
  const grants = (m.grants ?? []).length;
  if (grants > 0) return { label: `${grants} app${grants === 1 ? '' : 's'}`, tone: 'success' };
  // Zero grants is no access at all (#326), unless the API flags the
  // membership as grandfathered by the backfill.
  return m.legacyWorkspaceRead
    ? { label: 'Every app, view only', tone: 'warning' }
    : { label: 'No apps yet', tone: 'warning' };
}

function initials(name: string | null, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

function Avatar({ name, email, pending = false }: { name: string | null; email: string; pending?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={
        'grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold ' +
        (pending
          ? 'border border-dashed border-[var(--color-border)] text-[var(--color-muted-fg)]'
          : 'bg-[var(--color-primary-soft)] text-[var(--color-primary-soft-fg)]')
      }
    >
      {initials(name, email)}
    </span>
  );
}

function inviteState(inv: InvitationRow): { label: string; tone: 'warning' | 'neutral' } {
  if (inv.status === 'expired') return { label: 'Invite expired', tone: 'neutral' };
  const days = Math.max(1, Math.ceil((new Date(inv.expiresAt).getTime() - Date.now()) / DAY_MS));
  return { label: `Invited, expires in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
}

export default async function TeamPeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const inviteOpen = sp.newInvite === '1';
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const me = await getMe();
  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  const workspaceName = me.memberships.find((m) => m.tenantId === me.activeTenantId)?.tenantName ?? 'this workspace';
  const [memberPage, invitationPage, applicationPage] = await Promise.all([
    api<Page<MemberRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/members?limit=100' }),
    // Invitations are OWNER/ADMIN data; the API refuses a MEMBER.
    canManage
      ? api<Page<InvitationRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/invitations?limit=100' })
      : Promise.resolve(emptyPage<InvitationRow>(0)),
    // The invite dialog's app picker. Degrades to "no apps yet" rather than failing the page.
    canManage
      ? api<Page<ApplicationRow>>({ method: 'GET', path: '/api/v1/tenant/applications/?limit=100&offset=0' }).catch(
          unlessBusy(() => emptyPage<ApplicationRow>(100)),
        )
      : Promise.resolve(emptyPage<ApplicationRow>(0)),
  ]);
  const members = memberPage.items;
  const manageable = new Set(assignableRoles(me.activeRole));
  // Accepted invitations already show as people, and withdrawn ones are done.
  const open = invitationPage.items.filter((i) => i.status === 'pending' || i.status === 'expired');
  const alone = members.length === 1 && open.length === 0;

  return (
    <div className="space-y-6">
      {error && !inviteOpen && (
        <WhileUrlHas param="error">
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} />
          </Banner>
        </WhileUrlHas>
      )}

      <section className="space-y-3" aria-labelledby="people-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="people-heading" className="text-base font-semibold">
              People{' '}
              <span className="font-normal text-[var(--color-muted-fg)]">
                ({memberPage.page.total}
                {open.length > 0 && `, ${open.length} invited`})
              </span>
            </h2>
            <p className="text-sm text-[var(--color-muted-fg)]">
              Everyone who can sign in to {workspaceName}.
            </p>
          </div>
          {canManage && (
            <InviteDialog
              actorRole={me.activeRole}
              workspaceName={workspaceName}
              applications={applicationPage.items.map((a) => ({ id: a.id, name: a.name }))}
              error={inviteOpen ? error : undefined}
              errorDetail={errorDetail}
              errorFix={errorFix}
            />
          )}
        </div>

        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Apps</TH>
              <TH>Joined</TH>
              <TH align="right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {members.map((m) => {
              const isSelf = m.tenantUserId === me.user.id;
              const editable = canManage && !isSelf && manageable.has(m.role);
              const access = accessSummary(m);
              return (
                <TR key={m.membershipId} hover>
                  <TD>
                    <div className="flex items-center gap-3">
                      <Avatar name={m.name} email={m.email} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {m.name ?? m.email}
                          {isSelf && <span className="ml-1.5 text-xs font-normal text-[var(--color-muted-fg)]">(you)</span>}
                        </div>
                        {m.name && <div className="truncate text-xs text-[var(--color-muted-fg)]">{m.email}</div>}
                      </div>
                    </div>
                  </TD>
                  <TD>
                    {editable && manageable.size > 1 ? (
                      <ActionForm key={savedStateKey(m.role)} action={changeRole.bind(null, m.membershipId)}>
                        <MemberRoleSelect
                          email={m.email}
                          currentRole={m.role}
                          roles={workspaceRoleOptions(assignableRoles(me.activeRole))}
                        />
                      </ActionForm>
                    ) : (
                      <Badge tone={m.role === 'OWNER' ? 'brand' : 'neutral'}>{roleLabel(m.role)}</Badge>
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
                    {editable && (
                      <ActionForm action={removeMember.bind(null, m.membershipId)}>
                        <ConfirmButton
                          title={`Remove ${m.name ?? m.email}?`}
                          confirm={`${m.email} loses access to ${workspaceName} right away. You can invite them again later.`}
                          confirmLabel="Remove from workspace"
                        >
                          Remove
                        </ConfirmButton>
                      </ActionForm>
                    )}
                  </TD>
                </TR>
              );
            })}
            {open.map((inv) => {
              const state = inviteState(inv);
              const editable = manageable.has(inv.role);
              return (
                <TR key={inv.id} hover>
                  <TD>
                    <div className="flex items-center gap-3">
                      <Avatar name={null} email={inv.email} pending />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{inv.email}</div>
                        <div className="text-xs">
                          <Badge tone={state.tone}>{state.label}</Badge>
                        </div>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <span className="text-sm">{roleLabel(inv.role)}</span>
                  </TD>
                  <TD muted className="text-xs">
                    Joins when they accept
                  </TD>
                  <TD muted className="text-xs">
                    Sent {formatDate(inv.createdAt)}
                  </TD>
                  <TD align="right">
                    {editable && (
                      <div className="flex items-center justify-end gap-3">
                        <RevealActionForm action={resendInvite.bind(null, inv.id, inv.email)}>
                          <SubmitButton
                            title="Sends a new link. Any link you sent before stops working."
                            pendingLabel="Sending…"
                            className="text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-60"
                          >
                            {inv.status === 'expired' ? 'Send again' : 'Resend'}
                          </SubmitButton>
                        </RevealActionForm>
                        <ActionForm action={revokeInvite.bind(null, inv.id)}>
                          <ConfirmButton
                            title={`Withdraw the invitation for ${inv.email}?`}
                            confirm="Their invite link stops working. You can invite them again later."
                            confirmLabel="Withdraw invitation"
                          >
                            Withdraw
                          </ConfirmButton>
                        </ActionForm>
                      </div>
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>

        {alone && canManage && (
          <p className="rounded-xl border border-dashed border-[var(--color-border)] px-5 py-4 text-sm text-[var(--color-muted-fg)]">
            It is just you for now. Invite a co-founder, a developer or someone who handles support, and
            pick what each of them can do.
          </p>
        )}
      </section>

      <RoleGuide open={alone} />
    </div>
  );
}
