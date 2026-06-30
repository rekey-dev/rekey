import * as React from 'react';
import { getWorkspaceContext } from '@/lib/session';
import { relipay } from '@/lib/relipay';
import { AppShell } from '@/components/app-shell';
import { Banner } from '@/components/banner';
import { CopyField } from '@/components/copy-field';
import { createOrgAction, switchOrgAction, inviteMemberAction } from '@/lib/actions';
import type { OrganizationWithRoleDto, OrganizationMemberDto } from '@relipay/node';

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const inviteToken = typeof params.token === 'string' && params.invited === '1' ? params.token : undefined;
  const status =
    params.created === '1'
      ? 'Team created — you are now acting as this team.'
      : params.switched === '1'
        ? 'Workspace switched.'
        : params.invited === '1'
          ? 'Invitation created.'
          : undefined;

  const ctx = await getWorkspaceContext();
  const { session, entitlements, activeOrgId, config } = ctx;
  const orgRequired = config.billingSubject === 'org';

  const orgs: OrganizationWithRoleDto[] = await relipay.organizations
    .listMine(session.accessToken)
    .catch(() => []);

  let members: OrganizationMemberDto[] = [];
  if (activeOrgId) {
    members = await relipay.organizations.listMembers(session.accessToken, activeOrgId).catch(() => []);
  }

  return (
    <AppShell
      active="team"
      email={session.user.email}
      workspaceLabel={ctx.workspaceLabel}
      planLabel={ctx.planLabel}
      isPro={entitlements.isPro}
    >
      <Banner error={error} status={status} />

      <section>
        <h1 className="text-xl font-semibold">Team</h1>
        <p className="text-sm text-neutral-500">
          {orgRequired
            ? 'This application bills per team — billing, usage and features draw from the active team’s shared pool.'
            : 'Create or switch to a team to pool billing, usage and features across members.'}
        </p>
      </section>

      {inviteToken && (
        <div className="card">
          <h3 className="font-semibold">Invitation token</h3>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            A real app would email this. The invitee accepts it via{' '}
            <code>relipay.organizations.acceptInvitation</code>.
          </p>
          <div className="mt-2">
            <CopyField label="Invite token" value={inviteToken} />
          </div>
        </div>
      )}

      <section className="card">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">My teams</h3>
        </div>
        <div className="mt-3 space-y-2">
          {orgs.length === 0 ? (
            <p className="text-sm text-neutral-500">No teams yet — create one below.</p>
          ) : (
            orgs.map((o) => {
              const isActive = o.id === activeOrgId;
              return (
                <div key={o.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
                  <span className="font-medium">{o.name}</span>
                  <span className="pill">{o.role}</span>
                  {isActive ? (
                    <span className="pill pill-pro ml-auto">active</span>
                  ) : (
                    <form action={switchOrgAction} className="ml-auto">
                      <input type="hidden" name="orgId" value={o.id} />
                      <button type="submit" className="btn-ghost">Switch</button>
                    </form>
                  )}
                </div>
              );
            })
          )}
        </div>

        {activeOrgId && !orgRequired && (
          <form action={switchOrgAction} className="mt-3">
            <input type="hidden" name="orgId" value="" />
            <button type="submit" className="btn-ghost">Leave team — back to Personal</button>
          </form>
        )}

        <form action={createOrgAction} className="mt-4 flex gap-2">
          <input name="name" placeholder="New team name" className="field" required />
          <button type="submit" className="btn shrink-0">Create team</button>
        </form>
      </section>

      {activeOrgId && (
        <section className="card">
          <h3 className="font-semibold">Members</h3>
          <div className="mt-3 space-y-2">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-sm">
                <span>{m.email}</span>
                <span className="pill ml-auto">{m.role}</span>
              </div>
            ))}
          </div>

          <form action={inviteMemberAction} className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <input type="hidden" name="orgId" value={activeOrgId} />
            <input name="email" type="email" placeholder="teammate@example.com" className="field" required />
            <select name="role" className="field sm:w-32" defaultValue="MEMBER">
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
              <option value="OWNER">Owner</option>
            </select>
            <button type="submit" className="btn shrink-0">Send invite</button>
          </form>
        </section>
      )}
    </AppShell>
  );
}
