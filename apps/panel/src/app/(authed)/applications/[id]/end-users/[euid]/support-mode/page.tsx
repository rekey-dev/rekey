/**
 * End-user Support mode: open a support case, change it, end it, and see what
 * happened before.
 *
 * A case turns on capabilities from the Application's catalogue for this
 * account, on every device or on the ones picked. Rekey reports them to the
 * app and enforces none of them. A case never expires, which is why its age is
 * on screen.
 *
 * The reason and the notes are operator-only free text and are rendered as
 * plain React text children, never as markup or a link.
 */

import * as React from 'react';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { CapabilityBadges } from '@/components/CapabilityBadges';
import { Card, SectionHeader } from '@/components/Card';
import { ConfirmButton } from '@/components/ConfirmButton';
import { EmptyState } from '@/components/EmptyState';
import { Field } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import Link from '@/components/Link';
import { Modal } from '@/components/Modal';
import { SubmitButton } from '@/components/SubmitButton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { formatDateTime, formatRelative } from '@/lib/date';
import { errorMessage } from '@/lib/error-message';
import { getApplication } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { savedStateKey } from '@/lib/saved-state-key';
import {
  caseAgeLabel,
  closedCauseLabel,
  getSupportCapabilities,
  operatorName,
  SUPPORT_ERR,
  SUPPORT_NOTE_MAX,
  SUPPORT_REASON_MAX,
  type SupportCapabilityDto,
  type SupportCaseDto,
  type SupportCaseNoteDto,
} from '@/lib/support-mode';
import { addSupportCaseNote, changeSupportCase, endSupportCase, openSupportCase } from '../actions';
import {
  getEndUserDetail,
  getEndUserDevices,
  getEndUserSupport,
  shortFingerprint,
  type DeviceRow,
  type SupportEventRow,
} from '../shared';

const DEVICE_SCAN = 100;

const RESULT: Record<string, string> = {
  opened: 'Support case opened. The app reads the capabilities on its next request.',
  changed: 'Support case changed. The app reads the new state on its next request.',
  ended: 'Support mode ended. The capabilities are no longer reported.',
  noted: 'Note added.',
};

const EVENT_LABEL: Record<SupportEventRow['type'], string> = {
  'end_user.support_opened': 'opened',
  'end_user.support_updated': 'changed',
  'end_user.support_closed': 'closed',
};

const textareaCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]';
const checkCls = 'mt-0.5 h-4 w-4 shrink-0 rounded border-[var(--color-border)]';
const secondaryTrigger =
  'inline-flex items-center rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)] whitespace-nowrap';

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}

/**
 * The capabilities an event recorded on one side of it, if any. A change
 * records both sides. An open and a close record one list: what the case
 * started with, shown as "after", and what it ended with, shown as "before".
 */
function eventCapabilities(event: SupportEventRow, side: 'before' | 'after'): string[] | null {
  if (event.type === 'end_user.support_updated') {
    return stringList(event.metadata[side === 'before' ? 'capabilitiesBefore' : 'capabilitiesAfter']);
  }
  const shownOn = event.type === 'end_user.support_opened' ? 'after' : 'before';
  return side === shownOn ? stringList(event.metadata.capabilities) : null;
}

function deviceName(device: DeviceRow | undefined, id: string): string {
  if (!device) return id;
  return device.label ?? shortFingerprint(device.fingerprint);
}

function NoteList({ notes, total }: { notes: SupportCaseNoteDto[]; total: number }): React.JSX.Element {
  const hidden = total - notes.length;
  return (
    <ul className="space-y-2">
      {hidden > 0 && (
        <li className="text-xs text-[var(--color-muted-fg)]">
          {hidden} older {hidden === 1 ? 'note is' : 'notes are'} not shown.
        </li>
      )}
      {notes.map((note) => (
        <li key={note.id} className="text-sm">
          <p className="whitespace-pre-wrap break-words">{note.body}</p>
          <p className="text-xs text-[var(--color-muted-fg)]">
            {note.authorEmail ?? 'a former member'}, {formatDateTime(note.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The fields the open and change forms share. The device checklist shows only
 * while "Selected devices" is picked, done in CSS so the form stays a server
 * component; boxes ticked while it is hidden are ignored by the action.
 */
function CaseFields({
  catalogue,
  activeDevices,
  selected,
  scope,
  selectedDevices,
}: {
  catalogue: SupportCapabilityDto[];
  /** Null when the device list could not be read. */
  activeDevices: DeviceRow[] | null;
  selected: string[];
  scope: SupportCaseDto['scope'];
  selectedDevices: string[];
}): React.JSX.Element {
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-[var(--color-fg)]">Capabilities</legend>
        {catalogue.map((c) => (
          <label key={c.name} className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              name="capabilities"
              value={c.name}
              defaultChecked={selected.includes(c.name)}
              className={checkCls}
            />
            <span className="min-w-0">
              <span className="block break-all font-mono text-xs text-[var(--color-fg)]">{c.name}</span>
              {c.description && (
                <span className="block text-xs text-[var(--color-muted-fg)]">{c.description}</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>

      {activeDevices === null ? (
        <p className="text-xs text-[var(--color-muted-fg)]">
          The device list could not be read, so the devices this case covers cannot be changed here.
        </p>
      ) : (
        <fieldset className="group space-y-2">
          <legend className="text-xs font-medium text-[var(--color-fg)]">Applies to</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="scope" value="USER" defaultChecked={scope === 'USER'} />
            All devices
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="scope"
              value="DEVICES"
              defaultChecked={scope === 'DEVICES'}
              disabled={activeDevices.length === 0}
              className="scope-devices"
            />
            Selected devices
            {activeDevices.length === 0 && (
              <span className="text-xs text-[var(--color-muted-fg)]">(no active devices)</span>
            )}
          </label>
          <div className="hidden space-y-1.5 pl-6 group-has-[.scope-devices:checked]:block">
            {activeDevices.map((d) => (
              <label key={d.id} className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  name="deviceIds"
                  value={d.id}
                  defaultChecked={selectedDevices.includes(d.id)}
                  className={checkCls}
                />
                <span className="min-w-0 text-sm">
                  <span className="block break-all">{deviceName(d, d.id)}</span>
                  <span className="block text-xs text-[var(--color-muted-fg)]">
                    last seen {formatRelative(d.lastSeenAt)}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-xs text-[var(--color-muted-fg)]">
              Releasing or blocking a device removes it from the case. When it was the last one,
              the case ends.
            </p>
          </div>
        </fieldset>
      )}
    </>
  );
}

export default async function EndUserSupportModePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const done = typeof sp.case === 'string' && Object.prototype.hasOwnProperty.call(RESULT, sp.case)
    ? RESULT[sp.case]
    : null;
  const caseError = typeof sp.caseError === 'string' ? sp.caseError : undefined;

  const [detail, application, support] = await Promise.all([
    getEndUserDetail(id, euid),
    getApplication(id),
    getEndUserSupport(id, euid),
  ]);
  const canWrite = hasScope(application.access.scopes, 'end-users:write');
  const isErased = detail.endUser.erasedAt !== null;
  const isBanned = detail.endUser.bannedAt !== null;
  const catalogueHref = `/applications/${id}/support`;

  if (support === null) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Support mode" />
        <Banner tone="error">
          The support mode state could not be read. Either the request failed, or your access to
          this Application does not cover it. This does <strong>not</strong> mean no support case
          is open. Reload; if it persists, check the API and your access.
        </Banner>
      </div>
    );
  }

  const { open, history, events } = support;
  const canOpen = canWrite && !isErased && !isBanned;
  const showsForm = canWrite && (open !== null || canOpen);
  const [catalogue, devicePage] = await Promise.all([
    showsForm ? getSupportCapabilities(id) : Promise.resolve(null),
    open?.scope === 'DEVICES' || showsForm
      ? getEndUserDevices(id, euid, { limit: DEVICE_SCAN })
      : Promise.resolve(null),
  ]);
  const devicesById = new Map((devicePage?.items ?? []).map((d) => [d.id, d]));
  const activeDevices = devicePage ? devicePage.items.filter((d) => d.status === 'ACTIVE') : null;

  return (
    <div className="space-y-6">
      {done && <Banner tone="success">{done}</Banner>}
      {caseError && <Banner tone="error">{errorMessage(SUPPORT_ERR, caseError)}</Banner>}

      <section className="space-y-3">
        <SectionHeader
          title="Support mode"
          description="Open a support case to turn on capabilities from this Application's catalogue for this account. Your app reads them and decides what each one does. A case stays open until someone ends it."
        />
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Status</h3>
            {open ? (
              <Badge tone="info" dot>
                support mode
              </Badge>
            ) : (
              <Badge tone="neutral" dot>
                off
              </Badge>
            )}
          </div>

          {open ? (
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
              <dt className="text-[var(--color-muted-fg)]">Capabilities</dt>
              <dd>
                <CapabilityBadges names={open.capabilities} />
              </dd>
              <dt className="text-[var(--color-muted-fg)]">Applies to</dt>
              <dd>
                {open.scope === 'USER'
                  ? 'All devices'
                  : open.deviceIds.map((d) => deviceName(devicesById.get(d), d)).join(', ')}
              </dd>
              <dt className="text-[var(--color-muted-fg)]">Reason</dt>
              <dd className="whitespace-pre-wrap break-words">
                {open.reason ?? <span className="text-[var(--color-muted-fg)]">none recorded</span>}
              </dd>
              <dt className="text-[var(--color-muted-fg)]">Opened</dt>
              <dd>
                {formatDateTime(open.openedAt)} by {operatorName(open.openedByEmail, open.openedBy)}
              </dd>
              <dt className="text-[var(--color-muted-fg)]">Open for</dt>
              <dd>{caseAgeLabel(open.openedAt)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-[var(--color-muted-fg)]">
              No support case is open. The app reads support mode as off for this account.
            </p>
          )}

          {!open && canWrite && isBanned && !isErased && (
            <p className="text-xs text-[var(--color-muted-fg)]">
              A banned end-user cannot get a support case. Lift the ban on the{' '}
              <Link href={`/applications/${id}/end-users/${euid}/access`}>Access tab</Link> first.
            </p>
          )}

          {showsForm && catalogue === null && (
            <Banner tone="error">
              The capability catalogue could not be read, so the case cannot be opened or changed
              from here. Reload to try again.
            </Banner>
          )}

          {canOpen && !open && catalogue !== null && catalogue.length === 0 && (
            <EmptyState
              variant="inline"
              title="No capabilities to turn on yet"
              description="A support case turns on capabilities from this Application's catalogue, and the catalogue is empty."
              action={<Link href={catalogueHref}>Add capabilities on the Support mode page</Link>}
            />
          )}

          {canOpen && !open && catalogue !== null && catalogue.length > 0 && (
            <div className="pt-1">
              <Modal
                title="Open a support case"
                description="Turns on the capabilities you pick until someone ends the case. It changes nothing about their plan, billing or sign-in."
                trigger="Open support case"
                triggerClassName={secondaryTrigger}
              >
                <ActionForm action={openSupportCase.bind(null, id, euid)} className="space-y-4">
                  <CaseFields
                    catalogue={catalogue}
                    activeDevices={activeDevices}
                    selected={[]}
                    scope="USER"
                    selectedDevices={[]}
                  />
                  <Field
                    label="Reason"
                    required
                    hint={`Required, up to ${SUPPORT_REASON_MAX} characters. Only operators see it; the customer never does.`}
                  >
                    <textarea
                      name="reason"
                      required
                      maxLength={SUPPORT_REASON_MAX}
                      rows={3}
                      placeholder="Ticket 1423: export fails on one PC"
                      className={textareaCls}
                    />
                  </Field>
                  <SubmitButton pendingLabel="Opening…">Open support case</SubmitButton>
                </ActionForm>
              </Modal>
            </div>
          )}

          {open && canWrite && (
            <div className="flex items-center gap-4 pt-1">
              {catalogue !== null && (
                <Modal
                  title="Change the support case"
                  description="Replaces the capabilities and the devices the case covers. The reason stays as it was written."
                  trigger="Change"
                  triggerClassName={secondaryTrigger}
                >
                  <ActionForm
                    key={savedStateKey({
                      capabilities: open.capabilities,
                      scope: open.scope,
                      deviceIds: open.deviceIds,
                    })}
                    action={changeSupportCase.bind(null, id, euid)}
                    className="space-y-4"
                  >
                    <CaseFields
                      catalogue={catalogue}
                      activeDevices={activeDevices}
                      selected={open.capabilities}
                      scope={open.scope}
                      selectedDevices={open.deviceIds}
                    />
                    <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
                  </ActionForm>
                </Modal>
              )}
              <ActionForm action={endSupportCase.bind(null, id, euid)} className="inline">
                <ConfirmButton
                  variant="subtle"
                  title="End support mode?"
                  confirm="The capabilities stop being reported on the app's next read. The case stays in the history below."
                  confirmLabel="End support mode"
                >
                  End support mode
                </ConfirmButton>
              </ActionForm>
            </div>
          )}
        </Card>

        {open && (
          <Card className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Notes</h3>
            {(open.noteCount ?? 0) === 0 && (open.notes ?? []).length === 0 ? (
              <p className="text-sm text-[var(--color-muted-fg)]">
                No notes yet. Notes record what was tried on this case. Only operators see them.
              </p>
            ) : (
              <NoteList notes={open.notes ?? []} total={open.noteCount ?? 0} />
            )}
            {canWrite && (
              <ActionForm action={addSupportCaseNote.bind(null, id, euid)} className="space-y-2">
                <Field
                  label="Add a note"
                  hint={`Up to ${SUPPORT_NOTE_MAX} characters. A note cannot be edited or deleted afterwards.`}
                >
                  <textarea
                    name="body"
                    required
                    maxLength={SUPPORT_NOTE_MAX}
                    rows={2}
                    placeholder="Sent build 4.2.1, waiting for the customer to retry"
                    className={textareaCls}
                  />
                </Field>
                <SubmitButton pendingLabel="Adding…">Add note</SubmitButton>
              </ActionForm>
            )}
          </Card>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="Past cases"
          count={`(${history.length})`}
          description="Closed support cases on this account, newest first, with why each was opened and the notes operators left."
        />
        {history.length === 0 ? (
          <EmptyState variant="inline" title="No closed cases" />
        ) : (
          <Table minWidth="min-w-[48rem]">
            <THead>
              <TR>
                <TH>Capabilities</TH>
                <TH>Opened</TH>
                <TH>Closed</TH>
                <TH>Cause</TH>
                <TH>Reason and notes</TH>
              </TR>
            </THead>
            <TBody>
              {history.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <CapabilityBadges names={c.capabilities} />
                  </TD>
                  <TD className="text-xs">
                    <span className="block whitespace-nowrap">{formatDateTime(c.openedAt)}</span>
                    <span className="block text-[var(--color-muted-fg)]">
                      {operatorName(c.openedByEmail, c.openedBy)}
                    </span>
                  </TD>
                  <TD className="text-xs">
                    <span className="block whitespace-nowrap">
                      {c.closedAt ? formatDateTime(c.closedAt) : 'unknown'}
                    </span>
                    <span className="block text-[var(--color-muted-fg)]">
                      {operatorName(c.closedByEmail, c.closedBy)}
                    </span>
                  </TD>
                  <TD className="text-xs">{closedCauseLabel(c.closedCause)}</TD>
                  <TD className="max-w-[24rem] space-y-2 text-sm">
                    <p className="whitespace-pre-wrap break-words">
                      {c.reason ?? <span className="text-[var(--color-muted-fg)]">none recorded</span>}
                    </p>
                    {(c.noteCount ?? (c.notes ?? []).length) > 0 && (
                      <NoteList notes={c.notes ?? []} total={c.noteCount ?? 0} />
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="What happened"
          count={`(${events.length})`}
          description="Every open, change and close on this account, newest first, with the operator who did it."
        />
        {events.length === 0 ? (
          <EmptyState variant="inline" title="Never in support mode" />
        ) : (
          <Table minWidth="min-w-[44rem]">
            <THead>
              <TR>
                <TH>Action</TH>
                <TH>By</TH>
                <TH>Capabilities before</TH>
                <TH>Capabilities after</TH>
                <TH>When</TH>
              </TR>
            </THead>
            <TBody>
              {events.map((e) => {
                const before = eventCapabilities(e, 'before');
                const after = eventCapabilities(e, 'after');
                return (
                  <TR key={e.id}>
                    <TD>
                      <Badge tone={e.type === 'end_user.support_closed' ? 'neutral' : 'info'}>
                        {EVENT_LABEL[e.type] ?? 'changed'}
                      </Badge>
                    </TD>
                    <TD className="text-sm">{e.actorEmail ?? 'unknown'}</TD>
                    <TD>{before ? <CapabilityBadges names={before} /> : null}</TD>
                    <TD>{after ? <CapabilityBadges names={after} /> : null}</TD>
                    <TD muted className="whitespace-nowrap text-xs">
                      {formatDateTime(e.createdAt)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </section>
    </div>
  );
}
