import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { errorQuery, readErrorFlash, api, PanelApiError, type OrganizationRow, type EndUserRow, getApplication } from '@/lib/api';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ApiErrorText } from '@/components/api-error';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Field } from '@/components/Field';
import { formatDate } from '@/lib/date';
import { Modal } from '@/components/Modal';
import { Pager, readPageSize } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';

// ─── Actions ─────────────────────────────────────────────────────────

async function createOrg(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  const ownerEndUserId = String(formData.get('ownerEndUserId') ?? '').trim();
  if (!name || !slug) {
    redirect(`/applications/${applicationId}/organizations?error=missing&newOrg=1`);
  }
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organizations`,
      body: { name, slug, ...(ownerEndUserId ? { ownerEndUserId } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/organizations?${await errorQuery(err, { newOrg: '1' })}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/organizations?created=${encodeURIComponent(slug)}`);
}

async function deleteOrg(applicationId: string, orgId: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/organizations/${encodeURIComponent(orgId)}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/organizations?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/organizations?deleted=1`);
}

// ─── Errors ──────────────────────────────────────────────────────────

const ERR: Record<string, string> = {
  missing: 'Name and slug are required.',
  ORGANIZATION_SLUG_INVALID: 'Slug must be 1–40 chars of [a-z0-9-], starting and ending alphanumeric.',
  ORGANIZATION_SLUG_TAKEN: 'An organization with that slug already exists in this application.',
  END_USER_NOT_FOUND: 'The chosen owner is not an end-user of this application.',
  ORGANIZATION_NOT_FOUND: 'Organization not found — it may have already been deleted.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage organizations.',
  ORGANIZATIONS_NOT_ENABLED:
    'Enable organizations for this application (Auth settings) before defining organization roles.',
  ORGANIZATION_ROLE_NAME_INVALID:
    'Role name must be 2–40 lowercase letters, digits, hyphens or underscores, starting and ending alphanumeric.',
  ORGANIZATION_ROLE_NAME_TAKEN: 'A role with that name already exists in this application.',
  ORGANIZATION_ROLE_NAME_RESERVED: 'OWNER, ADMIN and MEMBER are built in. Pick a different name.',
  ORGANIZATION_ROLE_NOT_FOUND: 'Role not found. It may have already been deleted.',
  ORGANIZATION_ROLE_IS_DEFAULT: 'Mark another role as the default before deleting this one.',
  ORGANIZATION_ROLE_BUILT_IN_IMMUTABLE: 'OWNER, ADMIN and MEMBER cannot be re-tiered or deleted.',
  ORGANIZATION_ROLE_IN_USE:
    'Members or pending invitations still hold this role. Choose a role to move them to.',
  ORGANIZATION_ROLE_REASSIGN_SELF: 'Pick a different role to move holders to.',
  ORGANIZATION_ROLE_REASSIGN_TARGET_UNKNOWN: 'That target role does not exist in this application.',
  ORGANIZATION_ROLE_REASSIGN_DEMOTES_OWNER:
    'This role carries OWNER authority and the target does not, so organizations would be left without an owner.',
};

// ─── Page ────────────────────────────────────────────────────────────

export default async function OrganizationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const newOrgError = sp.newOrg === '1' ? error : undefined;
  const created = typeof sp.created === 'string' ? sp.created : undefined;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;

  const [app, orgPage, endUserPage] = await Promise.all([
    getApplication(id),
    api<Page<OrganizationRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/organizations?limit=${PAGE_SIZE}&offset=${offset}`,
    }),
    // Owner picker for the create-org modal — one window, never paged.
    api<Page<EndUserRow>>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?limit=100`,
    }),
  ]);
  const { items: orgs, page } = orgPage;
  const endUsers = endUserPage.items;

  const enabled = app.authConfig.organizationsEnabled === true;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <SectionHeader
          title="Organizations"
          count={`(${orgs.length})`}
          description={
            <>
              Group end-users into companies/teams — use this if you bill organizations rather than
              individuals. Optional, and distinct from your workspace members. End-users create +
              manage these from your app via the SDK
              (<code className="font-mono text-xs">rekey.organizations.*</code>); you can also
              provision and curate them here. The roles a member can hold inside an organization
              are configured on the{' '}
              <Link href={`/applications/${id}/roles`} className="underline hover:no-underline">
                Roles
              </Link>{' '}
              tab.
            </>
          }
          action={<NewOrgModal applicationId={id} endUsers={endUsers} error={newOrgError} errorDetail={errorDetail} errorFix={errorFix} />}
        />

        {!enabled && (
          <Banner tone="warning">
            Organizations are <strong>disabled</strong> for this application — the SDK org endpoints
            return <code className="font-mono text-xs">ORGANIZATIONS_NOT_ENABLED</code> for end-users
            (operator management here still works). Enable it under{' '}
            <Link href={`/applications/${id}/auth`} className="underline hover:no-underline">
              Auth
            </Link>
            .
          </Banner>
        )}

        {created && <SavedBanner params={['created']} message={`Organization ${created} created.`} />}
        {error && !newOrgError && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}

        {orgs.length === 0 ? (
          <EmptyState
            title="No organizations yet"
            description={
              <>
                Create one if you bill companies/teams rather than individuals — use “+ New
                organization”, or let end-users create teams from your app with
                <code className="font-mono text-xs"> rekey.organizations.create()</code>.
              </>
            }
          />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Slug</TH>
                <TH>Members</TH>
                <TH>Pending invites</TH>
                <TH>Created</TH>
                <TH align="right"> </TH>
              </TR>
            </THead>
            <TBody>
              {orgs.map((o) => (
                <TR key={o.id} hover>
                  <TD className="font-medium">{o.name}</TD>
                  <TD>
                    <Badge tone="neutral" mono>{o.slug}</Badge>
                  </TD>
                  <TD muted className="text-xs">{o.memberCount}</TD>
                  <TD muted className="text-xs">
                    {o.pendingInvitationCount > 0 ? o.pendingInvitationCount : '—'}
                  </TD>
                  <TD muted className="text-xs">
                    {formatDate(o.createdAt)}
                  </TD>
                  <TD align="right">
                    <div className="flex items-center justify-end gap-3">
                      <Link
                        href={`/applications/${id}/organizations/${o.id}`}
                        className="text-xs font-medium text-[var(--color-fg)] hover:underline"
                      >
                        Manage
                      </Link>
                      <form action={deleteOrg.bind(null, id, o.id)} className="inline">
                        <ConfirmButton
                          confirm={`Delete organization "${o.name}"? This removes all ${o.memberCount} membership${o.memberCount === 1 ? '' : 's'} and any pending invitations. End-user accounts themselves are not deleted.`}
                        >
                          Delete
                        </ConfirmButton>
                      </form>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        <Pager
          basePath={`/applications/${id}/organizations`}
          offset={offset}
          pageSize={PAGE_SIZE}
          count={orgs.length}
          hasMore={page.hasMore}
        />
      </section>

    </div>
  );
}

// ─── Modal ───────────────────────────────────────────────────────────

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function NewOrgModal({
  applicationId,
  endUsers,
  error, errorDetail, errorFix,
}: {
  applicationId: string;
  endUsers: EndUserRow[];
  error?: string;
  errorDetail?: string;
  errorFix?: string;
}): React.JSX.Element {
  const slugError =
    error === 'ORGANIZATION_SLUG_TAKEN' || error === 'ORGANIZATION_SLUG_INVALID'
      ? ERR[error]
      : undefined;
  return (
    <Modal
      modalKey="newOrg"
      title="Create organization"
      description="Provision a team inside this application. Optionally seed an initial OWNER from an existing end-user; you can add more members afterwards."
      trigger="+ New organization"
    >
      <form action={createOrg.bind(null, applicationId)} className="space-y-3">
        {error && !slugError && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">Name<span className="text-[var(--color-primary)] ml-0.5">*</span></span>
          <input type="text" name="name" required autoFocus placeholder="Acme Inc" className={inputCls} />
        </label>
        <Field
          label="Slug"
          required
          error={slugError}
          hint="Unique per application. Lowercase letters, digits, hyphens."
        >
          <input
            type="text"
            name="slug"
            required
            pattern="^[a-z0-9](?:[a-z0-9\-]{0,38}[a-z0-9])?$"
            placeholder="acme"
            className={`${inputCls} font-mono`}
          />
        </Field>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Initial owner (optional)</span>
          <select name="ownerEndUserId" defaultValue="" className={inputCls}>
            <option value="">— No owner yet —</option>
            {endUsers.map((u) => (
              <option key={u.id} value={u.id}>{u.email}</option>
            ))}
          </select>
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Assigned the OWNER role. Leave blank to create an empty org and add members later.
          </span>
        </label>
        <SubmitButton pendingLabel="Creating organization…">Create organization</SubmitButton>
      </form>
    </Modal>
  );
}
