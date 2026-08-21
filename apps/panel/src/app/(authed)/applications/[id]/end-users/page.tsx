import * as React from 'react';
import Link from 'next/link';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import { ApiErrorText } from '@/components/api-error';
import type { Page } from '@/lib/paginate';
import { redirect } from 'next/navigation';
import { errorQuery, readErrorFlash, api, PanelApiError, type EndUserRow, type ApplicationRoleRow, type OrganizationRow } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD, readSort, sortToggleHref } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

// ─── End-user actions ────────────────────────────────────────────────

async function createUser(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const role = String(formData.get('role') ?? '').trim();
  const metadataRaw = String(formData.get('metadata') ?? '').trim();
  const emailVerified = formData.get('emailVerified') === 'on';

  if (!email) redirect(`/applications/${applicationId}/end-users?error=missing&newUser=1`);

  let metadata: unknown = undefined;
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw);
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        redirect(`/applications/${applicationId}/end-users?error=metadata_not_object&newUser=1`);
      }
    } catch {
      redirect(`/applications/${applicationId}/end-users?error=metadata_invalid_json&newUser=1`);
    }
  }

  const organizationId = String(formData.get('organizationId') ?? '').trim();
  const orgRole = String(formData.get('orgRole') ?? 'MEMBER');

  let created: { id: string };
  try {
    created = await api<{ id: string }>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users`,
      body: {
        email,
        ...(password ? { password } : {}),
        ...(role ? { role } : {}),
        emailVerified,
        ...(metadata !== undefined ? { metadata } : {}),
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/end-users?${await errorQuery(err, { newUser: '1' })}`);
    }
    throw err;
  }

  // Optional: drop the freshly-created user into an organization. The user is
  // already created at this point, so an org-add failure surfaces as a warning
  // (we don't roll back the user).
  if (organizationId) {
    try {
      await api({
        method: 'POST',
        path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organizations/${encodeURIComponent(organizationId)}/members`,
        body: { endUserId: created.id, role: orgRole },
      });
    } catch (err) {
      if (err instanceof PanelApiError) {
        redirect(
          `/applications/${applicationId}/end-users?created=${encodeURIComponent(email)}&orgError=${encodeURIComponent(err.code)}`,
        );
      }
      throw err;
    }
  }
  redirect(`/applications/${applicationId}/end-users?created=${encodeURIComponent(email)}`);
}

async function updateUser(applicationId: string, euid: string, formData: FormData): Promise<void> {
  'use server';
  const role = String(formData.get('role') ?? '').trim();
  const metadataRaw = String(formData.get('metadata') ?? '').trim();
  const emailVerified = formData.get('emailVerified') === 'on';

  let metadata: unknown = undefined;
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw);
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        redirect(`/applications/${applicationId}/end-users?error=metadata_not_object&editUser=${euid}`);
      }
    } catch {
      redirect(`/applications/${applicationId}/end-users?error=metadata_invalid_json&editUser=${euid}`);
    }
  } else {
    metadata = null;
  }

  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}`,
      body: { role, emailVerified, metadata },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/end-users?${await errorQuery(err, { editUser: euid })}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/end-users?updated=${encodeURIComponent(euid)}`);
}

async function deleteUser(applicationId: string, euid: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}`,
  });
  redirect(`/applications/${applicationId}/end-users`);
}

// ─── Errors ─────────────────────────────────────────────────────────

const ERR: Record<string, string> = {
  missing: 'Required fields are empty.',
  metadata_invalid_json: 'Metadata must be valid JSON.',
  metadata_not_object: 'Metadata must be a JSON object (not an array or primitive).',
  EMAIL_ALREADY_EXISTS: 'An end-user with that email already exists in this Application.',
  END_USER_NOT_FOUND: 'End-user not found.',
  END_USER_ROLE_UNKNOWN: 'That role is not in the catalog. Pick an existing role or add it first.',
  END_USER_ROLE_NAME_TAKEN: 'A role with that name already exists.',
  END_USER_ROLE_NAME_INVALID:
    'Role name must be lowercase letters, digits, hyphens, or underscores (2–40 chars).',
  END_USER_ROLE_NOT_FOUND: 'Role not found.',
  END_USER_ROLE_IS_DEFAULT: 'Cannot delete the default role. Mark another as default first.',
  END_USER_ROLE_IN_USE: 'Cannot delete — end-users still hold this role. Reassign them first.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage end-users + roles.',
  ORGANIZATIONS_NOT_ENABLED: 'organizations are not enabled for this Application',
  ORGANIZATION_NOT_FOUND: 'the organization no longer exists',
  ORGANIZATION_ALREADY_MEMBER: 'they are already a member of that organization',
};

// ─── Page ───────────────────────────────────────────────────────────

export default async function EndUsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const search = typeof sp.search === 'string' ? sp.search.trim() : '';
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const newUserError = sp.newUser === '1' ? error : undefined;
  const newRoleError = sp.newRole === '1' ? error : undefined;
  const editUser = typeof sp.editUser === 'string' ? sp.editUser : undefined;
  const deleteRoleName = typeof sp.deleteRole === 'string' ? sp.deleteRole : undefined;
  const orgError = typeof sp.orgError === 'string' ? sp.orgError : undefined;
  const createdEmail = typeof sp.created === 'string' ? sp.created : undefined;

  const verified =
    sp.verified === 'true' ? 'true' : sp.verified === 'false' ? 'false' : '';
  const SUB_STATUSES = ['PENDING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] as const;
  const subscription =
    typeof sp.subscription === 'string' &&
    (SUB_STATUSES as readonly string[]).includes(sp.subscription)
      ? sp.subscription
      : '';
  const filtered = Boolean(search || verified || subscription);

  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  const sorted = readSort(sp, ['email', 'createdAt'] as const);
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (verified) qs.set('emailVerified', verified);
  if (subscription) qs.set('subscriptionStatus', subscription);
  if (sorted) {
    qs.set('sort', sorted.sort);
    qs.set('order', sorted.order);
  }
  qs.set('limit', String(PAGE_SIZE));
  if (offset) qs.set('offset', String(offset));

  const filterParams: Record<string, string> = {
    ...(search ? { search } : {}),
    ...(verified ? { verified } : {}),
    ...(subscription ? { subscription } : {}),
  };
  const basePath = `/applications/${id}/end-users`;
  // Sort links preserve filters + page size; offset resets on re-sort.
  const sortTH = (column: 'email' | 'createdAt') =>
    sortToggleHref({
      basePath,
      column,
      current: sorted,
      extraParams: {
        ...filterParams,
        ...(PAGE_SIZE !== DEFAULT_PAGE_SIZE ? { ps: String(PAGE_SIZE) } : {}),
      },
    });

  const [usersPage, roles, orgsPage] = await Promise.all([
    api<Page<EndUserRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?${qs.toString()}`,
    }),
    // Role catalog, for the role pickers in the new-user and edit-user modals.
    // Managing the catalog itself moved to the Roles tab. Bare array: this
    // endpoint is not paginated.
    api<ApplicationRoleRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/application-roles`,
    }),
    // Organization picker for the new-user modal — first page only, never paged.
    api<Page<OrganizationRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/organizations`,
    }),
  ]);
  const { items: users, page } = usersPage;
  const organizations = orgsPage.items;

  return (
    <div className="space-y-8">
      {orgError && (
        <Banner tone="warning">
          End-user{createdEmail ? ` ${createdEmail}` : ''} was created, but adding them to the
          organization failed ({ERR[orgError] ?? 'something went wrong'}). Add them manually from the
          Organizations tab.
        </Banner>
      )}

      {/* ─── End-users section ─────────────────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="End-users"
          count={`(${users.length === 0 ? 0 : `${offset + 1}–${offset + users.length}`})`}
          description={
            <>
              The people who sign up to your app — manage roles, metadata, billing, and org
              membership. Created via the SDK&apos;s sign-up endpoint or seeded manually here; role +
              metadata are writable only by operators, so end-users can&apos;t elevate via the SDK.
            </>
          }
          action={
            <NewUserModal applicationId={id} roles={roles} organizations={organizations} error={newUserError} errorDetail={errorDetail} errorFix={errorFix} />
          }
        />

        <form className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Search by email…"
            className="w-full max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
          <select
            name="verified"
            defaultValue={verified}
            aria-label="Filter by email verification"
            className={filterSelectCls}
          >
            <option value="">Verified: any</option>
            <option value="true">Verified only</option>
            <option value="false">Unverified only</option>
          </select>
          <select
            name="subscription"
            defaultValue={subscription}
            aria-label="Filter by subscription status"
            className={filterSelectCls}
          >
            <option value="">Subscription: any</option>
            {SUB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
          >
            Apply
          </button>
          {filtered && (
            <a
              href={`/applications/${id}/end-users`}
              className="text-sm text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
            >
              filtered — clear
            </a>
          )}
        </form>

        {users.length === 0 ? (
          <EmptyState
            title={
              search
                ? `No end-users matching "${search}"`
                : filtered
                  ? 'No end-users match these filters'
                  : 'No end-users yet'
            }
            description={
              <>
                End-users sign up via your application using the Rekey SDKs, or you can seed them
                manually with the &quot;+ New end-user&quot; button.
              </>
            }
          />
        ) : (
          <Table minWidth="min-w-[52rem]">
            <THead>
              <TR>
                <TH sort={sortTH('email')}>Email</TH>
                <TH>Role</TH>
                <TH>Verified</TH>
                <TH>User ID</TH>
                <TH sort={sortTH('createdAt')}>Joined</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {users.map((u) => (
                <TR key={u.id} hover>
                  <TD>
                    {u.email}
                  </TD>
                  <TD>
                    <Badge tone="neutral" mono>{u.role}</Badge>
                  </TD>
                  <TD>
                    {u.emailVerified ? (
                      <Badge tone="success" dot>verified</Badge>
                    ) : (
                      <Badge tone="warning" dot>pending</Badge>
                    )}
                  </TD>
                  <TD mono muted className="max-w-[12rem] truncate" title={u.id}>{u.id}</TD>
                  <TD muted className="text-xs">
                    {formatDate(u.createdAt)}
                  </TD>
                  <TD align="right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/applications/${id}/end-users/${u.id}`}
                        className="text-xs font-medium text-[var(--color-fg)] hover:underline"
                      >
                        Details
                      </Link>
                      <EditUserModal
                        applicationId={id}
                        user={u}
                        roles={roles}
                        error={editUser === u.id ? error : undefined}
                        errorDetail={errorDetail}
                        errorFix={errorFix}
                      />
                      <form action={deleteUser.bind(null, id, u.id)} className="inline">
                        <TypedConfirmButton
                          expected={u.email}
                          title={`Delete ${u.email}?`}
                          description="This permanently removes the end-user along with their subscriptions, refresh tokens, OAuth links, and licenses. This cannot be undone."
                          triggerLabel="Delete"
                          confirmLabel="Delete end-user"
                        />
                      </form>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        <Pager
          basePath={basePath}
          offset={offset}
          pageSize={PAGE_SIZE}
          count={users.length}
          hasMore={page.hasMore}
          extraParams={
            filtered || sorted
              ? {
                  ...filterParams,
                  ...(sorted ? { sort: sorted.sort, order: sorted.order } : {}),
                }
              : undefined
          }
        />
      </section>
    </div>
  );
}

// ─── Modals ─────────────────────────────────────────────────────────

function NewUserModal({
  applicationId,
  roles,
  organizations,
  error, errorDetail, errorFix,
}: {
  applicationId: string;
  roles: ApplicationRoleRow[];
  organizations: OrganizationRow[];
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  const defaultRoleName = roles.find((r) => r.isDefault)?.name ?? roles[0]?.name ?? 'user';
  return (
    <Modal
      modalKey="newUser"
      title="Create end-user"
      description="Operator-driven creation. The SDK's auth.signUp() is the normal path; this is for support seeding / data migrations. Email is verified by default since you vouched."
      trigger="+ New end-user"
    >
      <form action={createUser.bind(null, applicationId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        <Field label="Email" required>
          <input type="email" name="email" required autoFocus className={inputCls} />
        </Field>
        <Field
          label="Password"
          hint="Optional. If omitted, the user can sign in via OAuth or by hitting the password-reset flow."
        >
          <input type="password" name="password" minLength={8} autoComplete="new-password" className={inputCls} />
        </Field>
        <Field
          label="Role"
          hint="Pick from the catalog above. Default is pre-selected."
        >
          <select name="role" defaultValue={defaultRoleName} className={inputCls}>
            {roles.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name}{r.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Metadata (JSON object)"
          hint='Custom per-user data your app stores: display name, avatar URL, feature flags. e.g. {"name":"Alice","tier":"pro"}'
        >
          <textarea
            name="metadata"
            rows={4}
            placeholder='{"name":"Alice"}'
            className={`${inputCls} font-mono`}
          />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="emailVerified" defaultChecked className="h-4 w-4 rounded border-[var(--color-border)]" />
          <span className="text-xs">Mark email as verified</span>
        </label>
        {organizations.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-3">
            <Field label="Add to organization" hint="Optional — drops the new user into a team.">
              <select name="organizationId" defaultValue="" className={inputCls}>
                <option value="">— None —</option>
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Org role">
              <select name="orgRole" defaultValue="MEMBER" className={inputCls}>
                <option value="OWNER">OWNER</option>
                <option value="ADMIN">ADMIN</option>
                <option value="MEMBER">MEMBER</option>
              </select>
            </Field>
          </div>
        )}
        <SubmitButton pendingLabel="Creating end-user…">Create end-user</SubmitButton>
      </form>
    </Modal>
  );
}

function EditUserModal({
  applicationId,
  user,
  roles,
  error, errorDetail, errorFix,
}: {
  applicationId: string;
  user: EndUserRow;
  roles: ApplicationRoleRow[];
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  const metadataDefault = user.metadata ? JSON.stringify(user.metadata, null, 2) : '';
  return (
    <Modal
      modalKey="editUser"
      modalValue={user.id}
      title={`Edit ${user.email}`}
      description="Email is immutable — it's the natural key per-Application. Use password-reset to change a password. Metadata replaces wholesale (no deep merge)."
      trigger="Edit"
      triggerClassName="text-xs text-[var(--color-fg)] font-medium hover:underline cursor-pointer"
    >
      <form action={updateUser.bind(null, applicationId, user.id)} className="space-y-3">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        <Field
          label="Role"
          hint="Pick from the role catalog. Add or edit roles on the Roles tab."
        >
          <select name="role" defaultValue={user.role} required className={inputCls}>
            {roles.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name}{r.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Metadata (JSON object)"
          hint="Empty input clears metadata. Otherwise replaces the whole object."
        >
          <textarea
            name="metadata"
            rows={6}
            defaultValue={metadataDefault}
            placeholder='{"name":"Alice"}'
            className={`${inputCls} font-mono`}
          />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            name="emailVerified"
            defaultChecked={user.emailVerified}
            className="h-4 w-4 rounded border-[var(--color-border)]"
          />
          <span className="text-xs">Email verified</span>
        </label>
        <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
      </form>
    </Modal>
  );
}

// ─── Field primitive ────────────────────────────────────────────────

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/** Compact select used in the list-filter row (auto width, same chrome). */
const filterSelectCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium">
        {label}
        {required && <span className="text-[var(--color-primary)] ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
