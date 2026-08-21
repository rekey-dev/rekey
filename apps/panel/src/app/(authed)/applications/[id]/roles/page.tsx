/**
 * Both role catalogs, on one page.
 *
 * Rekey has two independent role systems, and they used to live on two
 * different pages under the same nav group: the application-role catalog on
 * End-users, the organization-role catalog on Organizations. That put the word
 * "roles" in two places with different meanings and no way to see the
 * difference at once, which is exactly how the two get conflated. They sit side
 * by side here, with the distinction stated once at the top, so an operator
 * deciding which one they want can read both and choose.
 *
 * End-users and Organizations keep their own pages for people and orgs; each
 * links here for role configuration.
 */

import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  errorQuery,
  readErrorFlash,
  api,
  PanelApiError,
  getApplication,
  type ApplicationRoleRow,
  type OrganizationRoleRow,
} from '@/lib/api';
import { ApiErrorText } from '@/components/api-error';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Modal } from '@/components/Modal';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const rowAction =
  'text-xs font-medium text-[var(--color-fg)] hover:underline disabled:opacity-60';
const rowDanger = 'text-xs text-red-600 dark:text-red-400 hover:underline cursor-pointer';

const pageUrl = (id: string): string => `/applications/${id}/roles`;

// ─── Application-role actions ────────────────────────────────────────

async function createAppRole(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const isDefault = formData.get('isDefault') === 'on';
  if (!name) redirect(`${pageUrl(applicationId)}?error=missing&newAppRole=1`);
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/application-roles`,
      body: { name, ...(description ? { description } : {}), isDefault },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId)}?${await errorQuery(err, { newAppRole: '1' })}`);
    }
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?appRoleCreated=${encodeURIComponent(name)}`);
}

async function setAppRoleDefault(applicationId: string, name: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/application-roles/${encodeURIComponent(name)}`,
      body: { isDefault: true },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${pageUrl(applicationId)}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?appRoleDefault=${encodeURIComponent(name)}`);
}

async function deleteAppRole(
  applicationId: string,
  name: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const reassignTo = String(formData.get('reassignTo') ?? '').trim();
  const qs = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/application-roles/${encodeURIComponent(name)}${qs}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId)}?${await errorQuery(err, { delAppRole: name })}`);
    }
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?appRoleDeleted=${encodeURIComponent(name)}`);
}

// ─── Organization-role actions ───────────────────────────────────────

async function createOrgRole(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const baseRole = String(formData.get('baseRole') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  if (!name || !baseRole) redirect(`${pageUrl(applicationId)}?error=missing&newOrgRole=1`);
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organization-roles`,
      body: { name, baseRole, ...(description ? { description } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId)}?${await errorQuery(err, { newOrgRole: '1' })}`);
    }
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?orgRoleCreated=${encodeURIComponent(name)}`);
}

async function setOrgRoleDefault(applicationId: string, name: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organization-roles/${encodeURIComponent(name)}`,
      body: { isDefault: true },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${pageUrl(applicationId)}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?orgRoleDefault=${encodeURIComponent(name)}`);
}

async function setOrgRoleDisabled(
  applicationId: string,
  name: string,
  disabled: boolean,
): Promise<void> {
  'use server';
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organization-roles/${encodeURIComponent(name)}`,
      body: { disabled },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${pageUrl(applicationId)}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(
    `${pageUrl(applicationId)}?${disabled ? 'orgRoleDisabled' : 'orgRoleEnabled'}=${encodeURIComponent(name)}`,
  );
}

async function deleteOrgRole(
  applicationId: string,
  name: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const reassignTo = String(formData.get('reassignTo') ?? '').trim();
  const qs = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organization-roles/${encodeURIComponent(name)}${qs}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId)}?${await errorQuery(err, { delOrgRole: name })}`);
    }
    throw err;
  }
  redirect(`${pageUrl(applicationId)}?orgRoleDeleted=${encodeURIComponent(name)}`);
}

// ─── Errors ──────────────────────────────────────────────────────────

const ERR: Record<string, string> = {
  missing: 'Name is required.',
  END_USER_ROLE_NAME_INVALID:
    'Role name must be 2–40 lowercase letters, digits, hyphens or underscores, starting and ending alphanumeric.',
  END_USER_ROLE_NAME_TAKEN: 'An application role with that name already exists.',
  END_USER_ROLE_NOT_FOUND: 'Role not found. It may have already been deleted.',
  END_USER_ROLE_IS_DEFAULT: 'Mark another role as the default before deleting this one.',
  END_USER_ROLE_IN_USE:
    'End-users still hold this role. Pick a role to move them to, then delete.',
  END_USER_ROLE_REASSIGN_SELF: 'Pick a different role to move holders to.',
  END_USER_ROLE_REASSIGN_TARGET_UNKNOWN: 'That target role does not exist in this application.',
  ORGANIZATIONS_NOT_ENABLED:
    'Enable organizations for this application before defining organization roles.',
  ORGANIZATION_ROLE_NAME_INVALID:
    'Role name must be 2–40 lowercase letters, digits, hyphens or underscores, starting and ending alphanumeric.',
  ORGANIZATION_ROLE_NAME_TAKEN: 'An organization role with that name already exists.',
  ORGANIZATION_ROLE_NAME_RESERVED: 'OWNER, ADMIN and MEMBER are built in. Pick a different name.',
  ORGANIZATION_ROLE_NOT_FOUND: 'Role not found. It may have already been deleted.',
  ORGANIZATION_ROLE_IS_DEFAULT: 'Mark another role as the default before deleting this one.',
  ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE: 'OWNER, ADMIN and MEMBER cannot be re-tiered or deleted.',
  ORGANIZATION_ROLE_IN_USE:
    'Members or pending invitations still hold this role. Choose a role to move them to.',
  ORGANIZATION_ROLE_REASSIGN_SELF: 'Pick a different role to move holders to.',
  ORGANIZATION_ROLE_REASSIGN_TARGET_UNKNOWN:
    'That target role does not exist in this application.',
  ORGANIZATION_ROLE_REASSIGN_DEMOTES_OWNER:
    'This role carries OWNER authority and the target does not, so organizations would be left without an owner.',
  ORGANIZATION_ROLE_RETIER_ORPHANS_OWNERS:
    'Some organization’s only owner holds this role, so disabling it or lowering its tier would leave them without one.',
  ORGANIZATION_ROLE_DISABLED: 'That role is disabled. Re-enable it, or pick another.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage roles.',
};

// ─── Page ────────────────────────────────────────────────────────────

export default async function RolesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const str = (k: string): string | undefined =>
    typeof sp[k] === 'string' ? (sp[k] as string) : undefined;
  const error = str('error');
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const newAppRoleError = sp.newAppRole === '1' ? error : undefined;
  const newOrgRoleError = sp.newOrgRole === '1' ? error : undefined;

  const [app, appRoles, orgRoles] = await Promise.all([
    getApplication(id),
    api<ApplicationRoleRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/application-roles`,
    }),
    // Readable whether or not organizations are enabled. The catalog is seeded
    // on every application, so this page can show the vocabulary and the enable
    // prompt before the feature is switched on.
    api<OrganizationRoleRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/organization-roles`,
    }),
  ]);

  const orgsEnabled = app.authConfig.organizationsEnabled === true;
  const customOrgRoles = orgRoles.filter((r) => !r.isBuiltIn);

  return (
    <div className="space-y-8">
      {/* ─── The distinction, stated once ───────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="Roles"
          description={
            <>
              Two independent role systems. Pick the one that matches the question you are
              answering, because they are not interchangeable.
            </>
          }
        />
        <div className="overflow-x-auto">
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH> </TH>
                <TH>Application role</TH>
                <TH>Organization role</TH>
              </TR>
            </THead>
            <TBody>
              <TR>
                <TD muted className="text-xs">Answers</TD>
                <TD className="text-xs">Is this person staff of your whole app?</TD>
                <TD className="text-xs">What are they inside <em>this</em> organization?</TD>
              </TR>
              <TR>
                <TD muted className="text-xs">Scope</TD>
                <TD className="text-xs">One value per end-user, app-wide</TD>
                <TD className="text-xs">One value per (organization, end-user)</TD>
              </TR>
              <TR>
                <TD muted className="text-xs">Someone in two orgs</TD>
                <TD className="text-xs">Holds one value</TD>
                <TD className="text-xs">Holds two independent values</TD>
              </TR>
              <TR>
                <TD muted className="text-xs">Enforced by Rekey</TD>
                <TD className="text-xs">No. Your app interprets it.</TD>
                <TD className="text-xs">Yes, on the tier.</TD>
              </TR>
              <TR>
                <TD muted className="text-xs">Assigned by</TD>
                <TD className="text-xs">Operators only, here or via the API</TD>
                <TD className="text-xs">Org owners and admins, from your app</TD>
              </TR>
            </TBody>
          </Table>
        </div>
      </section>

      {/* ─── Application roles ─────────────────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="Application roles"
          count={`(${appRoles.length})`}
          description={
            <>
              The catalog <code className="font-mono text-xs">EndUser.role</code> is validated
              against. New sign-ups get the{' '}
              <strong className="text-[var(--color-fg)]">default</strong> role automatically.
              End-users cannot change their own role, and Rekey never acts on the value: it is
              stored for your app to interpret. Assign one per user on{' '}
              <Link href={`/applications/${id}/end-users`} className="underline hover:no-underline">
                End-users
              </Link>
              .
            </>
          }
          action={
            <NewAppRoleModal
              applicationId={id}
              error={newAppRoleError}
              errorDetail={errorDetail}
              errorFix={errorFix}
            />
          }
        />

        {str('appRoleCreated') && (
          <SavedBanner
            params={['appRoleCreated']}
            message={`Application role ${str('appRoleCreated')} created.`}
          />
        )}
        {str('appRoleDeleted') && (
          <SavedBanner
            params={['appRoleDeleted']}
            message={`Application role ${str('appRoleDeleted')} deleted.`}
          />
        )}
        {str('appRoleDefault') && (
          <SavedBanner
            params={['appRoleDefault']}
            message={`${str('appRoleDefault')} is now the default for new sign-ups.`}
          />
        )}
        {error && !newAppRoleError && !newOrgRoleError && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}

        <Table minWidth="min-w-[40rem]">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Description</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {appRoles.map((r) => (
              <TR key={r.id} hover>
                <TD mono>
                  {r.name}
                  {r.isDefault && <Badge tone="brand">default</Badge>}
                </TD>
                <TD muted className="text-xs">{r.description ?? '—'}</TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-3">
                    {!r.isDefault && (
                      <form action={setAppRoleDefault.bind(null, id, r.name)} className="inline">
                        <SubmitButton pendingLabel="Saving…" className={rowAction}>
                          Make default
                        </SubmitButton>
                      </form>
                    )}
                    {!r.isDefault && (
                      <DeleteRoleModal
                        kind="app"
                        applicationId={id}
                        name={r.name}
                        others={appRoles.filter((o) => o.name !== r.name).map((o) => ({
                          name: o.name,
                          note: o.isDefault ? ' (default)' : '',
                        }))}
                      />
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </section>

      {/* ─── Organization roles ────────────────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="Organization roles"
          count={`(${orgRoles.length})`}
          description={
            <>
              The roles a member can hold <em>inside</em> an organization. Every role maps to a
              tier (OWNER / ADMIN / MEMBER) that Rekey enforces on; the name is yours to
              interpret, so a <code className="font-mono text-xs">content-manager</code> on the
              MEMBER tier can do exactly what MEMBER can. Your org owners assign these from your
              app with their own session, with no operator action needed.{' '}
              <strong className="text-[var(--color-fg)]">Disable</strong> is the revoke switch:
              holders are refused immediately and the role cannot be assigned, but memberships
              are kept so enabling it again restores everyone.
            </>
          }
          action={
            orgsEnabled ? (
              <NewOrgRoleModal
                applicationId={id}
                error={newOrgRoleError}
                errorDetail={errorDetail}
                errorFix={errorFix}
              />
            ) : undefined
          }
        />

        {!orgsEnabled && (
          <Banner tone="warning">
            Custom organization roles need organizations turned on for this application. The three
            built-ins below exist already and apply the moment you enable it under{' '}
            <Link href={`/applications/${id}/auth`} className="underline hover:no-underline">
              Authentication
            </Link>
            .
          </Banner>
        )}

        {str('orgRoleCreated') && (
          <SavedBanner
            params={['orgRoleCreated']}
            message={`Organization role ${str('orgRoleCreated')} created.`}
          />
        )}
        {str('orgRoleDeleted') && (
          <SavedBanner
            params={['orgRoleDeleted']}
            message={`Organization role ${str('orgRoleDeleted')} deleted.`}
          />
        )}
        {str('orgRoleDefault') && (
          <SavedBanner
            params={['orgRoleDefault']}
            message={`${str('orgRoleDefault')} is now the default organization role.`}
          />
        )}
        {str('orgRoleDisabled') && (
          <SavedBanner
            params={['orgRoleDisabled']}
            message={`${str('orgRoleDisabled')} is disabled. Everyone holding it is refused until you re-enable it.`}
          />
        )}
        {str('orgRoleEnabled') && (
          <SavedBanner
            params={['orgRoleEnabled']}
            message={`${str('orgRoleEnabled')} is enabled again.`}
          />
        )}

        <Table minWidth="min-w-[44rem]">
          <THead>
            <TR>
              <TH>Role</TH>
              <TH>Tier</TH>
              <TH>Description</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {orgRoles.map((r) => (
              <TR key={r.name} hover>
                <TD mono>
                  {r.name}
                  {r.isBuiltIn && <Badge tone="neutral">built-in</Badge>}
                  {r.isDefault && <Badge tone="brand">default</Badge>}
                  {r.disabled && <Badge tone="warning">disabled</Badge>}
                </TD>
                <TD mono className="text-xs">{r.baseRole}</TD>
                <TD muted className="text-xs">{r.description ?? '—'}</TD>
                <TD align="right">
                  <div className="flex items-center justify-end gap-3">
                    {orgsEnabled && !r.isDefault && !r.disabled && (
                      <form action={setOrgRoleDefault.bind(null, id, r.name)} className="inline">
                        <SubmitButton pendingLabel="Saving…" className={rowAction}>
                          Make default
                        </SubmitButton>
                      </form>
                    )}
                    {orgsEnabled && !r.isDefault && (
                      <form
                        action={setOrgRoleDisabled.bind(null, id, r.name, !r.disabled)}
                        className="inline"
                      >
                        <SubmitButton
                          pendingLabel="Saving…"
                          className={r.disabled ? rowAction : rowDanger}
                        >
                          {r.disabled ? 'Enable' : 'Disable'}
                        </SubmitButton>
                      </form>
                    )}
                    {orgsEnabled && !r.isBuiltIn && !r.isDefault && (
                      <DeleteRoleModal
                        kind="org"
                        applicationId={id}
                        name={r.name}
                        // An OWNER-tier role can only be reassigned to another
                        // OWNER-tier role; the API refuses anything else because
                        // it would leave organizations without an owner. Offering
                        // the rest would be a dead end discovered after submit.
                        others={orgRoles
                          .filter((o) => o.name !== r.name)
                          .filter((o) => (r.baseRole === 'OWNER' ? o.baseRole === 'OWNER' : true))
                          .map((o) => ({ name: o.name, note: ` (${o.baseRole})` }))}
                      />
                    )}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>

        {orgsEnabled && customOrgRoles.length === 0 && (
          <EmptyState
            title="No custom organization roles yet"
            description={
              <>
                The three built-ins cover most apps. Add your own when your product has vocabulary
                they do not: an agency CMS might want{' '}
                <code className="font-mono text-xs">editor</code> and{' '}
                <code className="font-mono text-xs">reviewer</code>, both on the MEMBER tier.
              </>
            }
          />
        )}
      </section>
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────

/**
 * One delete flow for both catalogs. `reassignTo` is optional: leave it blank
 * when nobody holds the role, and the API refuses with a count if that turns
 * out to be wrong. Reassign and delete run in one transaction server-side.
 */
function DeleteRoleModal({
  kind,
  applicationId,
  name,
  others,
}: {
  kind: 'app' | 'org';
  applicationId: string;
  name: string;
  others: Array<{ name: string; note: string }>;
}): React.JSX.Element {
  const action = kind === 'app' ? deleteAppRole : deleteOrgRole;
  const holders = kind === 'app' ? 'end-users' : 'members or pending invitations';
  return (
    <Modal
      modalKey={`del-${kind}-role`}
      modalValue={name}
      title={`Delete ${name}`}
      description={`If any ${holders} still hold this role, pick where they should land. They are moved and the role dropped in one transaction.`}
      trigger="Delete"
      triggerClassName={rowDanger}
    >
      <form action={action.bind(null, applicationId, name)} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-xs font-medium">Move current holders to</span>
          <select name="reassignTo" defaultValue="" className={inputCls}>
            <option value="">Nobody holds it</option>
            {others.map((o) => (
              <option key={o.name} value={o.name}>
                {o.name}
                {o.note}
              </option>
            ))}
          </select>
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Leave as is if the role is unused. If anyone still holds it the delete is refused
            rather than silently orphaning them.
          </span>
        </label>
        <SubmitButton
          pendingLabel="Deleting…"
          className="rounded-md bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Delete role
        </SubmitButton>
      </form>
    </Modal>
  );
}

function NewAppRoleModal({
  applicationId,
  error, errorDetail, errorFix,
}: {
  applicationId: string;
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="newAppRole"
      title="Add an application role"
      description="A role an end-user can hold across your whole app. One value per user, the same in every organization they belong to."
      trigger="+ New application role"
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
    >
      <form action={createAppRole.bind(null, applicationId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">
            Name<span className="text-[var(--color-primary)] ml-0.5">*</span>
          </span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            pattern="^[a-z0-9](?:[a-z0-9_\-]{0,38}[a-z0-9])?$"
            placeholder="admin"
            className={`${inputCls} font-mono`}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Lowercase letters, digits, hyphens, underscores (2 to 40 characters).
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Description (optional)</span>
          <input
            type="text"
            name="description"
            maxLength={240}
            placeholder="Full access including billing"
            className={inputCls}
          />
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="isDefault"
            className="h-4 w-4 rounded border-[var(--color-border)]"
          />
          <span className="text-xs">Make this the default role for new sign-ups</span>
        </label>
        <SubmitButton pendingLabel="Adding role…">Add role</SubmitButton>
      </form>
    </Modal>
  );
}

function NewOrgRoleModal({
  applicationId,
  error, errorDetail, errorFix,
}: {
  applicationId: string;
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="newOrgRole"
      title="Add an organization role"
      description="A name your app understands, mapped to a tier Rekey enforces. Members hold this per organization, so the same person can be an editor in one and an owner in another."
      trigger="+ New organization role"
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
    >
      <form action={createOrgRole.bind(null, applicationId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">
            Name<span className="text-[var(--color-primary)] ml-0.5">*</span>
          </span>
          <input
            type="text"
            name="name"
            required
            autoFocus
            pattern="^[a-z0-9](?:[a-z0-9_\-]{0,38}[a-z0-9])?$"
            placeholder="content-manager"
            className={`${inputCls} font-mono`}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Lowercase letters, digits, hyphens, underscores. OWNER, ADMIN and MEMBER are reserved.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">
            Tier<span className="text-[var(--color-primary)] ml-0.5">*</span>
          </span>
          <select name="baseRole" defaultValue="MEMBER" required className={inputCls}>
            <option value="MEMBER">MEMBER (read-only)</option>
            <option value="ADMIN">ADMIN (manages members below OWNER)</option>
            <option value="OWNER">OWNER (full control, including ownership transfer)</option>
          </select>
          <span className="block text-xs text-[var(--color-muted-fg)]">
            What this role can actually do. Rekey checks the tier, never the name, so your app
            decides what the name means beyond that.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Description (optional)</span>
          <input
            type="text"
            name="description"
            maxLength={240}
            placeholder="Drafts and edits content, cannot publish"
            className={inputCls}
          />
        </label>
        <SubmitButton pendingLabel="Creating role…">Create role</SubmitButton>
      </form>
    </Modal>
  );
}
