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
  'grant-missing': 'Pick an application to grant access to.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change application access.',
  APP_GRANT_MEMBER_ONLY:
    'Grants only apply to members. Owners and admins already have full access to every application.',
};

const GRANT_ROLE_LABEL: Record<string, string> = {
  APP_ADMIN: 'App admin (full access)',
  APP_BILLING: 'Billing manager (plans, coupons, payments)',
  APP_VIEWER: 'Viewer (read-only)',
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
        title={<span id="access-heading">Application access</span>}
        description={
          <>
            A member sees only the applications granted here, at the level you pick. A new member
            starts with no grants and sees nothing, so grant them an application when they join.
            Owners and admins always see everything.
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
          title="No one has the Member role"
          description="Application access only applies to members. Owners and admins always see everything."
          action={
            canManage ? (
              <Link
                href="/team/invitations"
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              >
                Invite a member
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
            ? `${grants.length} granted app${grants.length === 1 ? '' : 's'}`
            : m.legacyWorkspaceRead
              ? 'All apps · read-only (legacy)'
              : 'No access yet'}
        </Badge>
      </div>

      {grants.length > 0 && (
        <ul className="space-y-1.5">
          {grants.map((g) => (
            <li
              key={g.applicationId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm">
                {g.applicationName}{' '}
                <span className="font-mono text-xs text-[var(--color-muted-fg)]">{g.applicationSlug}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <Badge tone={g.role === 'APP_ADMIN' ? 'warning' : 'neutral'}>{GRANT_ROLE_LABEL[g.role] ?? g.role}</Badge>
                {canManage && (
                  <ActionForm action={removeGrant.bind(null, m.membershipId, g.applicationId)}>
                    <ConfirmButton
                      confirm={`Remove ${m.email}'s ${g.role} access to ${g.applicationName}?${grants.length === 1 ? ' This is their last grant, and they will be left with access to no application at all.' : ''}`}
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
            <span className="text-xs font-medium">Application</span>
            <select name="applicationId" required className={fieldInputCls}>
              {applications.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.slug}){granted.has(a.id) ? ' · granted' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-44 flex-1 space-y-1">
            <span className="text-xs font-medium">Level</span>
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
        <span className="font-medium text-[var(--color-fg)]">Scopes</span>
        <span className="flex items-center gap-2 text-xs text-[var(--color-muted-fg)]">
          {restricted ? `Restricted to ${scopes.length} scope${scopes.length === 1 ? '' : 's'}` : 'Unrestricted'}
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
            A grant decides <em>which</em> applications; scopes decide <em>what</em> the member may do
            in them. The two only ever narrow each other.
          </p>
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
    </details>
  );
}
