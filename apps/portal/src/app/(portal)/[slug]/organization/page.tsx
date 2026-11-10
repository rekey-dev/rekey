import * as React from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { checkoutLocale } from '@/lib/checkout-format';
import { PORTAL_TIME_ZONE, formatDate } from '@/lib/format';
import {
  activeOrganizationOf,
  assignableRoles,
  listMembers,
  listOrganizations,
  listPendingInvitations,
  listRoles,
  managesMembers,
  managesTier,
} from '@/lib/organizations';
import { organizationDoneCopy, organizationErrorCopy, roleLabel } from '@/lib/organization-copy';
import {
  changeMemberRoleAction,
  createOrganizationAction,
  inviteMemberAction,
  leaveOrganizationAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  switchOrganizationAction,
} from '@/lib/organization-actions';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { InviteMemberForm } from '@/components/invite-member-form';
import { ResendInvitationForm } from '@/components/resend-invitation-form';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

const headingCls = 'mb-3 text-sm font-semibold text-[var(--color-fg)]';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';
const inputCls =
  'w-full min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]';

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  const config = await getPortalConfig(slug);
  if (!config) notFound();

  const appName = config.branding.displayName || config.name;
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const done = typeof sp.done === 'string' ? organizationDoneCopy(sp.done) : null;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const activeId = activeOrganizationOf(session.user);

  const [organizations, roles] = await Promise.all([
    listOrganizations(config, session.accessToken),
    listRoles(config, session.accessToken),
  ]);
  const shown = organizations?.find((o) => o.id === activeId) ?? organizations?.[0] ?? null;
  const actor = shown?.baseRole;
  const [members, pending] = shown
    ? await Promise.all([
        listMembers(config, session.accessToken, shown.id),
        actor && managesMembers(actor) ? listPendingInvitations(config, session.accessToken, shown.id) : null,
      ])
    : [null, null];
  const now = Date.now();
  const assignable = actor ? assignableRoles(actor, roles).map((r) => r.name) : [];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Organization</h1>
      {done && <Banner tone="success">{done}</Banner>}
      {error && <Banner tone="error">{organizationErrorCopy(error)}</Banner>}

      <Card>
        <h2 className={headingCls}>Your organizations</h2>
        {organizations === null ? (
          <p className={mutedCls}>Your organizations could not be loaded right now. Reload the page to try again.</p>
        ) : organizations.length === 0 ? (
          <p className={mutedCls}>
            An organization lets a team share {appName} and its plan. Create one below, or open an invitation link
            someone sent you to join theirs.
          </p>
        ) : (
          <div className="space-y-3">
            <ul className="divide-y divide-[var(--color-border)]">
              {organizations.map((org) => (
                <li key={org.id} className="flex items-center justify-between gap-3 py-3">
                  <span className="min-w-0 text-sm text-[var(--color-fg)]">
                    {org.name}
                    <span className="block text-xs text-[var(--color-muted-fg)]">{roleLabel(org.role)}</span>
                  </span>
                  {org.id === activeId ? (
                    <span className="text-xs font-medium text-[var(--color-fg)]">Active</span>
                  ) : (
                    <form action={switchOrganizationAction.bind(null, slug, org.id)}>
                      <SubmitButton variant="secondary" pendingLabel="Switching…" className="text-xs">
                        Make active<span className="sr-only"> {org.name}</span>
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            {activeId && (
              <form action={switchOrganizationAction.bind(null, slug, null)}>
                <SubmitButton variant="secondary" pendingLabel="Switching…">
                  Use my personal account
                </SubmitButton>
              </form>
            )}
          </div>
        )}
      </Card>

      {shown && actor && (
        <Card>
          <h2 className={headingCls}>Members of {shown.name}</h2>
          {members === null ? (
            <p className={mutedCls}>The members could not be loaded right now. Reload the page to try again.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {members.map((member) => {
                const self = member.endUserId === session.user.id;
                const manageable = !self && managesTier(actor, member.baseRole);
                return (
                  <li key={member.endUserId} className="space-y-2 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 break-all text-sm text-[var(--color-fg)]">
                        {member.email}
                        {self && <span className="text-[var(--color-muted-fg)]"> (you)</span>}
                        <span className="block text-xs text-[var(--color-muted-fg)]">
                          {roleLabel(member.role)} · Joined {formatDate(member.createdAt, locale, PORTAL_TIME_ZONE)}
                        </span>
                      </span>
                      {manageable && (
                        <form action={removeMemberAction.bind(null, slug, shown.id, member.endUserId)} className="shrink-0">
                          <ConfirmSubmit
                            variant="danger"
                            size="sm"
                            label="Remove"
                            triggerName={`Remove ${member.email}`}
                            title={`Remove ${member.email}?`}
                            message={`${member.email} will lose access to ${shown.name} and anything its plan gives them.`}
                            confirmLabel="Remove member"
                            cancelLabel="Cancel"
                            pendingLabel="Removing…"
                          />
                        </form>
                      )}
                    </div>
                    {manageable && assignable.length > 0 && (
                      <form
                        action={changeMemberRoleAction.bind(null, slug, shown.id, member.endUserId)}
                        className="flex items-end gap-2"
                      >
                        <label className="block min-w-0 flex-1 space-y-1">
                          <span className="text-xs text-[var(--color-muted-fg)]">Role for {member.email}</span>
                          <select name="role" defaultValue={member.role} className={inputCls}>
                            {assignable.map((role) => (
                              <option key={role} value={role}>
                                {roleLabel(role)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <SubmitButton variant="secondary" pendingLabel="Saving…">
                          Change<span className="sr-only"> role for {member.email}</span>
                        </SubmitButton>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="mt-4">
            {actor === 'OWNER' ? (
              <p className={mutedCls}>Owners cannot leave. To leave, make another member an owner first.</p>
            ) : (
              <form action={leaveOrganizationAction.bind(null, slug, shown.id)}>
                <ConfirmSubmit
                  variant="danger"
                  label="Leave organization"
                  triggerName={`Leave ${shown.name}`}
                  title={`Leave ${shown.name}?`}
                  message={`You will lose access to ${shown.name} and anything its plan gives you. To come back you need a new invitation.`}
                  confirmLabel="Leave"
                  cancelLabel="Stay"
                  pendingLabel="Leaving…"
                />
              </form>
            )}
          </div>
        </Card>
      )}

      {shown && actor && managesMembers(actor) && (
        <Card>
          <h2 className={headingCls}>Invite someone to {shown.name}</h2>
          <InviteMemberForm
            slug={slug}
            organizationId={shown.id}
            roles={assignable}
            invite={inviteMemberAction.bind(null, slug, shown.id)}
          />
        </Card>
      )}

      {shown && pending && pending.length > 0 && (
        <Card>
          <h2 className={headingCls}>Pending invitations</h2>
          <ul className="divide-y divide-[var(--color-border)]">
            {pending.map((inv) => {
              const expired = Date.parse(inv.expiresAt) <= now;
              const when = formatDate(inv.expiresAt, locale, PORTAL_TIME_ZONE);
              return (
                <li key={inv.id} className="py-3">
                  <ResendInvitationForm
                    slug={slug}
                    organizationId={shown.id}
                    email={inv.email}
                    resend={resendInvitationAction.bind(null, slug, shown.id, inv.id)}
                    label={
                      <span className="min-w-0 break-all text-sm text-[var(--color-fg)]">
                        {inv.email}
                        <span className="block text-xs text-[var(--color-muted-fg)]">
                          {roleLabel(inv.role)}
                          {inv.invitedBy && ` · Invited by ${inv.invitedBy.email}`}
                          {expired ? ` · Expired ${when}` : ` · Expires ${when}`}
                        </span>
                      </span>
                    }
                    revoke={
                      <form action={revokeInvitationAction.bind(null, slug, shown.id, inv.id)}>
                        <ConfirmSubmit
                          variant="danger"
                          size="sm"
                          label="Revoke"
                          triggerName={`Revoke the invitation for ${inv.email}`}
                          title={`Revoke the invitation for ${inv.email}?`}
                          message={`The link sent to ${inv.email} will stop working. You can invite them again later.`}
                          confirmLabel="Revoke invitation"
                          cancelLabel="Keep it"
                          pendingLabel="Revoking…"
                        />
                      </form>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className={headingCls}>Create an organization</h2>
        <form action={createOrganizationAction.bind(null, slug)} className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">Organization name</span>
            <input name="name" type="text" required maxLength={120} autoComplete="organization" className={inputCls} />
          </label>
          <SubmitButton pendingLabel="Creating…">Create organization</SubmitButton>
        </form>
      </Card>
    </div>
  );
}
