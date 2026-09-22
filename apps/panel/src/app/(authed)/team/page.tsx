import * as React from 'react';
import { DOMAIN_LABEL, SCOPE_DOMAINS, levelFor } from '@/lib/operator-scopes';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { errorQuery, readErrorFlash, api, PanelApiError, type ApplicationRow, type MemberRow, type InvitationRow, getMe, unlessBusy } from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { RevealActionForm, type RevealResult } from '@/components/RevealActionForm';
import { WhileUrlHas } from '@/components/WhileUrlHas';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { publicHttpUrl } from '@/lib/public-url';
import { PageHeader } from '@/components/PageHeader';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Field, fieldInputCls } from '@/components/Field';
import { MemberRoleSelect } from '@/components/MemberRoleSelect';

interface InviteCreateResponse {
  invitation: InvitationRow;
  token: string;
  /** True when the deployment's default email pool delivered the invite. */
  emailSent: boolean;
  warning: string;
}

async function invite(formData: FormData): Promise<RevealResult> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? 'MEMBER');
  if (!email) redirect('/team?error=missing');
  let result: InviteCreateResponse;
  try {
    result = await api<InviteCreateResponse>({
      method: 'POST',
      path: '/api/v1/tenant/workspace/invitations',
      body: { email, role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/team?${await errorQuery(err)}`);
    }
    throw err;
  }
  // The token joins a workspace, so it is a credential: in a URL it lands in
  // browser history, in the `Referer` of the next outbound link, and in every
  // access log between here and the operator. It goes back in this action's
  // response instead, to the dialog `RevealActionForm` opens, and the page is
  // revalidated so the pending invitation is already in the list behind it.
  revalidatePath('/team');
  return {
    secret: {
      title: 'Invitation link',
      value: inviteLink(result.token),
      flag: 'member_invited',
      notes: [
        `For ${result.invitation.email}. Single-use, expires in 7 days.`,
        result.emailSent
          ? 'We emailed the invite as well. The link is here in case you need to share it another way.'
          : 'Email delivery is not configured on this deployment, so send the link through your own channel.',
      ],
    },
  };
}

/**
 * PANEL_URL is server-only and on some deploys is an in-cluster host (e.g.
 * http://panel:3031); `publicHttpUrl()` keeps that out of what the operator
 * copies. When it doesn't look public the link carries a visible sentinel
 * rather than a relative path: this link is pasted into an email, where a
 * relative path is silently useless to the recipient, whereas the sentinel
 * names the variable the operator has to set.
 */
function inviteLink(token: string): string {
  const panelBase = publicHttpUrl(process.env.PANEL_URL ?? '') ?? '<set PANEL_URL>';
  return `${panelBase}/accept-invite?token=${token}`;
}

async function revokeInvite(invitationId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/workspace/invitations/${encodeURIComponent(invitationId)}`,
  });
  redirect('/team');
}

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

async function setGrant(membershipId: string, formData: FormData): Promise<void> {
  'use server';
  const applicationId = String(formData.get('applicationId') ?? '');
  const role = String(formData.get('appRole') ?? 'APP_VIEWER');
  if (!applicationId) redirect('/team?error=grant-missing');
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}/grants`,
      body: { applicationId, role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team');
}

/**
 * Set or lift a member's scopes. One select per domain (none / read / write)
 * plus a switch for "unrestricted"; the API validates against its registry
 * and refuses anything unknown, so the panel's copy of the domain list can
 * only ever hide a control, never grant a permission.
 */
async function setScopes(membershipId: string, formData: FormData): Promise<void> {
  'use server';
  const restricted = formData.get('restricted') === 'on';
  const scopes: string[] = [];
  if (restricted) {
    for (const d of SCOPE_DOMAINS) {
      const level = String(formData.get(`scope:${d}`) ?? 'none');
      if (level === 'read') scopes.push(`${d}:read`);
      if (level === 'write') scopes.push(`${d}:write`);
    }
  }
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}`,
      body: { scopes: restricted ? scopes : null },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team');
}

async function removeGrant(membershipId: string, applicationId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}/grants/${encodeURIComponent(applicationId)}`,
  });
  redirect('/team');
}

const ERR: Record<string, string> = {
  missing: 'Email required.',
  'grant-missing': 'Pick an application to grant access to.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can invite members.',
  INVITE_TARGET_ALREADY_MEMBER: 'That email is already a member of this workspace.',
  APP_GRANT_MEMBER_ONLY:
    'Grants only apply to members. Owners and admins already have full access to every application.',
};

const GRANT_ROLE_LABEL: Record<string, string> = {
  APP_ADMIN: 'App admin (full access)',
  APP_BILLING: 'Billing manager (plans, coupons, payments)',
  APP_VIEWER: 'Viewer (read-only)',
};

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const [me, memberPage, invitationPage] = await Promise.all([
    getMe(),
    api<Page<MemberRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }),
    // OWNER/ADMIN-only, unlike the member list beside it. A GET 403 becomes
    // Next's `forbidden()` and replaces the whole page, so an uncaught one here
    // meant a MEMBER opening Team, which the sidebar offers them, with no role
    // floor, lost the roster they ARE allowed to see, and got a bare 403
    // instead. Omitted-on-failure, the same shape `applications/page.tsx` uses
    // for this exact endpoint.
    api<Page<InvitationRow>>({
      method: 'GET',
      path: '/api/v1/tenant/workspace/invitations',
    }).catch(() => null),
  ]);
  const members = memberPage.items;
  const invitations = invitationPage?.items ?? null;

  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  // Application list for the grants picker. Members may only see a subset
  // (or fail member-role fetch edge cases), degrade to an empty picker.
  const applications = canManage
    ? (
        await api<Page<ApplicationRow>>({
          method: 'GET',
          path: '/api/v1/tenant/applications/?limit=100&offset=0',
        }).catch(unlessBusy(() => emptyPage<ApplicationRow>(100)))
      ).items
    : [];
  const memberRows = members.filter((m) => m.role === 'MEMBER');
  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Team"
        description={
          <>
            Members of{' '}
            <strong className="text-[var(--color-fg)]">
              {me.memberships.find((m) => m.tenantId === me.activeTenantId)?.tenantName}
            </strong>
            .
          </>
        }
      />

      {/* Members */}
      <div className="space-y-3">
        <SectionHeader title="Members" count={`(${members.length})`} />
        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Email</TH>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>Joined</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {members.map((m) => (
              <TR key={m.membershipId} hover>
                <TD>
                  {m.email}
                  {m.tenantUserId === me.user.id && (
                    <span className="ml-1.5 text-xs text-[var(--color-muted-fg)]">(you)</span>
                  )}
                </TD>
                <TD muted>{m.name ?? '—'}</TD>
                <TD>
                  {canManage && m.tenantUserId !== me.user.id ? (
                    <ActionForm action={changeRole.bind(null, m.membershipId)}>
                      <MemberRoleSelect email={m.email} currentRole={m.role} />
                    </ActionForm>
                  ) : (
                    <Badge tone="neutral">{m.role}</Badge>
                  )}
                </TD>
                <TD muted className="text-xs">
                  {formatDate(m.joinedAt)}
                </TD>
                <TD align="right">
                  {canManage && m.tenantUserId !== me.user.id && (
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
            ))}
          </TBody>
        </Table>
      </div>

      {/* Application access (per-member grants) */}
      <div className="space-y-3">
        <SectionHeader title="Application access" />
        <p className="text-sm text-[var(--color-muted-fg)]">
          A member sees only the applications you grant them, at the level you choose. A member with
          no grants sees <strong>nothing</strong>, which is the state accepting an invitation
          produces, so grant a new teammate an application before expecting them to find their way
          around. Owners and admins always have full access to everything.
        </p>
        {error && (error === 'grant-missing' || error === 'APP_GRANT_MEMBER_ONLY') && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
          </p>
        )}
        {memberRows.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No members with the MEMBER role"
            description="Per-application access only applies to members. Owners and admins always see everything."
          />
        ) : (
          <ul className="space-y-3">
            {memberRows.map((m) => {
              const isSelf = m.tenantUserId === me.user.id;
              return (
                <li
                  key={m.membershipId}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 space-y-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium">
                      {m.email}
                      {isSelf && (
                        <span className="ml-1.5 text-xs font-normal text-[var(--color-muted-fg)]">(you)</span>
                      )}
                    </p>
                    {/* Zero grants is no longer "all apps, read-only" (#326),
                        it is no access at all, unless the API flags this
                        membership as grandfathered by the backfill. Saying
                        "all apps" for a member who can see none of them is the
                        one thing an owner must not be told. */}
                    <Badge
                      tone={
                        (m.grants ?? []).length > 0
                          ? 'success'
                          : m.legacyWorkspaceRead
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {(m.grants ?? []).length > 0
                        ? `${(m.grants ?? []).length} granted app${(m.grants ?? []).length === 1 ? '' : 's'}`
                        : m.legacyWorkspaceRead
                          ? 'All apps · read-only (legacy)'
                          : 'No access yet'}
                    </Badge>
                  </div>

                  {(m.grants ?? []).length > 0 && (
                    <ul className="space-y-1.5">
                      {(m.grants ?? []).map((g) => (
                        <li
                          key={g.applicationId}
                          className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] px-3 py-1.5"
                        >
                          <span className="min-w-0 truncate text-sm">
                            {g.applicationName}{' '}
                            <span className="font-mono text-xs text-[var(--color-muted-fg)]">{g.applicationSlug}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <Badge tone={g.role === 'APP_ADMIN' ? 'warning' : 'neutral'}>{g.role}</Badge>
                            {canManage && (
                              <ActionForm action={removeGrant.bind(null, m.membershipId, g.applicationId)}>
                                <ConfirmButton
                                  confirm={`Remove ${m.email}'s ${g.role} access to ${g.applicationName}?${(m.grants ?? []).length === 1 ? ' This is their last grant, and they will be left with access to no application at all.' : ''}`}
                                >
                                  Remove
                                </ConfirmButton>
                              </ActionForm>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {canManage && m.role === 'MEMBER' && (
                    <ScopeEditor membershipId={m.membershipId} scopes={m.scopes ?? null} />
                  )}

                  {canManage && applications.length > 0 && (
                    <ActionForm
                      action={setGrant.bind(null, m.membershipId)}
                      className="flex flex-wrap items-end gap-3"
                    >
                      <label className="block min-w-44 flex-1 space-y-1">
                        <span className="text-xs font-medium">Application</span>
                        <select name="applicationId" required className={fieldInputCls}>
                          {applications.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.slug})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block min-w-44 flex-1 space-y-1">
                        <span className="text-xs font-medium">Role</span>
                        <select name="appRole" defaultValue="APP_VIEWER" className={fieldInputCls}>
                          {(['APP_VIEWER', 'APP_BILLING', 'APP_ADMIN'] as const).map((r) => (
                            <option key={r} value={r}>
                              {GRANT_ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <SubmitButton
                        pendingLabel="Granting…"
                        className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
                      >
                        Grant access
                      </SubmitButton>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Invitations, admin-only data, so absent for a MEMBER rather than empty. */}
      {invitations !== null && (
      <div className="space-y-3">
        <SectionHeader title="Invitations" count={`(${invitations.length})`} />
        {invitations.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No pending invitations"
            description="Invite a teammate above to give them access to this workspace."
          />
        ) : (
          <Table minWidth="min-w-[40rem]">
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH>Expires</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {invitations.map((i) => (
                <TR key={i.id} hover>
                  <TD>{i.email}</TD>
                  <TD muted className="text-xs">{i.role}</TD>
                  <TD>
                    <Badge
                      tone={
                        i.status === 'pending' ? 'warning' : i.status === 'accepted' ? 'success' : 'neutral'
                      }
                    >
                      {i.status}
                    </Badge>
                  </TD>
                  <TD muted className="text-xs">
                    {formatDate(i.expiresAt)}
                  </TD>
                  <TD align="right">
                    {canManage && i.status === 'pending' && (
                      <ActionForm action={revokeInvite.bind(null, i.id)}>
                        <ConfirmButton
                          confirm={`Revoke the invitation for ${i.email}? The link will stop working.`}
                        >
                          Revoke
                        </ConfirmButton>
                      </ActionForm>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      )}

      {/* Invite form */}
      {canManage && (
        <div className="space-y-3">
          <SectionHeader title="Invite a teammate" />
          <RevealActionForm
            action={invite}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4"
          >
            {error && error !== 'INVITE_TARGET_ALREADY_MEMBER' && (
              <WhileUrlHas param="error">
                <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                  <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
                </p>
              </WhileUrlHas>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Email"
                error={
                  error === 'INVITE_TARGET_ALREADY_MEMBER' ? (
                    <WhileUrlHas param="error">{ERR[error]}</WhileUrlHas>
                  ) : undefined
                }
              >
                <input
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  placeholder="teammate@example.com"
                  className={fieldInputCls}
                />
              </Field>
              <Field
                label="Role"
                hint={
                  'A member joins with access to no application. Grant them one under Application access above. Admins see everything.'
                }
              >
                <select name="role" defaultValue="MEMBER" className={fieldInputCls}>
                  <option value="MEMBER">Member (per-application access)</option>
                  <option value="ADMIN">Admin</option>
                  {me.activeRole === 'OWNER' && <option value="OWNER">Owner</option>}
                </select>
              </Field>
            </div>
            <SubmitButton
              pendingLabel="Generating link…"
              className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] sm:w-auto disabled:opacity-60"
            >
              Generate invite link
            </SubmitButton>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Single-use, expires in 7 days. If email is configured on this
              deployment we send it; either way you get a link to share.
            </p>
          </RevealActionForm>
        </div>
      )}
    </section>
  );
}


/**
 * What this member may DO, workspace-wide, on top of which applications their
 * grants let them reach. Unrestricted by default, every existing member is,
 * and the switch makes the restriction an explicit act rather than a default
 * somebody forgot to lift.
 */
function ScopeEditor({
  membershipId,
  scopes,
}: {
  membershipId: string;
  scopes: string[] | null;
}): React.JSX.Element {
  const restricted = scopes !== null;
  return (
    <ActionForm
      action={setScopes.bind(null, membershipId)}
      className="space-y-3 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] px-3 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-[var(--color-fg)]">Scopes</div>
          <p className="max-w-xl text-xs text-[var(--color-muted-fg)]">
            What this member may do inside the applications they are granted. A grant decides{' '}
            <em>which</em> applications; scopes decide <em>what</em>, and the two only ever narrow each
            other.
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-xs">
          <input type="checkbox" name="restricted" defaultChecked={restricted} />
          Restrict
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {SCOPE_DOMAINS.map((d) => {
          const meta = DOMAIN_LABEL[d];
          return (
            <label key={d} className="flex items-start justify-between gap-3 text-xs">
              <span className="min-w-0">
                <span className="block font-medium text-[var(--color-fg)]">{meta.label}</span>
                <span className="block text-[11px] text-[var(--color-muted-fg)]">{meta.hint}</span>
                {meta.risk && (
                  <span className="block text-[11px] text-amber-700 dark:text-amber-400">{meta.risk}</span>
                )}
              </span>
              <select
                name={`scope:${d}`}
                defaultValue={levelFor(scopes, d)}
                className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-fg)]"
              >
                <option value="none">None</option>
                <option value="read">Read</option>
                <option value="write">Read &amp; write</option>
              </select>
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-[var(--color-muted-fg)]">
        With <strong>Restrict</strong> off, every scope applies and the selects are ignored. Grants,
        roles, invitations, lifecycle, impersonation and erasure are never scopes. They stay with
        owners and admins.
      </p>
      <SubmitButton
        pendingLabel="Saving…"
        className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
      >
        Save scopes
      </SubmitButton>
    </ActionForm>
  );
}
