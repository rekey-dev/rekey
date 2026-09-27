/**
 * Custom templates: the Application's own transactional email, registered
 * here and sent from its backend with `rekey.email.send({ template, ... })`.
 *
 * Only an Application with its own Resend or SMTP provider can publish or
 * send these, so the page leads with that state. Drafts can be prepared
 * before the provider is connected.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import type { CustomEmailTemplateDto } from '@rekey.dev/shared-types';
import { api, apiGet, errorQuery, readErrorFlash, PanelApiError } from '@/lib/api';
import type { Page } from '@/lib/paginate';
import { formatDateTime } from '@/lib/date';
import {
  ineligibleReason,
  isTemplateKey,
  parseLinkDomains,
  parseVariableSchema,
  starterHtml,
  type CustomEmailSettings,
} from '@/lib/custom-email';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { EmptyState } from '@/components/EmptyState';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { ApiErrorText } from '@/components/api-error';
import { Field, fieldInputCls } from '@/components/Field';
import { VariableSchemaEditor } from '@/components/VariableSchemaEditor';

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

const ERR: Record<string, string> = {
  'bad-key': 'Keys are 3 to 64 characters of a-z, 0-9 and _, starting with a letter.',
  'missing-name': 'Give the template a name.',
  'missing-subject': 'Enter a subject.',
  'bad-variables': 'The variable list has a problem.',
  'bad-domains': 'A link domain is not a hostname. Use hostnames such as links.example.com, without https:// or a path.',
  EMAIL_TEMPLATE_KEY_TAKEN: 'This Application already has a template with that key.',
  EMAIL_TEMPLATE_LIMIT_REACHED: 'This Application already holds 200 custom templates.',
  VALIDATION_ERROR: 'A field did not pass validation. Keys cannot reuse a built-in email key such as welcome or password_reset.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change email settings on this Application.',
};

async function createTemplate(applicationId: string, formData: FormData): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/email/custom`;
  const key = String(formData.get('key') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const subject = String(formData.get('subject') ?? '').trim();
  const category = String(formData.get('category') ?? 'notification');
  if (!isTemplateKey(key)) redirect(`${base}?error=bad-key`);
  if (!name) redirect(`${base}?error=missing-name`);
  if (!subject) redirect(`${base}?error=missing-subject`);
  const variables = parseVariableSchema(String(formData.get('variableSchema') ?? ''));
  if (!variables.ok) redirect(`${base}?error=bad-variables`);
  const links = parseLinkDomains(String(formData.get('linkDomains') ?? ''));
  if (links.invalid.length > 0) redirect(`${base}?error=bad-domains`);
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/custom-email-templates`,
      body: {
        key,
        name,
        category,
        subject,
        bodyHtml: starterHtml(variables.defs),
        variableSchema: variables.defs,
        linkDomains: links.domains,
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${base}/${encodeURIComponent(key)}?created=1`);
}

async function setRecipientsMustBeEndUsers(applicationId: string, value: boolean): Promise<void> {
  'use server';
  const base = `/applications/${applicationId}/email/custom`;
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/custom-email-settings`,
      body: { recipientsMustBeEndUsers: value },
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${base}?settings=saved`);
}

export default async function CustomTemplatesPage({
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
  const appPath = `/api/v1/tenant/applications/${encodeURIComponent(id)}`;

  const [settings, page] = await Promise.all([
    apiGet<CustomEmailSettings>(`${appPath}/custom-email-settings`, { interruptOnAccessError: false }).catch(() => null),
    apiGet<Page<CustomEmailTemplateDto>>(`${appPath}/custom-email-templates`, { interruptOnAccessError: false }).catch(
      () => null,
    ),
  ]);
  const blocked = settings ? ineligibleReason(settings) : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Custom templates"
        count={page ? `(${page.page.total})` : undefined}
        description="Your own transactional email. Register a template here, publish it, then send it from your backend by key with rekey.email.send(). The send call carries only the recipient and the variable values."
      />

      {sp.settings === 'saved' && <Banner tone="success">Settings saved.</Banner>}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
        </Banner>
      )}

      {blocked && (
        <Banner tone="warning">
          <p>{blocked}</p>
          <p className="mt-1 text-xs">
            You can still create and edit drafts. Publishing, test sends and API sends stay off until the
            provider is connected.{' '}
            <Link href={`/applications/${id}/email`} className="underline">
              Open Settings
            </Link>
          </p>
        </Banner>
      )}

      {settings && (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Only send to end users</h3>
              <p className="text-xs text-[var(--color-muted-fg)]">
                {settings.recipientsMustBeEndUsers
                  ? 'On. A send to an address that is not an end user of this Application is refused.'
                  : 'Off. A send may go to any valid address.'}{' '}
                Custom sends across this workspace are capped at {settings.caps.daily} per day and{' '}
                {settings.caps.recipientHourly} per recipient per hour.
              </p>
            </div>
            <ActionForm action={setRecipientsMustBeEndUsers.bind(null, id, !settings.recipientsMustBeEndUsers)}>
              <SubmitButton pendingLabel="Saving…">
                {settings.recipientsMustBeEndUsers ? 'Allow any address' : 'Restrict to end users'}
              </SubmitButton>
            </ActionForm>
          </div>
        </Card>
      )}

      {page === null ? (
        <Banner tone="error">
          The template list could not be read. Either the request failed, or your access to this Application
          does not cover it. This is <strong>not</strong> an empty list.
        </Banner>
      ) : page.items.length === 0 ? (
        <EmptyState
          variant="inline"
          title="No custom templates yet"
          description="Create one below. It starts as a draft; nothing can be sent until it is published."
        />
      ) : (
        <Table minWidth="min-w-[40rem]">
          <THead>
            <TR>
              <TH>Template</TH>
              <TH>Category</TH>
              <TH>Status</TH>
              <TH>Updated</TH>
            </TR>
          </THead>
          <TBody>
            {page.items.map((t) => (
              <TR key={t.id} hover>
                <TD>
                  <Link
                    href={`/applications/${id}/email/custom/${encodeURIComponent(t.key)}`}
                    className="font-medium text-[var(--color-primary)] hover:underline"
                  >
                    {t.name}
                  </Link>
                  <div className="font-mono text-[11px] text-[var(--color-muted-fg)]">{t.key}</div>
                </TD>
                <TD>
                  <Badge tone={t.category === 'critical' ? 'info' : 'neutral'}>{t.category}</Badge>
                </TD>
                <TD>
                  {t.status === 'published' ? (
                    <Badge tone="success">v{t.version}</Badge>
                  ) : (
                    <Badge tone="warning">Draft</Badge>
                  )}{' '}
                  {t.hasUnpublishedChanges && <Badge tone="warning">Unpublished changes</Badge>}
                </TD>
                <TD muted className="whitespace-nowrap text-xs">
                  {formatDateTime(t.updatedAt)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Card className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">New template</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Declare every value your backend will pass. A send with an undeclared variable is refused, and a
            link variable may only point at the link domains listed here.
          </p>
        </div>
        <ActionForm action={createTemplate.bind(null, id)} className="space-y-4">
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label="Key" required hint="Permanent. Your backend sends by this key, e.g. order_shipped.">
              <input name="key" required pattern="[a-z][a-z0-9_]{2,63}" maxLength={64} className={`${inputCls} font-mono`} />
            </Field>
            <Field label="Name" required hint="Shown in the panel only.">
              <input name="name" required maxLength={120} className={inputCls} />
            </Field>
            <Field label="Subject" required hint="May use variables, e.g. Order {{orderNumber}} shipped.">
              <input name="subject" required maxLength={998} className={inputCls} />
            </Field>
            <Field
              label="Category"
              hint="Notification mail carries a one-click unsubscribe link, which stops notification mail only. Critical mail (receipts, security notices) has no unsubscribe link."
            >
              <select name="category" defaultValue="notification" className={inputCls}>
                <option value="notification">Notification</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
          </div>
          <Field label="Link domains" hint="Hostnames that link variables may point at, one per line. Exact match, https only.">
            <textarea name="linkDomains" rows={2} placeholder="track.example.com" className={`${inputCls} font-mono`} />
          </Field>
          <div className="space-y-1">
            <span className="text-xs font-medium">Variables</span>
            <VariableSchemaEditor initial={[]} />
          </div>
          <SubmitButton pendingLabel="Creating…">Create draft</SubmitButton>
        </ActionForm>
      </Card>
    </div>
  );
}
