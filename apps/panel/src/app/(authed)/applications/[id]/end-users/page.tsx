import * as React from 'react';
import Link from 'next/link';
import { Pager, readPageSize, DEFAULT_PAGE_SIZE } from '@/components/Pager';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  api,
  PanelApiError,
  type EndUserRow,
  type EndUserRoleRow,
  type OrganizationRow,
} from '@/lib/api';
import { Modal } from '@/components/Modal';
import { ConfirmButton } from '@/components/ConfirmButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD, readSort, sortToggleHref } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';

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
      redirect(`/applications/${applicationId}/end-users?error=${encodeURIComponent(err.code)}&newUser=1`);
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
        revalidatePath(`/applications/${applicationId}/end-users`);
        redirect(
          `/applications/${applicationId}/end-users?created=${encodeURIComponent(email)}&orgError=${encodeURIComponent(err.code)}`,
        );
      }
      throw err;
    }
  }
  revalidatePath(`/applications/${applicationId}/end-users`);
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
      redirect(`/applications/${applicationId}/end-users?error=${encodeURIComponent(err.code)}&editUser=${euid}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/end-users`);
  redirect(`/applications/${applicationId}/end-users?updated=${encodeURIComponent(euid)}`);
}

async function deleteUser(applicationId: string, euid: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-users/${encodeURIComponent(euid)}`,
  });
  revalidatePath(`/applications/${applicationId}/end-users`);
  redirect(`/applications/${applicationId}/end-users`);
}

// ─── Role-catalog actions ────────────────────────────────────────────

async function createRole(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const isDefault = formData.get('isDefault') === 'on';
  if (!name) redirect(`/applications/${applicationId}/end-users?error=missing&newRole=1`);
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-user-roles`,
      body: { name, ...(description ? { description } : {}), isDefault },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/end-users?error=${encodeURIComponent(err.code)}&newRole=1`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/end-users`);
  redirect(`/applications/${applicationId}/end-users?roleCreated=${encodeURIComponent(name)}`);
}

async function setRoleDefault(applicationId: string, name: string): Promise<void> {
  'use server';
  await api({
    method: 'PATCH',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-user-roles/${encodeURIComponent(name)}`,
    body: { isDefault: true },
  });
  revalidatePath(`/applications/${applicationId}/end-users`);
  redirect(`/applications/${applicationId}/end-users`);
}

async function deleteRole(applicationId: string, name: string, formData: FormData): Promise<void> {
  'use server';
  const reassignTo = String(formData.get('reassignTo') ?? '').trim();
  const qs = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/end-user-roles/${encodeURIComponent(name)}${qs}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/end-users?error=${encodeURIComponent(err.code)}&deleteRole=${encodeURIComponent(name)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/end-users`);
  redirect(`/applications/${applicationId}/end-users?roleDeleted=${encodeURIComponent(name)}`);
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

  const [users, roles, organizations] = await Promise.all([
    api<EndUserRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?${qs.toString()}`,
    }),
    api<EndUserRoleRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-user-roles`,
    }),
    api<OrganizationRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/organizations`,
    }),
  ]);

  return (
    <div className="space-y-8">
      {orgError && (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
        >
          End-user{createdEmail ? ` ${createdEmail}` : ''} was created, but adding them to the
          organization failed ({ERR[orgError] ?? orgError}). Add them manually from the
          Organizations tab.
        </p>
      )}

      {/* ─── Roles section ─────────────────────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="Roles"
          count={`(${roles.length})`}
          description={
            <>
              The catalog of roles end-users can hold. New sign-ups get the
              <strong className="text-[var(--color-fg)]"> default</strong> role automatically.
              End-users can&apos;t change their own role — only operators can, via the panel.
            </>
          }
          action={<NewRoleModal applicationId={id} error={newRoleError} />}
        />

        <Table minWidth="min-w-[40rem]">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Description</TH>
              <TH>Default</TH>
              <TH>Holders</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {roles.map((r) => {
              const holders = users.filter((u) => u.role === r.name).length;
              return (
                <TR key={r.id} hover>
                  <TD mono>{r.name}</TD>
                  <TD muted className="text-xs">{r.description ?? '—'}</TD>
                  <TD className="text-xs">
                    {r.isDefault ? (
                      <Badge tone="brand">★ default</Badge>
                    ) : (
                      <form action={setRoleDefault.bind(null, id, r.name)}>
                        <SubmitButton
                          pendingLabel="Saving…"
                          className="text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline disabled:opacity-60"
                        >
                          Make default
                        </SubmitButton>
                      </form>
                    )}
                  </TD>
                  <TD muted className="text-xs">{holders}</TD>
                  <TD align="right">
                    {r.isDefault ? (
                      <span className="text-xs text-[var(--color-faint-fg)]">(default)</span>
                    ) : (
                      <DeleteRoleControl
                        applicationId={id}
                        role={r}
                        holders={holders}
                        allRoles={roles}
                        error={deleteRoleName === r.name ? error : undefined}
                      />
                    )}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </section>

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
            <NewUserModal applicationId={id} roles={roles} organizations={organizations} error={newUserError} />
          }
        />

        <form className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="search"
            defaultValue={search}
            placeholder="Search by email…"
            className="w-full max-w-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]"
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
                End-users sign up via your application using the ReliPay SDKs, or you can seed them
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
                    <span className="inline-flex items-center gap-1.5">
                      {u.email}
                      {/* Test/live isolation: flag sandbox users (rp_test_* sign-ups). */}
                      {u.mode === 'TEST' && <Badge tone="info">TEST</Badge>}
                    </span>
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

/**
 * Per-row "Delete role" control. If nobody holds the role, renders a plain
 * ConfirmButton. If users hold it, opens a Modal that asks the operator to
 * pick a target role for bulk reassignment — atomic on the server.
 */
function DeleteRoleControl({
  applicationId,
  role,
  holders,
  allRoles,
  error,
}: {
  applicationId: string;
  role: EndUserRoleRow;
  holders: number;
  allRoles: EndUserRoleRow[];
  error?: string;
}): React.JSX.Element {
  if (holders === 0) {
    return (
      <form action={deleteRole.bind(null, applicationId, role.name)} className="inline">
        <ConfirmButton confirm={`Delete role "${role.name}"? It's removed from the catalog immediately and can no longer be assigned. This cannot be undone.`}>Delete</ConfirmButton>
      </form>
    );
  }
  const others = allRoles.filter((r) => r.name !== role.name);
  const defaultTarget = others.find((r) => r.isDefault) ?? others[0];
  return (
    <Modal
      modalKey={`deleteRole_${role.name}`}
      title={`Delete "${role.name}"?`}
      description={`${holders} end-user${holders === 1 ? '' : 's'} currently hold this role. Pick a role to move them to — the reassign + delete happens in one transaction.`}
      trigger="Delete"
      triggerClassName="text-xs text-red-600 dark:text-red-400 hover:underline cursor-pointer"
    >
      <form action={deleteRole.bind(null, applicationId, role.name)} className="space-y-3">
        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
        )}
        <Field
          label="Reassign holders to"
          required
          hint={`All ${holders} user${holders === 1 ? '' : 's'} currently with role "${role.name}" will be moved to the role you pick.`}
        >
          <select name="reassignTo" required defaultValue={defaultTarget?.name ?? ''} className={inputCls}>
            {others.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name}{r.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <SubmitButton
          pendingLabel="Deleting…"
          className="rounded-md bg-red-600 hover:bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          Reassign &amp; delete
        </SubmitButton>
      </form>
    </Modal>
  );
}

function NewRoleModal({
  applicationId,
  error,
}: {
  applicationId: string;
  error?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="newRole"
      title="Add a role"
      description="Create a new role end-users can be assigned to. Names must match the pattern lowercase-with-hyphens. Mark as default to make this the role new sign-ups receive automatically."
      trigger="+ Add role"
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
    >
      <form action={createRole.bind(null, applicationId)} className="space-y-3">
        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
        )}
        <Field label="Name" required hint="Lowercase letters, digits, hyphens, underscores (2–40).">
          <input
            type="text"
            name="name"
            required
            autoFocus
            pattern="^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$"
            placeholder="admin"
            className={`${inputCls} font-mono`}
          />
        </Field>
        <Field label="Description" hint="Optional — shown to other operators in this list.">
          <input
            type="text"
            name="description"
            maxLength={240}
            placeholder="Full access including billing"
            className={inputCls}
          />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="isDefault" className="h-4 w-4 rounded border-[var(--color-border)]" />
          <span className="text-xs">Make this the default role for new sign-ups</span>
        </label>
        <SubmitButton pendingLabel="Adding role…">Add role</SubmitButton>
      </form>
    </Modal>
  );
}

function NewUserModal({
  applicationId,
  roles,
  organizations,
  error,
}: {
  applicationId: string;
  roles: EndUserRoleRow[];
  organizations: OrganizationRow[];
  error?: string;
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
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
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
  error,
}: {
  applicationId: string;
  user: EndUserRow;
  roles: EndUserRoleRow[];
  error?: string;
}): React.JSX.Element {
  const metadataDefault = user.metadata ? JSON.stringify(user.metadata, null, 2) : '';
  return (
    <Modal
      modalKey={`editUser_${user.id}`}
      title={`Edit ${user.email}`}
      description="Email is immutable — it's the natural key per-Application. Use password-reset to change a password. Metadata replaces wholesale (no deep merge)."
      trigger="Edit"
      triggerClassName="text-xs text-[var(--color-fg)] font-medium hover:underline cursor-pointer"
    >
      <form action={updateUser.bind(null, applicationId, user.id)} className="space-y-3">
        {error && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {ERR[error] ?? error}
          </p>
        )}
        <Field
          label="Role"
          hint="Pick from the role catalog. Add new roles in the Roles section above."
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
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

/** Compact select used in the list-filter row (auto width, same chrome). */
const filterSelectCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

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
