import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { api, PanelApiError, type OrganizationDetail, type EndUserRow, type OrgBillingDto } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { ConfirmButton } from '@/components/ConfirmButton';
import { CopyButton } from '@/components/CopyButton';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { Banner } from '@/components/Banner';

const ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

const ERR: Record<string, string> = {
  missing: 'Required fields are empty.',
  metadata_invalid_json: 'Metadata must be valid JSON.',
  metadata_not_object: 'Metadata must be a JSON object.',
  ORGANIZATION_ALREADY_MEMBER: 'That end-user is already a member.',
  END_USER_NOT_FOUND: 'End-user not found in this application.',
  ORGANIZATION_MEMBER_NOT_FOUND: 'That end-user is not a member.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can manage organizations.',
  LICENSE_NOT_FOUND: 'That pooled license no longer exists for this org.',
  LICENSE_REVOKED: 'That license is revoked — its key cannot be revealed.',
};

function RoleBadge({ role }: { role: 'OWNER' | 'ADMIN' | 'MEMBER' }): React.JSX.Element {
  const tone: BadgeTone = role === 'OWNER' ? 'brand' : role === 'ADMIN' ? 'info' : 'neutral';
  return (
    <Badge tone={tone} mono>
      {role}
    </Badge>
  );
}

/** Same tone mapping as end-users/[euid] — keep subscription states consistent. */
const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  PENDING: 'warning',
  PAST_DUE: 'warning',
  CANCELED: 'neutral',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  SUSPENDED: 'danger',
};
function statusTone(s: string): BadgeTone {
  return STATUS_TONE[s] ?? 'neutral';
}

// ─── Actions ─────────────────────────────────────────────────────────

const orgBase = (appId: string, orgId: string): string =>
  `/api/v1/tenant/applications/${encodeURIComponent(appId)}/organizations/${encodeURIComponent(orgId)}`;
const pageUrl = (appId: string, orgId: string): string =>
  `/applications/${appId}/organizations/${orgId}`;

async function addMember(applicationId: string, orgId: string, formData: FormData): Promise<void> {
  'use server';
  const endUserId = String(formData.get('endUserId') ?? '').trim();
  const role = String(formData.get('role') ?? 'MEMBER');
  if (!endUserId) redirect(`${pageUrl(applicationId, orgId)}?error=missing&addMember=1`);
  try {
    await api({
      method: 'POST',
      path: `${orgBase(applicationId, orgId)}/members`,
      body: { endUserId, role },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId, orgId)}?error=${encodeURIComponent(err.code)}&addMember=1`);
    }
    throw err;
  }
  revalidatePath(pageUrl(applicationId, orgId));
  redirect(`${pageUrl(applicationId, orgId)}?memberAdded=1`);
}

async function setMemberRole(
  applicationId: string,
  orgId: string,
  euid: string,
  formData: FormData,
): Promise<void> {
  'use server';
  const role = String(formData.get('role') ?? 'MEMBER');
  try {
    await api({ method: 'PATCH', path: `${orgBase(applicationId, orgId)}/members/${encodeURIComponent(euid)}`, body: { role } });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId, orgId)}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(pageUrl(applicationId, orgId));
  redirect(`${pageUrl(applicationId, orgId)}?roleChanged=1`);
}

async function removeMember(applicationId: string, orgId: string, euid: string): Promise<void> {
  'use server';
  await api({ method: 'DELETE', path: `${orgBase(applicationId, orgId)}/members/${encodeURIComponent(euid)}` });
  revalidatePath(pageUrl(applicationId, orgId));
  redirect(`${pageUrl(applicationId, orgId)}?memberRemoved=1`);
}

async function updateOrg(applicationId: string, orgId: string, formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const metadataRaw = String(formData.get('metadata') ?? '').trim();
  if (!name) redirect(`${pageUrl(applicationId, orgId)}?error=missing&editOrg=1`);
  let metadata: unknown = undefined;
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw);
      if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        redirect(`${pageUrl(applicationId, orgId)}?error=metadata_not_object&editOrg=1`);
      }
    } catch {
      redirect(`${pageUrl(applicationId, orgId)}?error=metadata_invalid_json&editOrg=1`);
    }
  }
  try {
    await api({
      method: 'PATCH',
      path: orgBase(applicationId, orgId),
      body: { name, ...(metadata !== undefined ? { metadata } : {}) },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId, orgId)}?error=${encodeURIComponent(err.code)}&editOrg=1`);
    }
    throw err;
  }
  revalidatePath(pageUrl(applicationId, orgId));
  redirect(`${pageUrl(applicationId, orgId)}?orgUpdated=1`);
}

/**
 * Mint + reveal the raw key for an org-pooled license. Org license keys are
 * issued during provisioning and stored hash-only, so the raw value is never
 * readable afterwards — this rotates the key to deliver a fresh one (shown
 * once). Rotating resets the key and clears existing activations, so it's
 * confirmed before submit.
 */
async function revealOrgLicenseKey(
  applicationId: string,
  orgId: string,
  licenseId: string,
): Promise<void> {
  'use server';
  try {
    const result = await api<{ rawKey: string; activationsReset: number }>({
      method: 'POST',
      path: `${orgBase(applicationId, orgId)}/licenses/${encodeURIComponent(licenseId)}/rotate-key`,
    });
    // One-time key via a short-lived httpOnly cookie, not the URL (keys in the
    // URL leak into history, the referer header, and access logs).
    const jar = await cookies();
    jar.set('relipay_reveal_org_license', result.rawKey, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: pageUrl(applicationId, orgId),
      maxAge: 120,
    });
    revalidatePath(pageUrl(applicationId, orgId));
    redirect(`${pageUrl(applicationId, orgId)}?revealed=1&reset=${result.activationsReset}`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${pageUrl(applicationId, orgId)}?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
}

// ─── Page ────────────────────────────────────────────────────────────

export default async function OrganizationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, orgId } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const addMemberError = sp.addMember === '1' ? error : undefined;
  const editOrgError = sp.editOrg === '1' ? error : undefined;
  const reveal = (await cookies()).get('relipay_reveal_org_license')?.value;
  const revealReset = typeof sp.reset === 'string' ? Number(sp.reset) : 0;

  let detail: OrganizationDetail;
  try {
    detail = await api<OrganizationDetail>({ method: 'GET', path: orgBase(id, orgId) });
  } catch (err) {
    if (err instanceof PanelApiError && err.statusCode === 404) notFound();
    throw err;
  }
  const endUsers = await api<EndUserRow[]>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?limit=100`,
  });
  const billing = await api<OrgBillingDto>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/organizations/${encodeURIComponent(orgId)}/billing`,
  }).catch(() => null);

  const { organization: org, members, invitations } = detail;
  const memberIds = new Set(members.map((m) => m.endUserId));
  const candidates = endUsers.filter((u) => !memberIds.has(u.id));
  const metadataPretty =
    org.metadata && Object.keys(org.metadata).length > 0 ? JSON.stringify(org.metadata, null, 2) : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <Link
          href={`/applications/${id}/organizations`}
          className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
        >
          ← All organizations
        </Link>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">{org.name}</h2>
          <Badge tone="neutral" mono>{org.slug}</Badge>
          <span className="text-xs text-[var(--color-muted-fg)]">
            created {formatDate(org.createdAt)}
          </span>
          <EditOrgModal applicationId={id} orgId={orgId} name={org.name} metadata={metadataPretty} error={editOrgError} />
        </div>
        <p className="font-mono text-xs text-[var(--color-muted-fg)]">{org.id}</p>
      </header>

      {error && !addMemberError && !editOrgError && (
        <Banner tone="error">
          {ERR[error] ?? error}
        </Banner>
      )}

      {reveal && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/60 dark:bg-amber-950/60 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Pooled license key (shown once — copy now)
            </p>
            <CopyButton value={reveal} label="Copy key" />
          </div>
          <code className="block break-all rounded-md bg-[var(--color-surface)] px-3 py-2 text-xs font-mono">
            {reveal}
          </code>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Hand this to the organization. The team's machines validate with{' '}
            <code className="font-mono">POST /api/v1/licenses/verify</code>.
            {revealReset > 0 && (
              <> {revealReset} existing activation{revealReset === 1 ? '' : 's'} were reset — any machine on the old key must re-verify.</>
            )}
          </p>
        </div>
      )}

      {/* ─── Members ─────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeader
          title="Members"
          count={`(${members.length})`}
          action={<AddMemberModal applicationId={id} orgId={orgId} candidates={candidates} error={addMemberError} />}
        />
        {members.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No members"
            description="Add one with “+ Add member”."
          />
        ) : (
        <Table minWidth="min-w-[40rem]">
          <THead>
            <TR>
              <TH>Email</TH>
              <TH>Role</TH>
              <TH>Joined</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {members.map((m) => (
                <TR key={m.id} hover>
                  <TD>{m.email}</TD>
                  <TD>
                    <form action={setMemberRole.bind(null, id, orgId, m.endUserId)} className="flex items-center gap-2">
                      <select name="role" defaultValue={m.role} className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]">
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                      <SubmitButton pendingLabel="Saving…" className="text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-60">Save</SubmitButton>
                    </form>
                  </TD>
                  <TD muted className="text-xs">
                    {formatDate(m.createdAt)}
                  </TD>
                  <TD align="right">
                    <form action={removeMember.bind(null, id, orgId, m.endUserId)} className="inline">
                      <ConfirmButton confirm={`Remove ${m.email} from "${org.name}"? Their end-user account is not deleted.`}>
                        Remove
                      </ConfirmButton>
                    </form>
                  </TD>
                </TR>
              ))}
          </TBody>
        </Table>
        )}
        <p className="text-xs text-[var(--color-muted-fg)]">
          <RoleBadge role="OWNER" /> manage org + members · <RoleBadge role="ADMIN" /> manage members ·{' '}
          <RoleBadge role="MEMBER" /> read-only. Operator changes here bypass the org role hierarchy.
        </p>
      </section>

      {/* ─── Pending invitations ─────────────────── */}
      <section className="space-y-3">
        <SectionHeader title="Pending invitations" count={`(${invitations.length})`} />
        {invitations.length === 0 ? (
          <EmptyState variant="inline" title="No pending invitations" />
        ) : (
          <Table minWidth="min-w-[36rem]">
            <THead>
              <TR>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Invited</TH>
                <TH>Expires</TH>
              </TR>
            </THead>
            <TBody>
              {invitations.map((inv) => {
                const expired = new Date(inv.expiresAt).getTime() < Date.now();
                return (
                  <TR key={inv.id} hover>
                    <TD>{inv.email}</TD>
                    <TD><RoleBadge role={inv.role} /></TD>
                    <TD muted className="text-xs">
                      {formatDate(inv.createdAt)}
                    </TD>
                    <TD className="text-xs">
                      {expired ? (
                        <Badge tone="warning">expired</Badge>
                      ) : (
                        <span className="text-[var(--color-muted-fg)]">
                          {formatDate(inv.expiresAt)}
                        </span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </section>

      {/* ─── Billing (owner+beneficiary) ─────────── */}
      {billing && (
        <section className="space-y-3">
          <SectionHeader title="Billing" />
          <div className="flex flex-wrap gap-4">
            <Card className="px-4 py-3" padded={false}>
              <div className="text-xs text-[var(--color-muted-fg)]">Shared credit pool</div>
              <div className="text-lg font-semibold text-[var(--color-fg)]">{billing.creditBalance}</div>
            </Card>
            <Card className="min-w-[12rem] flex-1 px-4 py-3" padded={false}>
              <div className="mb-1 text-xs text-[var(--color-muted-fg)]">Feature flags</div>
              {Object.keys(billing.features).length === 0 ? (
                <div className="text-xs text-[var(--color-faint-fg)]">—</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(billing.features).map(([k, v]) => (
                    <Badge key={k} tone="neutral" mono>
                      {k}={String(v)}
                    </Badge>
                  ))}
                </div>
              )}
            </Card>
          </div>
          {billing.subscriptions.length > 0 ? (
            <Table minWidth="min-w-[40rem]">
              <THead>
                <TR>
                  <TH>Plan</TH>
                  <TH>Status</TH>
                  <TH>Owner</TH>
                  <TH>Renews</TH>
                </TR>
              </THead>
              <TBody>
                {billing.subscriptions.map((s) => (
                  <TR key={s.id} hover>
                    <TD>{s.planName} <span className="font-mono text-[11px] text-[var(--color-muted-fg)]">{s.planSlug}</span></TD>
                    <TD>
                      <Badge tone={statusTone(s.status)} dot>{s.status.toLowerCase()}</Badge>
                    </TD>
                    <TD>
                      <Link href={`/applications/${id}/end-users/${s.ownerEndUserId}`} title={s.ownerEndUserId} className="inline-block max-w-[12rem] truncate align-bottom font-mono text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline">
                        {s.ownerEndUserId}
                      </Link>
                    </TD>
                    <TD muted className="text-xs">
                      {s.currentPeriodEnd ? formatDate(s.currentPeriodEnd) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-xs text-[var(--color-muted-fg)]">
              No subscriptions bill this org yet. An OWNER/ADMIN can buy a plan for it at checkout
              with <code className="text-xs">organizationId</code> (when the app's billing subject is set to organizations).
            </p>
          )}
          {billing.licenses.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-[var(--color-muted-fg)]">
                Pooled licenses <span className="text-[var(--color-faint-fg)]">— seats shared by the team</span>
              </div>
              <Table minWidth="min-w-[44rem]">
                <THead>
                  <TR>
                    <TH>Key</TH>
                    <TH>Kind</TH>
                    <TH>Seats</TH>
                    <TH>Status</TH>
                    <TH>Expires</TH>
                    <TH align="right"> </TH>
                  </TR>
                </THead>
                <TBody>
                  {billing.licenses.map((l) => (
                    <TR key={l.id} hover>
                      <TD mono className="text-[11px]">{l.keyPrefix}…</TD>
                      <TD className="text-xs">{l.kind}</TD>
                      <TD className="text-xs">{l.seatsAllowed ?? '—'}</TD>
                      <TD className="text-xs">
                        <Badge tone={l.status === 'ACTIVE' ? 'success' : 'neutral'}>{l.status}</Badge>
                      </TD>
                      <TD muted className="text-xs">
                        {l.expiresAt ? formatDate(l.expiresAt) : '—'}
                      </TD>
                      <TD align="right">
                        {l.status === 'ACTIVE' && (
                          <form action={revealOrgLicenseKey.bind(null, id, orgId, l.id)} className="inline">
                            <ConfirmButton
                              variant="subtle"
                              confirm={`Reveal the key for ${l.keyPrefix}…? This mints a NEW key (shown once) and resets any existing activations — machines on the old key must re-verify. Org keys are stored hash-only, so this is the only way to obtain one.`}
                            >
                              Reveal key
                            </ConfirmButton>
                          </form>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <p className="text-[11px] text-[var(--color-faint-fg)]">
                Keys are stored hash-only. “Reveal key” mints a fresh key and shows it once — use it to deliver the org its key.
              </p>
            </div>
          )}
        </section>
      )}

      {/* ─── Metadata ────────────────────────────── */}
      {metadataPretty && (
        <section className="space-y-2">
          <SectionHeader title="Metadata" />
          <pre className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 font-mono text-xs">
            {metadataPretty}
          </pre>
        </section>
      )}
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────

function AddMemberModal({
  applicationId,
  orgId,
  candidates,
  error,
}: {
  applicationId: string;
  orgId: string;
  candidates: EndUserRow[];
  error?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="addMember"
      title="Add member"
      description="Add an existing end-user of this application to the organization with a role."
      trigger="+ Add member"
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap"
    >
      <form action={addMember.bind(null, applicationId, orgId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            {ERR[error] ?? error}
          </Banner>
        )}
        {candidates.length === 0 ? (
          <p className="text-sm text-[var(--color-muted-fg)]">
            Every end-user is already a member. Create more end-users on the End-users tab first.
          </p>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-xs font-medium">End-user<span className="text-[var(--color-primary)] ml-0.5">*</span></span>
              <select name="endUserId" required defaultValue="" className={inputCls}>
                <option value="" disabled>Select an end-user…</option>
                {candidates.map((u) => (
                  <option key={u.id} value={u.id}>{u.email}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Role</span>
              <select name="role" defaultValue="MEMBER" className={inputCls}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <SubmitButton pendingLabel="Adding member…">
              Add member
            </SubmitButton>
          </>
        )}
      </form>
    </Modal>
  );
}

function EditOrgModal({
  applicationId,
  orgId,
  name,
  metadata,
  error,
}: {
  applicationId: string;
  orgId: string;
  name: string;
  metadata: string | null;
  error?: string;
}): React.JSX.Element {
  return (
    <Modal
      modalKey="editOrg"
      title="Edit organization"
      description="Rename the org or replace its metadata. Slug is immutable."
      trigger="Edit"
      triggerClassName="text-xs text-[var(--color-fg)] font-medium hover:underline cursor-pointer"
    >
      <form action={updateOrg.bind(null, applicationId, orgId)} className="space-y-3">
        {error && (
          <Banner tone="error">
            {ERR[error] ?? error}
          </Banner>
        )}
        <label className="block space-y-1">
          <span className="text-xs font-medium">Name<span className="text-[var(--color-primary)] ml-0.5">*</span></span>
          <input type="text" name="name" required defaultValue={name} className={inputCls} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">Metadata (JSON object)</span>
          <textarea name="metadata" rows={5} defaultValue={metadata ?? ''} placeholder='{"plan":"team"}' className={`${inputCls} font-mono`} />
          <span className="block text-xs text-[var(--color-muted-fg)]">Empty clears it; otherwise replaces the whole object.</span>
        </label>
        <SubmitButton pendingLabel="Saving…">
          Save changes
        </SubmitButton>
      </form>
    </Modal>
  );
}
