/**
 * End-user Devices, the machines this account has signed in from.
 *
 * ## Why this page did not exist
 *
 * The `Device` model, its service, its four operator routes, its five webhook
 * events and its MCP tools all shipped together, and none of it was ever
 * rendered. An operator holding "I changed laptops and now I cannot sign in"
 * could see the refusal in the activity log and had no way to act on it: the
 * only release path was the end-user's own SDK call, from the machine they had
 * just replaced.
 *
 * ## What a device is here
 *
 * An opaque fingerprint the customer's client computed, stored verbatim. Rekey
 * neither derives nor parses it, and compares it only for equality. Uniqueness
 * is per (application, end-user, fingerprint), so a shared machine used by two
 * accounts is deliberately two devices.
 *
 * A device slot is not a licence seat. They are two independent pools that do
 * not interact, see the note rendered below the table, which is there because
 * an operator looking at "2 devices" and a "3 seats" licence will otherwise
 * assume one of the numbers is wrong.
 */

import * as React from 'react';
import { errorMessage } from '@/lib/error-message';
import { FilterChips } from '@/components/FilterChips';
import { formatDateTime } from '@/lib/date';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge, type BadgeTone } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Modal } from '@/components/Modal';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { CopyButton } from '@/components/CopyButton';
import { Pager, readOffset, readPageSize } from '@/components/Pager';
import { blockDevice, releaseAllDevices, releaseDevice, unblockDevice } from '../actions';
import { getEndUserDevices, shortFingerprint, type DeviceRow, type DeviceStatus } from '../shared';

const STATUS_TONE: Record<DeviceStatus, BadgeTone> = {
  ACTIVE: 'success',
  RELEASED: 'neutral',
  BLOCKED: 'danger',
};

const FILTERS: Array<{ value: '' | DeviceStatus; label: string }> = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'RELEASED', label: 'Released' },
  { value: 'BLOCKED', label: 'Blocked' },
];

const DEVICE_ERR: Record<string, string> = {
  DEVICE_NOT_FOUND: 'That device no longer exists on this end-user.',
  DEVICE_BLOCKED: 'That device is blocked. Unblock it first, then release it.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change devices on this Application.',
};

/** What each completed action says, given how many sessions went with it. */
function resultMessage(op: string, revoked: number): string | null {
  const sessions =
    revoked === 0
      ? 'No sessions were open on it.'
      : `${revoked} session${revoked === 1 ? '' : 's'} on it ${revoked === 1 ? 'was' : 'were'} revoked.`;
  switch (op) {
    case 'release':
      return `Device released, so its slot is free again. ${sessions}`;
    case 'block':
      return `Device blocked. Sign-in from this fingerprint is refused until you unblock it. ${sessions}`;
    case 'unblock':
      return 'Device unblocked. It comes back as released: it takes a slot again on its next sign-in, and only if the limit allows.';
    // 'release-all' has its own banner: it reports three counts, not one.
    default:
      return null;
  }
}

export default async function EndUserDevicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;

  const statusParam = typeof sp.status === 'string' ? sp.status : '';
  const status = (FILTERS.find((f) => f.value === statusParam)?.value || undefined) as
    | DeviceStatus
    | undefined;
  // `readPageSize` clamps to the sizes the Pager actually offers (10/25/100).
  // Reading `?ps=` by hand here meant clicking "25" produced a URL the Pager
  // omits `ps` from, which this then read back as a different default, so the
  // selector silently disagreed with the page it was on.
  const pageSize = readPageSize(sp);
  const offset = readOffset(sp);

  const done = typeof sp.device === 'string' ? sp.device : undefined;
  const revoked = Number(sp.revoked) > 0 ? Number(sp.revoked) : 0;
  const deviceError = typeof sp.deviceError === 'string' ? sp.deviceError : undefined;

  const page = await getEndUserDevices(id, euid, { status, limit: pageSize, offset });
  const basePath = `/applications/${id}/end-users/${euid}/devices`;
  const banner = done ? resultMessage(done, revoked) : null;
  const releasedAll =
    done === 'release-all'
      ? {
          released: Number(sp.released) || 0,
          revoked,
          blocked: Number(sp.blocked) || 0,
        }
      : null;

  if (page === null) {
    // "No devices registered" is a statement about the end-user. A failed read
    // is a statement about the request, and on this tab the wrong one of those
    // reads as "their machines are all gone", which is exactly the complaint
    // that brought the operator here.
    return (
      <div className="space-y-4">
        <SectionHeader title="Devices" />
        <Banner tone="error">
          The device list could not be read. Either the request failed, or your access to this Application
          does not cover it. This is <strong>not</strong> an empty device list. Reload; if it
          persists, check the API and your access.
        </Banner>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Devices"
        count={`(${page.page.total})`}
        description="Every machine this end-user has signed in from, newest activity first. Releasing one frees its slot; blocking one refuses sign-in from that fingerprint."
        action={
          page.page.total > 0 ? (
            <ActionForm action={releaseAllDevices.bind(null, id, euid)}>
              <ConfirmButton
                variant="subtle"
                title="Release every active device?"
                confirm="Frees every active slot and signs them out on those machines, so their next sign-in from any machine is admitted. Blocked devices are deliberately left blocked, so unblock those individually."
                confirmLabel="Release all"
              >
                Release all
              </ConfirmButton>
            </ActionForm>
          ) : undefined
        }
      />

      {banner && <Banner tone="success">{banner}</Banner>}
      {releasedAll && (
        <Banner tone={releasedAll.released === 0 ? 'info' : 'success'}>
          {releasedAll.released === 0
            ? 'Nothing to release: this end-user had no active devices.'
            : `Released ${releasedAll.released} device${releasedAll.released === 1 ? '' : 's'}, ending ${releasedAll.revoked} session${releasedAll.revoked === 1 ? '' : 's'}. Their next sign-in from any machine is admitted.`}
          {releasedAll.blocked > 0 &&
            ` ${releasedAll.blocked} blocked device${releasedAll.blocked === 1 ? ' was' : 's were'} left blocked, so unblock those individually.`}
        </Banner>
      )}
      {deviceError && <Banner tone="error">{errorMessage(DEVICE_ERR, deviceError)}</Banner>}

      {/* Was flat muted-fill pills, the same treatment AppNav's primary row
          uses, landing directly under two tab strips and the record switcher,
          so this tab ended in four rows of things that all read as tabs, one of
          which only changed a query string. Outlined chips say "filter", not
          "go". */}
      <FilterChips
        chips={FILTERS.map((f) => ({ value: f.value || undefined, label: f.label }))}
        active={statusParam || undefined}
        hrefFor={(v) => (v ? `${basePath}?status=${v}` : basePath)}
        label="Filter devices by status"
      />

      {page.items.length === 0 ? (
        <EmptyState
          variant="inline"
          title={
            offset > 0
              ? 'Nothing on this page'
              : status
                ? `No ${status.toLowerCase()} devices`
                : 'No devices registered'
          }
          description={
            offset > 0
              ? 'Rows may have moved since this link was made. Use Previous to go back.'
              : status
                ? 'Try a different filter.'
                : 'This end-user has never signed in with a device fingerprint. Devices appear here once the client sends one on sign-in, which it does only when the Application has device binding configured.'
          }
        />
      ) : (
        <>
          <Table minWidth="min-w-[52rem]">
            <THead>
              <TR>
                <TH>Device</TH>
                <TH>Status</TH>
                <TH>Last seen</TH>
                <TH>First seen</TH>
                <TH>Last IP</TH>
                <TH align="right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {page.items.map((d) => (
                <TR key={d.id} hover>
                  <TD>
                    <div className="font-medium text-[var(--color-fg)]">
                      {d.label ?? <span className="font-normal text-[var(--color-muted-fg)]">unlabelled</span>}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        title={d.fingerprint}
                        className="font-mono text-[11px] text-[var(--color-muted-fg)]"
                      >
                        {shortFingerprint(d.fingerprint)}
                      </span>
                      <CopyButton value={d.fingerprint} label="Copy" />
                    </div>
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONE[d.status]} dot>
                      {d.status.toLowerCase()}
                    </Badge>
                    {d.status === 'BLOCKED' && d.blockedReason && (
                      <div
                        className="mt-0.5 max-w-[14rem] truncate text-[11px] text-[var(--color-muted-fg)]"
                        title={d.blockedReason}
                      >
                        {d.blockedReason}
                      </div>
                    )}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(d.lastSeenAt)}
                  </TD>
                  <TD muted className="whitespace-nowrap text-xs">
                    {formatDateTime(d.firstSeenAt)}
                  </TD>
                  <TD mono muted className="text-xs">
                    {d.lastSeenIp ?? '—'}
                  </TD>
                  <TD align="right">
                    <DeviceActions applicationId={id} euid={euid} device={d} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}

      {/* Outside the branch above: a page that came back empty because rows
          moved, or because somebody edited the offset, still needs a way back. */}
      <Pager
        basePath={basePath}
        offset={offset}
        pageSize={pageSize}
        count={page.items.length}
        hasMore={page.page.hasMore}
        {...(statusParam ? { extraParams: { status: statusParam } } : {})}
      />

      <Card className="space-y-1.5">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">
          Devices and licence seats are separate
        </h3>
        <p className="text-xs text-[var(--color-muted-fg)]">
          A device slot is keyed by the session&apos;s <code className="font-mono">dev</code> claim and
          capped by the <code className="font-mono">max_devices</code> feature entitlement, which is
          what sign-in enforces. A licence <em>activation</em> is keyed by a machine fingerprint and
          capped by <code className="font-mono">seatsAllowed</code> on a SEATS licence, which is what
          key verification enforces. The two pools never interact: a machine that only ever verifies
          a licence key holds an activation and no device, and takes no device slot. Activations are
          on the Licenses page.
        </p>
      </Card>
    </div>
  );
}

/**
 * The per-row controls. Which ones exist follows from the status, because the
 * API refuses the others: a BLOCKED device cannot be released without being
 * unblocked first (409 DEVICE_BLOCKED), and blocking an already-blocked device
 * is a no-op. Offering a button that is going to 409 is how an operator learns
 * to distrust the page.
 */
function DeviceActions({
  applicationId,
  euid,
  device,
}: {
  applicationId: string;
  euid: string;
  device: DeviceRow;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-end gap-3">
      {device.status === 'ACTIVE' && (
        <ActionForm action={releaseDevice.bind(null, applicationId, euid, device.id)} className="inline">
          <ConfirmButton
            variant="subtle"
            title="Release this device?"
            confirm="The slot is freed and every session minted on this device is revoked, so the person is signed out on it. They can sign in again from it, which takes a slot back if the limit allows."
            confirmLabel="Release"
          >
            Release
          </ConfirmButton>
        </ActionForm>
      )}

      {/* No `modalKey`: nothing redirects with `?blockDevice=<id>`, so the
          reopen-on-error path would never fire. A refusal surfaces in the
          page-level banner instead, and declaring the prop would advertise a
          mechanism that is not wired. */}
      {device.status !== 'BLOCKED' && (
        <Modal
          title="Block this device"
          description="Sign-in from this fingerprint is refused until you unblock it, and every session on it is revoked now. The reason is operator-facing only, and the end-user never sees it."
          trigger="Block"
          triggerClassName="text-xs text-red-600 dark:text-red-400 hover:underline"
        >
          <ActionForm
            action={blockDevice.bind(null, applicationId, euid, device.id)}
            className="space-y-3"
          >
            <Field label="Reason" hint="Optional, recorded on the security event.">
              <input
                type="text"
                name="reason"
                maxLength={500}
                placeholder="chargeback, ticket #412"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
              />
            </Field>
            <SubmitButton pendingLabel="Blocking…">Block device</SubmitButton>
          </ActionForm>
        </Modal>
      )}

      {device.status === 'BLOCKED' && (
        <ActionForm action={unblockDevice.bind(null, applicationId, euid, device.id)} className="inline">
          <ConfirmButton
            variant="subtle"
            title="Unblock this device?"
            confirm="It comes back as released rather than active: it takes a slot again on its next sign-in, and only if the device limit allows."
            confirmLabel="Unblock"
          >
            Unblock
          </ConfirmButton>
        </ActionForm>
      )}
    </div>
  );
}
