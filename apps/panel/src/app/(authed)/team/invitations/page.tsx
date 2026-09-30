import * as React from 'react';
import { forbidden, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  api,
  errorQuery,
  getMe,
  PanelApiError,
  readErrorFlash,
  type InvitationRow,
} from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { RevealActionForm, type RevealResult } from '@/components/RevealActionForm';
import { WhileUrlHas } from '@/components/WhileUrlHas';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { publicHttpUrl } from '@/lib/public-url';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Field, fieldInputCls } from '@/components/Field';

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
  if (!email) redirect('/team/invitations?error=missing');
  let result: InviteCreateResponse;
  try {
    result = await api<InviteCreateResponse>({
      method: 'POST',
      path: '/api/v1/tenant/workspace/invitations',
      body: { email, role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/team/invitations?${await errorQuery(err)}`);
    }
    throw err;
  }
  // The token joins a workspace, so it is a credential: in a URL it lands in
  // browser history, in the `Referer` of the next outbound link, and in every
  // access log between here and the operator. It goes back in this action's
  // response instead, to the dialog `RevealActionForm` opens, and the page is
  // revalidated so the pending invitation is already in the list behind it.
  revalidatePath('/team/invitations');
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
  redirect('/team/invitations');
}

const ERR: Record<string, string> = {
  missing: 'Email required.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can invite members.',
  INVITE_TARGET_ALREADY_MEMBER: 'That email is already a member of this workspace.',
};

const STATUS_TONE: Record<string, 'warning' | 'success' | 'neutral'> = {
  pending: 'warning',
  accepted: 'success',
};

export default async function TeamInvitationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const me = await getMe();
  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  // OWNER/ADMIN data. The tab is not offered to a MEMBER; a typed URL gets
  // the panel's own 403 page rather than a half-rendered form.
  if (!canManage) forbidden();

  const invitations = (
    await api<Page<InvitationRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/invitations' })
  ).items;
  const pending = invitations.filter((i) => i.status === 'pending');
  const past = invitations.filter((i) => i.status !== 'pending');

  return (
    <div className="space-y-8">
      <section className="space-y-3" aria-labelledby="invite-heading">
        <SectionHeader
          title={<span id="invite-heading">Invite a teammate</span>}
          description="You get a single-use link that expires in 7 days. If email is set up on this deployment we send it too."
        />
        <RevealActionForm
          action={invite}
          className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
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
              hint="A member joins with access to no application. Grant them one on the Application access tab. Admins see everything."
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
            className="w-full rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 sm:w-auto"
          >
            Generate invite link
          </SubmitButton>
        </RevealActionForm>
      </section>

      <section className="space-y-3" aria-labelledby="pending-heading">
        <SectionHeader title={<span id="pending-heading">Pending</span>} count={`(${pending.length})`} />
        {pending.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No open invitations"
            description="Invitations you send show here until they are accepted, revoked or expire."
          />
        ) : (
          <InvitationTable rows={pending} revocable />
        )}
      </section>

      {past.length > 0 && (
        <section className="space-y-3" aria-labelledby="past-heading">
          <SectionHeader title={<span id="past-heading">Accepted and closed</span>} count={`(${past.length})`} />
          <InvitationTable rows={past} revocable={false} />
        </section>
      )}
    </div>
  );
}

function InvitationTable({ rows, revocable }: { rows: InvitationRow[]; revocable: boolean }): React.JSX.Element {
  return (
    <Table minWidth="min-w-[36rem]">
      <THead>
        <TR>
          <TH>Email</TH>
          <TH>Role</TH>
          <TH>Status</TH>
          <TH>Expires</TH>
          {revocable && (
            <TH align="right">
              <span className="sr-only">Actions</span>
            </TH>
          )}
        </TR>
      </THead>
      <TBody>
        {rows.map((i) => (
          <TR key={i.id} hover>
            <TD>{i.email}</TD>
            <TD muted className="text-xs">{i.role}</TD>
            <TD>
              <Badge tone={STATUS_TONE[i.status] ?? 'neutral'}>{i.status}</Badge>
            </TD>
            <TD muted className="text-xs">{formatDate(i.expiresAt)}</TD>
            {revocable && (
              <TD align="right">
                <ActionForm action={revokeInvite.bind(null, i.id)}>
                  <ConfirmButton confirm={`Revoke the invitation for ${i.email}? The link will stop working.`}>
                    Revoke
                  </ConfirmButton>
                </ActionForm>
              </TD>
            )}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
