/**
 * Lists: a waitlist, newsletter or contact form that stores people who have
 * no account yet. Rekey captures and hands off; it sends no email to a list.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { CONTACT_LAWFUL_BASES, CONTACT_LIST_KINDS, type ContactListDto } from '@rekey.dev/shared-types';
import { api, apiGet, errorQuery, getApplication, readErrorFlash, unlessBusy, PanelApiError } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { hasScope } from '@/lib/operator-scopes';
import {
  KIND_LABEL,
  LAWFUL_BASIS_LABEL,
  captureState,
  consentSummary,
  isListKey,
  readKind,
  readLawfulBasis,
} from '@/lib/lists';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { Modal } from '@/components/Modal';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ApiErrorText } from '@/components/api-error';
import { Field, fieldInputCls } from '@/components/Field';

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

const ERR: Record<string, string> = {
  'bad-key': 'Keys are 3 to 64 characters of a-z, 0-9 and _, starting with a letter.',
  'missing-name': 'Give the list a name.',
  LIST_KEY_TAKEN: 'This Application already has a list with that key, possibly archived.',
  CONTACT_LIST_QUOTA_EXCEEDED: 'This workspace is at its list limit. Archive a list you no longer use.',
  SCOPE_INSUFFICIENT: 'Your access does not include lists and contacts.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
};

async function createList(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/lists`;
  const key = String(formData.get('key') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const consentText = String(formData.get('consentText') ?? '').trim();
  if (!isListKey(key)) redirect(`${base}?error=bad-key&newList=1`);
  if (!name) redirect(`${base}?error=missing-name&newList=1`);
  let listId: string;
  try {
    const list = await api<ContactListDto>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/lists`,
      body: {
        key,
        name,
        kind: readKind(formData.get('kind')),
        lawfulBasis: readLawfulBasis(formData.get('lawfulBasis')),
        ...(consentText && { consentText }),
      },
    });
    listId = list.id;
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}&newList=1`);
    throw err;
  }
  redirect(`${base}/${encodeURIComponent(listId)}/embed?created=1`);
}

const STEPS = [
  ['Create a list', 'Give it a key such as waitlist. Your code uses the key; it never changes.'],
  ['Add the form', 'The Embed tab has code for a Next.js server action, a React component or any backend.'],
  ['See who joined', 'Members, what they agreed to and their answers show up here, in webhooks and in CSV.'],
] as const;

export default async function ListsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail, fix } = await readErrorFlash(error);
  const [page, application] = await Promise.all([
    apiGet<Page<ContactListDto>>(`/api/v1/tenant/applications/${encodeURIComponent(id)}/lists`, {
      interruptOnAccessError: false,
    }).catch(unlessBusy(() => null)),
    getApplication(id),
  ]);
  const origins = application.corsOrigins ?? [];
  const canWrite = hasScope(application.access?.scopes ?? null, 'audience:write');
  const lists = page ? [...page.items].sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null)) : [];
  const activeCount = lists.filter((l) => !l.archivedAt).length;
  const archivedCount = lists.length - activeCount;

  const createModal = canWrite ? (
    <Modal
      modalKey="newList"
      trigger="+ New list"
      title="New list"
      description="Your server can subscribe people straight away with a secret key. Browser forms need Public capture, which you can turn on in the list's settings."
      size="lg"
    >
      <ActionForm action={createList.bind(null, id)} className="space-y-4">
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
          </Banner>
        )}
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label="Key" required hint="Permanent. Your code subscribes by this key, e.g. waitlist.">
            <input
              name="key"
              required
              autoFocus
              pattern="[a-z][a-z0-9_]{2,63}"
              maxLength={64}
              placeholder="waitlist"
              className={`${inputCls} font-mono`}
            />
          </Field>
          <Field label="Name" required hint="Shown in the panel and returned to your form.">
            <input name="name" required maxLength={120} placeholder="Launch waitlist" className={inputCls} />
          </Field>
          <Field label="Kind" hint="Only changes labels in the panel.">
            <select name="kind" defaultValue="waitlist" className={inputCls}>
              {CONTACT_LIST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Lawful basis" hint="With consent, every subscribe must say the person ticked your box.">
            <select name="lawfulBasis" defaultValue="consent" className={inputCls}>
              {CONTACT_LAWFUL_BASES.map((b) => (
                <option key={b} value={b}>
                  {LAWFUL_BASIS_LABEL[b]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label="Consent text"
          hint="Shown next to the checkbox. Each change is kept as a new version, so you can always show what someone agreed to."
        >
          <textarea name="consentText" rows={2} maxLength={2000} placeholder="Email me when it launches." className={inputCls} />
        </Field>
        <div className="flex justify-end">
          <SubmitButton pendingLabel="Creating…">Create list</SubmitButton>
        </div>
      </ActionForm>
    </Modal>
  ) : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Lists"
        count={page ? `(${activeCount}${archivedCount > 0 ? ` active, ${archivedCount} archived` : ''})` : undefined}
        description="Waitlists, newsletters and contact forms for people who may not have an account. Rekey keeps who joined and what they agreed to, and hands it to you through webhooks, the API and CSV. It sends no email to a list."
        action={page && page.items.length > 0 ? createModal : undefined}
      />

      {error && !sp.newList && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
        </Banner>
      )}

      {page === null ? (
        <Banner tone="error">
          The lists could not be read. Either the request failed, or your access to this Application does not
          include lists and contacts. This is <strong>not</strong> an empty list.
        </Banner>
      ) : page.items.length === 0 ? (
        <Card className="space-y-5">
          <div className="max-w-2xl space-y-1">
            <h3 className="text-base font-semibold">Collect sign-ups before anyone has an account</h3>
            <p className="text-sm text-[var(--color-muted-fg)]">
              A list stores the people who join a waitlist, a newsletter or a contact form on your site, with the
              consent they gave. You do not need a database of your own.
            </p>
          </div>
          <ol className="grid gap-3 sm:grid-cols-3">
            {STEPS.map(([title, body], i) => (
              <li key={title} className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="text-xs font-medium text-[var(--color-muted-fg)] tabular-nums">Step {i + 1}</div>
                <div className="text-sm font-medium">{title}</div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-fg)]">{body}</p>
              </li>
            ))}
          </ol>
          {createModal ?? (
            <p className="text-xs text-[var(--color-muted-fg)]">Creating a list needs write access to lists and contacts.</p>
          )}
        </Card>
      ) : (
        <Table minWidth="min-w-[52rem]">
          <THead>
            <TR>
              <TH>List</TH>
              <TH>Status</TH>
              <TH>Public capture</TH>
              <TH>Consent</TH>
              <TH align="right">Members</TH>
              <TH align="right">Submissions</TH>
            </TR>
          </THead>
          <TBody>
            {lists.map((l) => {
              const capture = captureState(l.publicCapture, origins);
              const archived = l.archivedAt !== null;
              return (
                <TR key={l.id} hover>
                  <TD>
                    <Link
                      href={`/applications/${id}/lists/${encodeURIComponent(l.id)}`}
                      className={`font-medium hover:underline ${archived ? 'text-[var(--color-muted-fg)]' : 'text-[var(--color-primary)]'}`}
                    >
                      {l.name}
                    </Link>
                    <div className="text-[11px] text-[var(--color-muted-fg)]">
                      <span className="font-mono">{l.key}</span> · {KIND_LABEL[l.kind]}
                    </div>
                  </TD>
                  <TD>
                    {archived ? (
                      <Badge tone="warning" dot>
                        Archived
                      </Badge>
                    ) : (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    )}
                  </TD>
                  <TD>
                    {capture === 'server-only' && (
                      <Badge tone="neutral" title="Only your server, with a secret key, can subscribe.">
                        Server only
                      </Badge>
                    )}
                    {capture === 'browser' && (
                      <Badge tone="info" title={`Browsers on ${origins.join(', ')} can subscribe with the publishable key.`}>
                        On, {origins.length} {origins.length === 1 ? 'site' : 'sites'}
                      </Badge>
                    )}
                    {capture === 'browser-no-sites' && (
                      <Badge tone="warning" title="The Application has no allowed sites, so browsers are refused.">
                        On, no sites
                      </Badge>
                    )}
                  </TD>
                  <TD muted className="text-xs">
                    {consentSummary(l)}
                  </TD>
                  <TD align="right" className="tabular-nums">
                    {l.counts.subscribed}
                    {l.counts.unsubscribed > 0 && (
                      <div className="text-[11px] text-[var(--color-muted-fg)]">{l.counts.unsubscribed} left</div>
                    )}
                  </TD>
                  <TD align="right" muted className="tabular-nums">
                    {l.counts.submissions}
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}
    </div>
  );
}
