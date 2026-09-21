import * as React from 'react';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { errorQuery, readErrorFlash, api, PanelApiError, getApplication } from '@/lib/api';
import { BillingDisabledState } from '@/components/BillingDisabledState';
import { ApiErrorText } from '@/components/api-error';
import { Modal } from '@/components/Modal';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDate } from '@/lib/date';
import { CopyButton } from '@/components/CopyButton';
import { Pager, readPageSize } from '@/components/Pager';
import type { Page } from '@/lib/paginate';
import { SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { EmptyState } from '@/components/EmptyState';
import { Banner } from '@/components/Banner';
import { cookieSecure } from '@/lib/cookie-secure';

const LICENSE_STATUS: Record<LicenseRow['status'], { tone: BadgeTone; label: string }> = {
  ACTIVE: { tone: 'success', label: 'active' },
  REVOKED: { tone: 'danger', label: 'revoked' },
  EXPIRED: { tone: 'neutral', label: 'expired' },
};

const LICENSE_KIND: Record<LicenseRow['kind'], string> = {
  PERPETUAL: 'Perpetual',
  TIMED: 'Timed',
  SEATS: 'Seats',
};

interface LicenseRow {
  id: string;
  endUserId: string;
  kind: 'PERPETUAL' | 'TIMED' | 'SEATS';
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  keyPrefix: string;
  expiresAt: string | null;
  seatsAllowed: number | null;
  createdAt: string;
}

interface EndUserRow {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

interface IssueResp {
  license: LicenseRow;
  rawKey: string;
}

async function issueLicense(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const endUserId = String(formData.get('endUserId') ?? '').trim();
  const kind = String(formData.get('kind') ?? 'PERPETUAL') as 'PERPETUAL' | 'TIMED' | 'SEATS';
  const expiresAt = String(formData.get('expiresAt') ?? '').trim() || undefined;
  const seatsRaw = String(formData.get('seatsAllowed') ?? '').trim();
  const seatsAllowed = seatsRaw ? Number(seatsRaw) : undefined;

  if (!endUserId) {
    redirect(`/applications/${applicationId}/licenses?error=missing&newLicense=1`);
  }
  if (kind === 'TIMED' && !expiresAt) {
    redirect(`/applications/${applicationId}/licenses?error=LICENSE_EXPIRES_AT_REQUIRED&newLicense=1`);
  }
  if (kind === 'SEATS' && !seatsAllowed) {
    redirect(`/applications/${applicationId}/licenses?error=LICENSE_SEATS_REQUIRED&newLicense=1`);
  }

  try {
    const result = await api<IssueResp>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/licenses`,
      body: {
        endUserId,
        kind,
        ...(expiresAt && { expiresAt: new Date(expiresAt).toISOString() }),
        ...(seatsAllowed && { seatsAllowed }),
      },
    });
    // One-time key via a short-lived httpOnly cookie, not the URL (keys in the
    // URL leak into history, the referer header, and access logs).
    const jar = await cookies();
    jar.set('rekey_reveal_license', result.rawKey, {
      httpOnly: true,
      sameSite: 'lax',
      secure: await cookieSecure(),
      path: `/applications/${applicationId}/licenses`,
      maxAge: 120,
    });
    redirect(`/applications/${applicationId}/licenses?e=license_issued`);
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/licenses?${await errorQuery(err, { newLicense: '1' })}`);
    }
    throw err;
  }
}

async function revokeLicense(applicationId: string, licenseId: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/licenses/${encodeURIComponent(licenseId)}`,
  });
  redirect(`/applications/${applicationId}/licenses`);
}

/**
 * One machine's hold on a seat. Distinct from a Device: an activation is keyed
 * by `machineFingerprint` and capped by `seatsAllowed`, and it is created by
 * key VERIFICATION rather than by sign-in. A machine that only ever verifies a
 * key has an activation and no device, and takes no device slot. The two pools
 * do not interact.
 */
interface ActivationRow {
  id: string;
  licenseId: string;
  machineFingerprint: string;
  label: string | null;
  deviceId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  releasedAt: string | null;
}

/**
 * Give a seat back on the holder's behalf, a re-imaged laptop, a departed
 * employee. The route has existed since the device series and nothing rendered
 * it, so the only way to free a seat held by a machine that no longer exists
 * was to rotate the key, which breaks every other machine using it.
 */
async function releaseActivation(
  applicationId: string,
  licenseId: string,
  activationId: string,
): Promise<void> {
  'use server';
  const back = `/applications/${applicationId}/licenses?activations=${encodeURIComponent(licenseId)}`;
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/licenses/${encodeURIComponent(licenseId)}/activations/${encodeURIComponent(activationId)}/release`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`${back}&${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`${back}&released=1`);
}

const ERR: Record<string, string> = {
  missing: 'Pick an end-user.',
  END_USER_NOT_FOUND: 'That end-user does not belong to this application.',
  LICENSE_EXPIRES_AT_REQUIRED: 'TIMED licenses need an expires-at date.',
  LICENSE_SEATS_REQUIRED: 'SEATS licenses need a seats-allowed count.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can issue licenses.',
};

export default async function LicensesPage({
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
  const reveal = (await cookies()).get('rekey_reveal_license')?.value;
  const PAGE_SIZE = readPageSize(sp);
  const offset = typeof sp.offset === 'string' ? Math.max(0, parseInt(sp.offset, 10) || 0) : 0;
  // Which licence's activations to expand, if any. A query parameter rather
  // than a modal per row: the activations of ONE licence are wanted at a time,
  // and rendering a modal for every row would fetch every row's activations on
  // page load.
  const openActivations = typeof sp.activations === 'string' ? sp.activations : undefined;
  const releasedOk = sp.released === '1';

  // Billing master switch off → point at the switch instead of an empty table.
  const app = await getApplication(id);
  if (!app.billingConfig.enabled) {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Licenses"
          description="License keys issued to end-users of this application."
        />
        <BillingDisabledState applicationId={id} />
      </div>
    );
  }

  const [licensePage, endUserPage] = await Promise.all([
    api<Page<LicenseRow>>({ method: 'GET', path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/licenses?limit=${PAGE_SIZE}&offset=${offset}` }),
    // End-user picker for the issue-license modal, one window, never paged.
    api<Page<EndUserRow>>({ method: 'GET', path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/end-users?limit=100` }),
  ]);
  const { items: licenses, page } = licensePage;
  const endUsers = endUserPage.items;

  // Only for the expanded licence, and only when it is on the page in front of
  // us, an id from the querystring is user input, and the API would 404 a
  // foreign one anyway, but there is no reason to ask.
  const expanded = openActivations ? licenses.find((l) => l.id === openActivations) : undefined;
  const activations = expanded
    ? await api<Page<ActivationRow>>({
        method: 'GET',
        path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/licenses/${encodeURIComponent(expanded.id)}/activations?limit=100`,
      }).catch(() => null)
    : null;

  return (
    <div className="space-y-5">
      {reveal && (
        <div className="rounded-lg border-2 border-amber-300 dark:border-amber-500 bg-amber-50 dark:bg-amber-950 p-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              New license key (shown once, copy now)
            </p>
            <CopyButton value={reveal} label="Copy key" />
          </div>
          <code className="block break-all rounded bg-[var(--color-surface)] px-3 py-2 text-xs font-mono">
            {reveal}
          </code>
          <p className="text-xs text-amber-800 dark:text-amber-300">
            The customer's software validates with{' '}
            <code className="font-mono">POST /api/v1/licenses/verify</code>.
          </p>
        </div>
      )}

      <SectionHeader
        title="Licenses"
        count={`(${licenses.length})`}
        description={
          <>
            Software licenses tied to end-users. Three kinds:{' '}
            <strong>Perpetual</strong> (no expiry), <strong>Timed</strong> (expires on a date),
            and <strong>Seats</strong> (N concurrent activations). Raw key shown once on issue;
            only the SHA-256 hash is stored. Link a license entitlement to a plan to auto-issue
            keys on purchase.
          </>
        }
        action={
          <Modal
            modalKey="newLicense"
            title="Issue a license"
            description="Bind a key to an end-user. They'll need the raw key to activate the software; you'll see it exactly once on the next page."
            trigger="+ Issue license"
          >
            {endUsers.length === 0 ? (
              <p className="text-sm text-[var(--color-muted-fg)]">
                No end-users yet. Sign one up via your application's sign-up flow first.
              </p>
            ) : (
              <ActionForm action={issueLicense.bind(null, id)} className="space-y-3">
                {error && (
                  <Banner tone="error">
                    <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
                  </Banner>
                )}
              <Field
                label="End-user"
                hint="Only end-users belonging to this Application can hold licenses."
              >
                <select
                  name="endUserId"
                  required
                  defaultValue=""
                  autoFocus
                  className={inputCls}
                >
                  <option value="" disabled>
                    Select an end-user…
                  </option>
                  {endUsers.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.email}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Kind"
                hint="Perpetual = no expiry. Timed = expires on a date. Seats = N concurrent activations."
              >
                <select name="kind" defaultValue="PERPETUAL" className={inputCls}>
                  <option value="PERPETUAL">Perpetual</option>
                  <option value="TIMED">Timed (date-bound)</option>
                  <option value="SEATS">Seats (N activations)</option>
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expires at" hint="Required for TIMED.">
                  <input type="date" name="expiresAt" className={inputCls} />
                </Field>
                <Field label="Seats allowed" hint="Required for SEATS.">
                  <input
                    type="number"
                    name="seatsAllowed"
                    min={1}
                    placeholder="e.g. 5"
                    className={`${inputCls} font-mono`}
                  />
                </Field>
              </div>
                <SubmitButton pendingLabel="Issuing license…">Issue license</SubmitButton>
              </ActionForm>
            )}
          </Modal>
        }
      />

      {licenses.length === 0 ? (
        <EmptyState
          title="No licenses issued yet"
          description={
            <>
              Use “+ Issue license” to bind a key to an end-user. Customer software validates via
              <code className="mx-1 font-mono">POST /api/v1/licenses/verify</code>.
            </>
          }
        />
      ) : (
        <Table minWidth="min-w-[48rem]">
          <THead>
            <TR>
              <TH>Prefix</TH>
              <TH>User</TH>
              <TH>Kind</TH>
              <TH>Expires</TH>
              <TH>Seats</TH>
              <TH>Status</TH>
              <TH align="right"> </TH>
            </TR>
          </THead>
          <TBody>
            {licenses.map((l) => {
              const user = endUsers.find((u) => u.id === l.endUserId);
              const status = LICENSE_STATUS[l.status];
              return (
                <TR key={l.id} hover>
                  <TD mono>{l.keyPrefix}…</TD>
                  <TD className="text-xs">{user?.email ?? l.endUserId}</TD>
                  <TD className="text-xs">{LICENSE_KIND[l.kind]}</TD>
                  <TD muted className="text-xs">
                    {l.expiresAt ? formatDate(l.expiresAt) : '—'}
                  </TD>
                  <TD muted className="text-xs">{l.seatsAllowed ?? '—'}</TD>
                  <TD>
                    <Badge tone={status.tone} dot>{status.label}</Badge>
                  </TD>
                  <TD align="right">
                    <div className="flex items-center justify-end gap-3">
                      <a
                        href={
                          openActivations === l.id
                            ? `/applications/${id}/licenses`
                            : `/applications/${id}/licenses?activations=${encodeURIComponent(l.id)}`
                        }
                        className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline"
                      >
                        {openActivations === l.id ? 'Hide activations' : 'Activations'}
                      </a>
                      {l.status === 'ACTIVE' && (
                        <ActionForm action={revokeLicense.bind(null, id, l.id)}>
                          <ConfirmButton
                            confirm={`Revoke license ${l.keyPrefix}…? Activations using this key will fail immediately.`}
                          >
                            Revoke
                          </ConfirmButton>
                        </ActionForm>
                      )}
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      {expanded && (
        <section className="space-y-3">
          <SectionHeader
            title={`Activations of ${expanded.keyPrefix}…`}
            count={activations ? `(${activations.page.total})` : undefined}
            description={
              expanded.kind === 'SEATS'
                ? `Machines holding a seat on this key. ${expanded.seatsAllowed ?? 0} allowed; released ones do not count.`
                : 'Machines that have verified this key. Only SEATS licenses are seat-capped, so these are a record rather than a limit.'
            }
            action={
              <a
                href={`/applications/${id}/licenses`}
                className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] hover:underline"
              >
                Close
              </a>
            }
          />

          {releasedOk && <Banner tone="success">Seat released.</Banner>}

          {activations === null ? (
            <Banner tone="error">Could not load activations for this license.</Banner>
          ) : activations.items.length === 0 ? (
            <EmptyState
              variant="inline"
              title="No activations"
              description="No machine has verified this key yet. An activation is created the first time POST /api/v1/licenses/verify succeeds with a machine fingerprint."
            />
          ) : (
            <Table minWidth="min-w-[48rem]">
              <THead>
                <TR>
                  <TH>Machine</TH>
                  <TH>Status</TH>
                  <TH>First seen</TH>
                  <TH>Last seen</TH>
                  <TH align="right"> </TH>
                </TR>
              </THead>
              <TBody>
                {activations.items.map((a) => (
                  <TR key={a.id} hover>
                    <TD>
                      <div className="font-medium text-[var(--color-fg)]">
                        {a.label ?? (
                          <span className="font-normal text-[var(--color-muted-fg)]">
                            unlabelled
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          title={a.machineFingerprint}
                          className="font-mono text-[11px] text-[var(--color-muted-fg)]"
                        >
                          {a.machineFingerprint.length > 20
                            ? `${a.machineFingerprint.slice(0, 20)}…`
                            : a.machineFingerprint}
                        </span>
                        <CopyButton value={a.machineFingerprint} label="Copy" />
                      </div>
                    </TD>
                    <TD>
                      {a.releasedAt ? (
                        <Badge tone="neutral">released</Badge>
                      ) : (
                        <Badge tone="success" dot>
                          holding a seat
                        </Badge>
                      )}
                    </TD>
                    <TD muted className="whitespace-nowrap text-xs">
                      {formatDate(a.firstSeenAt)}
                    </TD>
                    <TD muted className="whitespace-nowrap text-xs">
                      {formatDate(a.lastSeenAt)}
                    </TD>
                    <TD align="right">
                      {a.releasedAt === null && (
                        <ActionForm action={releaseActivation.bind(null, id, expanded.id, a.id)}>
                          <ConfirmButton
                            variant="subtle"
                            title="Release this seat?"
                            confirm="The activation stops counting toward the seat limit. A later verify from the same machine reactivates it in place, taking a seat again only if one is free."
                            confirmLabel="Release seat"
                          >
                            Release
                          </ConfirmButton>
                        </ActionForm>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}

          <p className="text-xs text-[var(--color-muted-fg)]">
            An activation is not a device. It is keyed by a machine fingerprint and capped by this
            key&apos;s <code className="font-mono">seatsAllowed</code>, and it is created by key
            verification. A device is keyed by a session&apos;s{' '}
            <code className="font-mono">dev</code> claim and capped by the{' '}
            <code className="font-mono">max_devices</code> entitlement, and it is created by
            sign-in. A machine can hold one, the other, or both.
          </p>
        </section>
      )}

      <Pager
        basePath={`/applications/${id}/licenses`}
        offset={offset}
        pageSize={PAGE_SIZE}
        count={licenses.length}
        hasMore={page.hasMore}
      />
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
