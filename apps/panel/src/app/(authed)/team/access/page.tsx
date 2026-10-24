import * as React from 'react';
import { redirect } from 'next/navigation';
import Link from '@/components/Link';
import { DOMAIN_LABEL, SCOPE_DOMAINS, levelFor } from '@/lib/operator-scopes';
import {
  api,
  errorQuery,
  getMe,
  PanelApiError,
  readErrorFlash,
  unlessBusy,
  type ApplicationRow,
  type MemberRow,
} from '@/lib/api';
import { emptyPage, type Page } from '@/lib/paginate';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { SectionHeader } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { fieldInputCls } from '@/components/Field';
import { savedStateKey } from '@/lib/saved-state-key';
import { APP_GRANT_LABEL, type AppGrantRole } from '@/lib/workspace-roles';

async function setGrant(membershipId: string, formData: FormData): Promise<void> {
  'use server';
  const applicationId = String(formData.get('applicationId') ?? '');
  const role = String(formData.get('appRole') ?? 'APP_VIEWER');
  if (!applicationId) redirect('/team/access?error=grant-missing');
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}/grants`,
      body: { applicationId, role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`/team/access?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team/access');
}

async function removeGrant(membershipId: string, applicationId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/workspace/members/${encodeURIComponent(membershipId)}/grants/${encodeURIComponent(applicationId)}`,
  });
  redirect('/team/access');
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
    if (err instanceof PanelApiError) redirect(`/team/access?${await errorQuery(err)}`);
    throw err;
  }
  redirect('/team/access');
}

const ERR: Record<string, string> = {
  'grant-missing': 'Pick an app first.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change application access.',
  APP_GRANT_MEMBER_ONLY:
    'Grants only apply to members. Owners and admins already have full access to every application.',
};

const GRANT_ROLE_HINT: Record<string, string> = {
  APP_VIEWER: 'View only: can look at users, payments and settings, but change nothing.',
  APP_BILLING: 'Billing and payments: can manage plans, coupons, refunds and subscriptions.',
  APP_ADMIN: 'Full access: can change anything in the app, including its settings and keys.',
};

export default async function TeamAccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const [me, memberPage] = await Promise.all([
    getMe(),
    api<Page<MemberRow>>({ method: 'GET', path: '/api/v1/tenant/workspace/members' }),
  ]);
  const canManage = me.activeRole === 'OWNER' || me.activeRole === 'ADMIN';
  // The grants picker. Degrades to an empty picker rather than failing the page.
  const applications = canManage
    ? (
        await api<Page<ApplicationRow>>({
          method: 'GET',
          path: '/api/v1/tenant/applications/?limit=100&offset=0',
        }).catch(unlessBusy(() => emptyPage<ApplicationRow>(100)))
      ).items
    : [];
  const memberRows = memberPage.items.filter((m) => m.role === 'MEMBER');

  return (
    <section className="space-y-4" aria-labelledby="access-heading">
      <SectionHeader
        title={<span id="access-heading">App access</span>}
        description={
          <>
            Choose which apps each member can use, and how much they can do there. A new member starts
            with no apps. Owners and admins always have every app, so they are not listed here.
          </>
        }
      />
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
        </Banner>
      )}
      {memberRows.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No members yet"
          description="App access is for people with the Member role. Owners and admins already see every app."
          action={
            canManage ? (
              <Link
                href="/team?newInvite=1"
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                Invite someone
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {memberRows.map((m) => (
            <MemberAccessCard
              key={m.membershipId}
              member={m}
              isSelf={m.tenantUserId === me.user.id}
              canManage={canManage}
              applications={applications}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemberAccessCard({
  member: m,
  isSelf,
  canManage,
  applications,
}: {
  member: MemberRow;
  isSelf: boolean;
  canManage: boolean;
  applications: ApplicationRow[];
}): React.JSX.Element {
  const grants = m.grants ?? [];
  const granted = new Set(grants.map((g) => g.applicationId));
  return (
    <li className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-[var(--color-fg)]">
          {m.email}
          {isSelf && <span className="ml-1.5 text-xs font-normal text-[var(--color-muted-fg)]">(you)</span>}
        </p>
        {/* Zero grants is no access at all (#326), unless the API flags the
            membership as grandfathered. Saying "all apps" for a member who
            can see none of them is the one thing an owner must not be told. */}
        <Badge tone={grants.length > 0 ? 'success' : m.legacyWorkspaceRead ? 'warning' : 'neutral'}>
          {grants.length > 0
            ? `${grants.length} app${grants.length === 1 ? '' : 's'}`
            : m.legacyWorkspaceRead
              ? 'Every app, view only'
              : 'No apps yet'}
        </Badge>
      </div>

      {grants.length > 0 && (
        <ul className="space-y-1.5">
          {grants.map((g) => (
            <li
              key={g.applicationId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm">{g.applicationName}</span>
              <span className="flex shrink-0 items-center gap-3">
                <Badge tone={g.role === 'APP_ADMIN' ? 'warning' : 'neutral'}>{APP_GRANT_LABEL[g.role as AppGrantRole] ?? g.role}</Badge>
                {canManage && (
                  <ActionForm action={removeGrant.bind(null, m.membershipId, g.applicationId)}>
                    <ConfirmButton
                      title={`Remove ${g.applicationName} for ${m.email}?`}
                      confirm={`They will no longer see ${g.applicationName}.${grants.length === 1 ? ' It is their only app, so they will be left with nothing to work on.' : ''}`}
                      confirmLabel="Remove access"
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

      {canManage && applications.length > 0 && (
        <ActionForm
          action={setGrant.bind(null, m.membershipId)}
          className="flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4"
        >
          <label className="block min-w-44 flex-1 space-y-1">
            <span className="text-xs font-medium">App</span>
            <select name="applicationId" required className={fieldInputCls}>
              {applications.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}{granted.has(a.id) ? ' (has access, choosing changes it)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-44 flex-1 space-y-1">
            <span className="text-xs font-medium">What they can do</span>
            <select name="appRole" defaultValue="APP_VIEWER" className={fieldInputCls}>
              {(['APP_VIEWER', 'APP_BILLING', 'APP_ADMIN'] as const).map((r) => (
                <option key={r} value={r}>
                  {APP_GRANT_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <SubmitButton
            pendingLabel="Granting…"
            className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
          >
            Give access
          </SubmitButton>
          <ul className="basis-full space-y-0.5 text-[11px] text-[var(--color-muted-fg)]">
            {(['APP_VIEWER', 'APP_BILLING', 'APP_ADMIN'] as const).map((r) => (
              <li key={r}>{GRANT_ROLE_HINT[r]}</li>
            ))}
          </ul>
        </ActionForm>
      )}

      {canManage && <ScopeEditor membershipId={m.membershipId} scopes={m.scopes ?? null} />}
    </li>
  );
}

/**
 * What this member may do inside the applications they are granted. Folded
 * away by default: most members are unrestricted, and nine selects per member
 * buried the grant controls above them. The summary line says which state the
 * member is in without opening it.
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
    <details className="group rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
        <span className="font-medium text-[var(--color-fg)]">Advanced: limit what they can do</span>
        <span className="flex items-center gap-2 text-xs text-[var(--color-muted-fg)]">
          {restricted ? `Limited to ${scopes.length} area${scopes.length === 1 ? '' : 's'}` : 'No extra limits'}
          <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
        </span>
      </summary>
      <ActionForm
        key={savedStateKey(scopes)}
        action={setScopes.bind(null, membershipId)}
        className="space-y-3 border-t border-[var(--color-border)] px-3 py-3"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-xs text-[var(--color-muted-fg)]">
            Most teams never need this. The list above decides <em>which</em> apps they see; this
            narrows <em>what</em> they can do inside them, area by area.
          </p>
          <label className="flex shrink-0 items-center gap-2 text-xs">
            <input type="checkbox" name="restricted" defaultChecked={restricted} />
            Turn on limits
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
          While limits are off, the choices above are ignored. Inviting people, changing roles and
          deleting users always stay with owners and admins.
        </p>
        <SubmitButton
          pendingLabel="Saving…"
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
        >
          Save limits
        </SubmitButton>
      </ActionForm>
    </details>
  );
}
