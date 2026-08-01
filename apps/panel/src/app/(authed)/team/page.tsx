import * as React from 'react';
import { redirect } from 'next/navigation';
import {
  api,
  PanelApiError,
  type ApplicationRow,
  type MemberRow,
  type InvitationRow,
  type MeDto,
} from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { publicHttpUrl } from '@/lib/public-url';
import { PageHeader } from '@/components/PageHeader';
import { SectionHeader } from '@/components/Card';
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

async function invite(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const role = String(formData.get('role') ?? 'MEMBER');
  if (!email) redirect('/team?error=missing');
  try {
    const result = await api<InviteCreateResponse>({
      method: 'POST',
      path: '/api/v1/tenant/workspace/invitations',
      body: { email, role },
    });
    redirect(
      `/team?inviteToken=${encodeURIComponent(result.token)}&emailSent=${result.emailSent ? '1' : '0'}&e=member_invited`,
    );
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/team?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
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
    if (err instanceof PanelApiError) redirect(`/team?error=${encodeURIComponent(err.code)}`);
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
    'Grants only apply to members — owners and admins already have full access to every application.',
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
  const inviteToken = typeof sp.inviteToken === 'string' ? sp.inviteToken : undefined;
  const inviteEmailSent = sp.emailSent === '1';

  const [me, members, invitations] = await Promise.all([
    api<MeDto>({ method: 'GET', path: '/api/v1/tenant/auth/me' }),
    api<MemberRow[]>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }),
    api<InvitationRow[]>({ method: 'GET', path: '/api/v1/tenant/workspace/invitations' }),
  ]);

  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  // Application list for the grants picker. Members may only see a subset
  // (or fail member-role fetch edge cases) — degrade to an empty picker.
  const applications = canManage
    ? await api<ApplicationRow[]>({
        method: 'GET',
        path: '/api/v1/tenant/applications/?limit=100&offset=0',
      }).catch(() => [] as ApplicationRow[])
    : [];
  const memberRows = members.filter((m) => m.role === 'MEMBER');
  // PANEL_URL is server-only and on some deploys is an in-cluster host (e.g.
  // http://panel:3031) — publicHttpUrl() keeps that out of the client HTML.
  // When it doesn't look public we emit a visible sentinel rather than a
  // relative path: this link is copied into an email, where a relative path is
  // silently useless to the recipient, whereas the sentinel names the variable
  // the operator has to set.
  const panelBase = publicHttpUrl(process.env.PANEL_URL ?? '') ?? '<set PANEL_URL>';
  const inviteUrl = inviteToken ? `${panelBase}/accept-invite?token=${inviteToken}` : null;

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

      {inviteUrl && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/60 dark:bg-amber-950/60 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Invitation link (single-use, expires in 7 days)
            </p>
            <CopyButton value={inviteUrl} label="Copy link" />
          </div>
          <code className="block break-all rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs font-mono">
            {inviteUrl}
          </code>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {inviteEmailSent
              ? 'We emailed the invite. The link is here too, in case you need to re-share — it is shown only once.'
              : 'Email delivery is not configured on this deployment, so copy the link and send it through your own channel.'}
          </p>
        </div>
      )}

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
                    <form action={changeRole.bind(null, m.membershipId)}>
                      <MemberRoleSelect email={m.email} currentRole={m.role} />
                    </form>
                  ) : (
                    <Badge tone="neutral">{m.role}</Badge>
                  )}
                </TD>
                <TD muted className="text-xs">
                  {formatDate(m.joinedAt)}
                </TD>
                <TD align="right">
                  {canManage && m.tenantUserId !== me.user.id && (
                    <form action={removeMember.bind(null, m.membershipId)}>
                      <ConfirmButton
                        confirm={`Remove ${m.email} from this workspace? They'll lose all access immediately.`}
                      >
                        Remove
                      </ConfirmButton>
                    </form>
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
          Members with no grants can read every application but change nothing (legacy default).
          Granting access to specific applications limits a member to those applications at the
          chosen level. Owners and admins always have full access to everything.
        </p>
        {error && (error === 'grant-missing' || error === 'APP_GRANT_MEMBER_ONLY') && (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {ERR[error] ?? 'Something went wrong. Please try again.'}
          </p>
        )}
        {memberRows.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-fg)]">
            No members with the MEMBER role — nothing to scope.
          </p>
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
                    <Badge tone={m.grants.length > 0 ? 'success' : 'neutral'}>
                      {m.grants.length > 0
                        ? `${m.grants.length} granted app${m.grants.length === 1 ? '' : 's'}`
                        : 'All apps · read-only'}
                    </Badge>
                  </div>

                  {m.grants.length > 0 && (
                    <ul className="space-y-1.5">
                      {m.grants.map((g) => (
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
                              <form action={removeGrant.bind(null, m.membershipId, g.applicationId)}>
                                <ConfirmButton
                                  confirm={`Remove ${m.email}'s ${g.role} access to ${g.applicationName}? If this is their last grant they fall back to read-only access on every application.`}
                                >
                                  Remove
                                </ConfirmButton>
                              </form>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  {canManage && applications.length > 0 && (
                    <form
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
                        className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
                      >
                        Grant access
                      </SubmitButton>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Invitations */}
      <div className="space-y-3">
        <SectionHeader title="Invitations" count={`(${invitations.length})`} />
        {invitations.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-fg)]">No invitations.</p>
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
                      <form action={revokeInvite.bind(null, i.id)}>
                        <ConfirmButton
                          confirm={`Revoke the invitation for ${i.email}? The link will stop working.`}
                        >
                          Revoke
                        </ConfirmButton>
                      </form>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      {/* Invite form */}
      {canManage && (
        <div className="space-y-3">
          <SectionHeader title="Invite a teammate" />
          <form
            action={invite}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4"
          >
            {error && error !== 'INVITE_TARGET_ALREADY_MEMBER' && (
              <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                {ERR[error] ?? 'Something went wrong. Please try again.'}
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label="Email"
                error={error === 'INVITE_TARGET_ALREADY_MEMBER' ? ERR[error] : undefined}
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
              <Field label="Role">
                <select name="role" defaultValue="MEMBER" className={fieldInputCls}>
                  <option value="MEMBER">Member (read-only)</option>
                  <option value="ADMIN">Admin</option>
                  {me.activeRole === 'OWNER' && <option value="OWNER">Owner</option>}
                </select>
              </Field>
            </div>
            <SubmitButton
              pendingLabel="Generating link…"
              className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] sm:w-auto disabled:opacity-60"
            >
              Generate invite link
            </SubmitButton>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Single-use, expires in 7 days. If email is configured on this
              deployment we send it; either way you get a link to share.
            </p>
          </form>
        </div>
      )}
    </section>
  );
}
