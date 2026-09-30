/**
 * A list's settings: whether browsers may write to it, its form, its consent
 * text (versioned), what it keeps, and archiving.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { CONTACT_LAWFUL_BASES, CONTACT_LIST_KINDS } from '@rekey.dev/shared-types';
import { api, errorQuery, getApplication, readErrorFlash, PanelApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import { hasScope } from '@/lib/operator-scopes';
import { KIND_LABEL, LAWFUL_BASIS_LABEL, captureState, parseFieldSchema, readKind, readLawfulBasis } from '@/lib/lists';
import { savedStateKey } from '@/lib/saved-state-key';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { ApiErrorText } from '@/components/api-error';
import { Field, fieldInputCls } from '@/components/Field';
import { ListFieldsEditor } from '@/components/ListFieldsEditor';
import { getList } from '../shared';
import { ArchiveListButton } from '../archive-button';

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

const ERR: Record<string, string> = {
  'bad-fields': 'A field has a problem: names are a-z, 0-9 and _, each needs a label, names must be unique, and a Choice field needs choices.',
  'bad-retention': 'Retention is a whole number of days from 1 to 3650, or empty to keep submissions.',
  'missing-name': 'Give the list a name.',
  LIST_CAPTURE_UNPROTECTED: 'Add the site that hosts your form under Developer, Allowed origins & IPs first.',
  VALIDATION_ERROR: 'A field did not pass validation.',
  SCOPE_INSUFFICIENT: 'Your access does not let you change lists.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
};

function listPath(applicationId: string, listId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/lists/${encodeURIComponent(listId)}`;
}

async function send(applicationId: string, listId: string, call: () => Promise<unknown>, saved: string): Promise<void> {
  const base = `/applications/${applicationId}/lists/${listId}/settings`;
  try {
    await call();
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${base}?saved=${saved}`);
}

async function saveSettings(applicationId: string, listId: string, formData: FormData): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/lists/${listId}/settings`;
  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect(`${base}?error=missing-name`);
  const fields = parseFieldSchema(String(formData.get('fieldSchema') ?? ''));
  if (!fields.ok) redirect(`${base}?error=bad-fields`);
  const retentionRaw = String(formData.get('submissionRetentionDays') ?? '').trim();
  const retention = retentionRaw === '' ? null : Number(retentionRaw);
  if (retention !== null && (!Number.isInteger(retention) || retention < 1 || retention > 3650)) {
    redirect(`${base}?error=bad-retention`);
  }
  const description = String(formData.get('description') ?? '').trim();
  const consentText = String(formData.get('consentText') ?? '').trim();
  await send(
    applicationId,
    listId,
    () =>
      api({
        method: 'PATCH',
        path: listPath(applicationId, listId),
        body: {
          name,
          description: description || null,
          kind: readKind(formData.get('kind')),
          lawfulBasis: readLawfulBasis(formData.get('lawfulBasis')),
          ...(consentText && { consentText }),
          blockDisposable: formData.get('blockDisposable') === 'on',
          submissionRetentionDays: retention,
          fieldSchema: fields.defs,
        },
      }),
    'settings',
  );
}

async function setPublicCapture(applicationId: string, listId: string, on: boolean): Promise<void> {
  'use server';
  await send(
    applicationId,
    listId,
    () => api({ method: 'PATCH', path: listPath(applicationId, listId), body: { publicCapture: on } }),
    on ? 'capture-on' : 'capture-off',
  );
}

const SAVED: Record<string, string> = {
  settings: 'Settings saved.',
  'capture-on': 'Public capture is on. Forms on your allowed sites can subscribe with the publishable key.',
  'capture-off': 'Public capture is off. Only your server can subscribe people now.',
};

function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children && <p className="max-w-2xl text-xs leading-relaxed text-[var(--color-muted-fg)]">{children}</p>}
    </div>
  );
}

export default async function ListSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; listId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, listId } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail, fix } = await readErrorFlash(error);
  const saved = typeof sp.saved === 'string' ? SAVED[sp.saved] : undefined;
  const [list, application] = await Promise.all([getList(id, listId), getApplication(id)]);
  const origins = application.corsOrigins ?? [];
  const capture = captureState(list.publicCapture, origins);
  const canWrite = hasScope(application.access?.scopes ?? null, 'audience:write');
  const accessHref = `/applications/${id}/access`;

  return (
    <div className="space-y-4">
      {saved && <Banner tone="success">{saved}</Banner>}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
        </Banner>
      )}

      <Card className="scroll-mt-24 space-y-3" as="section">
        <div id="capture" className="flex flex-wrap items-start justify-between gap-3">
          <SectionTitle title="Public capture">
            When on, a form in the browser can subscribe with your publishable key, from the sites the Application
            allows. A browser always gets the same answer whatever happened and can never add back someone who
            left. Each visitor is limited to 5 subscribes a minute. Your server can subscribe people either way.
          </SectionTitle>
          {canWrite && (list.publicCapture || origins.length > 0) && (
            <ActionForm action={setPublicCapture.bind(null, id, listId, !list.publicCapture)}>
              {list.publicCapture ? (
                <ConfirmButton
                  variant="subtle"
                  title="Turn off Public capture?"
                  confirm="Forms that subscribe from the browser with your publishable key start being refused. Server actions and your backend keep working."
                  confirmLabel="Turn off"
                  triggerClassName="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-surface-muted)]"
                >
                  Turn off
                </ConfirmButton>
              ) : (
                <SubmitButton pendingLabel="Turning on…">Turn on</SubmitButton>
              )}
            </ActionForm>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {capture === 'server-only' && <Badge tone="neutral">Off: server only</Badge>}
          {capture === 'browser' && (
            <Badge tone="info" dot>
              On
            </Badge>
          )}
          {capture === 'browser-no-sites' && (
            <Badge tone="warning" dot>
              On, but no allowed sites
            </Badge>
          )}
          {origins.length > 0 ? (
            <>
              <span className="text-xs text-[var(--color-muted-fg)]">Allowed sites:</span>
              {origins.map((o) => (
                <Badge key={o} mono tone="neutral">
                  {o}
                </Badge>
              ))}
              <Link href={accessHref} className="text-xs text-[var(--color-primary)] hover:underline">
                Manage sites
              </Link>
            </>
          ) : (
            <span className="text-xs text-[var(--color-muted-fg)]">
              The Application has no allowed sites yet.{' '}
              <Link href={accessHref} className="text-[var(--color-primary)] hover:underline">
                Add one under Developer, Allowed origins &amp; IPs
              </Link>{' '}
              before turning this on.
            </span>
          )}
        </div>
      </Card>

      <ActionForm
        key={savedStateKey({
          name: list.name,
          description: list.description,
          kind: list.kind,
          lawfulBasis: list.lawfulBasis,
          consentVersion: list.consentVersion,
          blockDisposable: list.blockDisposable,
          submissionRetentionDays: list.submissionRetentionDays,
          fieldSchema: list.fieldSchema,
        })}
        action={saveSettings.bind(null, id, listId)}
        className="space-y-4"
      >
        <fieldset disabled={!canWrite} className="space-y-4">
          <Card as="section" className="space-y-4">
            <SectionTitle title="Basics" />
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <Field label="Name" required hint="Shown in the panel and returned to your form.">
                <input name="name" required maxLength={120} defaultValue={list.name} className={inputCls} />
              </Field>
              <Field label="Kind" hint="Only changes labels in the panel.">
                <select name="kind" defaultValue={list.kind} className={inputCls}>
                  {CONTACT_LIST_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Description" hint="For your team. Never shown to visitors.">
                <input name="description" maxLength={500} defaultValue={list.description ?? ''} className={inputCls} />
              </Field>
            </div>
          </Card>

          <Card as="section" className="scroll-mt-24 space-y-4">
            <div id="consent">
              <SectionTitle title="Consent">
                With consent as the lawful basis, every subscribe must say the person ticked your box, and which
                version of the text they saw. Changing the text creates the next version; forms still showing the
                old one are refused until they reload the list.
              </SectionTitle>
            </div>
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <Field label="Lawful basis">
                <select name="lawfulBasis" defaultValue={list.lawfulBasis} className={inputCls}>
                  {CONTACT_LAWFUL_BASES.map((b) => (
                    <option key={b} value={b}>
                      {LAWFUL_BASIS_LABEL[b]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={`Consent text, version ${list.consentVersion}`} hint="Shown next to the checkbox.">
              <textarea name="consentText" rows={2} maxLength={2000} defaultValue={list.consentText ?? ''} className={inputCls} />
            </Field>
            {list.consentVersions.length > 0 && (
              <details className="group rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">
                <summary className="cursor-pointer text-xs font-medium text-[var(--color-muted-fg)]">
                  Consent history ({list.consentVersions.length} {list.consentVersions.length === 1 ? 'version' : 'versions'})
                </summary>
                <ol className="mt-2 space-y-2">
                  {list.consentVersions.map((v) => (
                    <li key={v.version} className="border-l-2 border-[var(--color-border)] pl-3">
                      <div className="text-xs text-[var(--color-muted-fg)]">
                        Version {v.version} · {formatDateTime(v.createdAt)}
                      </div>
                      <div className="whitespace-pre-wrap">{v.text}</div>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </Card>

          <Card as="section" className="space-y-3">
            <SectionTitle title="Fields" />
            <ListFieldsEditor initial={list.fieldSchema} />
          </Card>

          <Card as="section" className="scroll-mt-24 space-y-4">
            <div id="data">
              <SectionTitle title="Data kept" />
            </div>
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <Field label="Delete submissions after (days)" hint="Empty keeps them until the person is erased.">
                <input
                  name="submissionRetentionDays"
                  type="number"
                  min={1}
                  max={3650}
                  defaultValue={list.submissionRetentionDays ?? ''}
                  className={inputCls}
                />
              </Field>
              <label className="flex min-h-[2.375rem] items-center gap-2 self-center text-sm">
                <input type="checkbox" name="blockDisposable" defaultChecked={list.blockDisposable} />
                Refuse disposable email addresses
              </label>
            </div>
          </Card>
        </fieldset>
        {canWrite && <StickyFormFooter hint="Changes apply to the next subscribe." />}
      </ActionForm>

      {canWrite && (
        <section
          id="archive"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50/40 px-5 py-4 dark:border-red-800 dark:bg-red-950/30"
        >
          <div className="max-w-xl">
            <h3 className="text-sm font-semibold">{list.archivedAt ? 'Restore this list' : 'Archive this list'}</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              {list.archivedAt
                ? 'Restoring lets forms subscribe people again and counts the list toward your workspace limit.'
                : 'An archived list refuses every subscribe and no longer counts toward your workspace limit. Members, submissions and the key are kept, and you can restore it later.'}
            </p>
          </div>
          <ArchiveListButton applicationId={id} listId={listId} name={list.name} archived={list.archivedAt !== null} />
        </section>
      )}
    </div>
  );
}
