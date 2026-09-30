/**
 * One custom template: edit the draft, preview it with sample values, send a
 * test to yourself, and publish. Sends always use the latest published
 * version, so nothing here changes what goes out until Publish.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import type { CustomEmailTemplateDto } from '@rekey.dev/shared-types';
import { api, apiGet, errorQuery, readErrorFlash, PanelApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/date';
import {
  ineligibleReason,
  markUndeclared,
  parseLinkDomains,
  parseVariableSchema,
  splitUndeclared,
  type CustomEmailSettings,
} from '@/lib/custom-email';
import { Breadcrumb } from '@/components/Breadcrumb';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Button } from '@/components/Button';
import { ConfirmButton } from '@/components/ConfirmButton';
import { ApiErrorText } from '@/components/api-error';
import { EmailEditorClient } from '@/components/EmailEditorClient';
import { Field, fieldInputCls } from '@/components/Field';
import { VariableSchemaEditor } from '@/components/VariableSchemaEditor';
import { savedStateKey } from '@/lib/saved-state-key';

interface Preview {
  subject: string;
  html: string;
  text: string;
  fromName: string | null;
  category: string;
  undeclared: string[];
}

interface TestSendOutcome {
  kind: 'sent' | 'error';
  to: string;
  message?: string;
}

const inputCls = `${fieldInputCls} text-[var(--color-fg)]`;

const ERR: Record<string, string> = {
  missing: 'Subject and body are required.',
  'bad-design': 'The editor produced invalid design data. Reload the page and try again.',
  'missing-name': 'Give the template a name.',
  'bad-variables': 'The variable list has a problem.',
  'bad-domains': 'A link domain is not a hostname. Use hostnames such as links.example.com, without https:// or a path.',
  EMAIL_TEMPLATE_INVALID: 'The draft cannot be published yet.',
  EMAIL_TRANSPORT_NOT_CUSTOM: 'Connect your own Resend or SMTP in Settings to publish or send custom templates.',
  EMAIL_SENDER_DOMAIN_MISMATCH: 'Set a From address in Settings first.',
  EMAIL_ADDRESS_SUPPRESSED: 'Your address is on the suppression list, so no test was sent.',
  EMAIL_RATE_LIMITED: 'A send limit is reached. Try again later.',
  EMAIL_TEMPLATE_NOT_FOUND: 'This template no longer exists.',
  VALIDATION_ERROR: 'A field did not pass validation.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change email settings on this Application.',
};

function paths(applicationId: string, key: string): { page: string; api: string } {
  return {
    page: `/applications/${applicationId}/email/custom/${encodeURIComponent(key)}`,
    api: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/custom-email-templates/${encodeURIComponent(key)}`,
  };
}

async function call(pagePath: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${pagePath}?${await errorQuery(err)}`);
    throw err;
  }
}

async function saveDetails(applicationId: string, key: string, formData: FormData): Promise<void> {
  'use server';
  const p = paths(applicationId, key);
  const name = String(formData.get('name') ?? '').trim();
  const fromName = String(formData.get('fromName') ?? '').trim();
  if (!name) redirect(`${p.page}?error=missing-name`);
  const variables = parseVariableSchema(String(formData.get('variableSchema') ?? ''));
  if (!variables.ok) redirect(`${p.page}?error=bad-variables`);
  const links = parseLinkDomains(String(formData.get('linkDomains') ?? ''));
  if (links.invalid.length > 0) redirect(`${p.page}?error=bad-domains`);
  await call(p.page, () =>
    api({
      method: 'PATCH',
      path: p.api,
      body: {
        name,
        category: String(formData.get('category') ?? 'notification'),
        fromName: fromName === '' ? null : fromName,
        variableSchema: variables.defs,
        linkDomains: links.domains,
      },
    }),
  );
  redirect(`${p.page}?saved=details`);
}

async function saveContent(applicationId: string, key: string, formData: FormData): Promise<void> {
  'use server';
  const p = paths(applicationId, key);
  const subject = String(formData.get('subject') ?? '').trim();
  const designJsonRaw = String(formData.get('designJson') ?? '');
  const bodyHtml = String(formData.get('bodyHtml') ?? '');
  if (!subject || !designJsonRaw || !bodyHtml) redirect(`${p.page}?error=missing`);
  let designJson: unknown;
  try {
    designJson = JSON.parse(designJsonRaw);
  } catch {
    redirect(`${p.page}?error=bad-design`);
  }
  await call(p.page, () => api({ method: 'PATCH', path: p.api, body: { subject, designJson, bodyHtml } }));
  redirect(`${p.page}?saved=content`);
}

async function publish(applicationId: string, key: string): Promise<void> {
  'use server';
  const p = paths(applicationId, key);
  await call(p.page, () => api({ method: 'POST', path: `${p.api}/publish` }));
  redirect(`${p.page}?published=1`);
}

async function testSend(applicationId: string, key: string): Promise<void> {
  'use server';
  const p = paths(applicationId, key);
  let outcome: TestSendOutcome | null = null;
  await call(p.page, async () => {
    outcome = await api<TestSendOutcome>({ method: 'POST', path: `${p.api}/test-send` });
  });
  const result = outcome as TestSendOutcome | null;
  if (result?.kind !== 'sent') {
    // The provider's own words, carried in the flash cookie like an API error,
    // so the operator sees why without opening the Delivery tab.
    const failure = new PanelApiError({
      code: 'EMAIL_TEST_SEND_FAILED',
      message: `Your provider did not accept the test email: ${result?.message ?? 'it gave no reason.'}`,
      fix: 'Check the provider credentials and From address in Settings, then send the test again.',
      statusCode: 502,
    });
    redirect(`${p.page}?${await errorQuery(failure)}`);
  }
  redirect(`${p.page}?test=sent`);
}

async function remove(applicationId: string, key: string): Promise<void> {
  'use server';
  const p = paths(applicationId, key);
  await call(p.page, () => api({ method: 'DELETE', path: p.api }));
  redirect(`/applications/${applicationId}/email/custom?deleted=1`);
}

export default async function CustomTemplatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, key } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail, fix } = await readErrorFlash(error);
  const p = paths(id, key);

  const [template, settings, preview] = await Promise.all([
    apiGet<CustomEmailTemplateDto>(p.api, { interruptOnAccessError: false }).catch(() => null),
    apiGet<CustomEmailSettings>(`/api/v1/tenant/applications/${encodeURIComponent(id)}/custom-email-settings`, {
      interruptOnAccessError: false,
    }).catch(() => null),
    api<Preview>({ method: 'POST', path: `${p.api}/preview`, body: {} }).catch(() => null),
  ]);

  if (!template) {
    return (
      <Card className="space-y-2">
        <p className="text-sm">No custom template with the key {key} in this Application.</p>
        <Link href={`/applications/${id}/email/custom`} className="text-sm text-[var(--color-primary)] hover:underline">
          Back to custom templates
        </Link>
      </Card>
    );
  }

  const blocked = settings ? ineligibleReason(settings) : null;
  const flash =
    sp.created === '1'
      ? 'Draft created. Write the email below, then publish it.'
      : sp.saved === 'details'
        ? 'Details saved to the draft.'
        : sp.saved === 'content'
          ? 'Content saved to the draft.'
          : sp.published === '1'
            ? `Published as version ${template.version}. Sends now use it.`
            : sp.test === 'sent'
              ? 'Test email sent to your address.'
              : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Breadcrumb
            className="mb-1"
            items={[{ label: 'Custom templates', href: `/applications/${id}/email/custom` }, { label: template.name }]}
          />
          <h2 className="text-lg font-semibold">{template.name}</h2>
          <p className="font-mono text-[11px] text-[var(--color-muted-fg)]">{template.key}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted-fg)]">
            {template.status === 'published' ? (
              <Badge tone="success">Published v{template.version}</Badge>
            ) : (
              <Badge tone="warning">Draft, never published</Badge>
            )}
            {template.hasUnpublishedChanges && <Badge tone="warning">Unpublished changes</Badge>}
            {template.publishedAt && <span>Last published {formatDateTime(template.publishedAt)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {blocked ? (
            <Button disabled title="Connect your own Resend or SMTP in Settings first.">
              Publish
            </Button>
          ) : (
            <ActionForm action={publish.bind(null, id, key)}>
              <SubmitButton pendingLabel="Publishing…">
                {template.status === 'published' ? 'Publish changes' : 'Publish'}
              </SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={remove.bind(null, id, key)}>
            <ConfirmButton
              variant="subtle"
              title="Delete this template?"
              confirm="Sends stop: a backend still sending this key gets EMAIL_TEMPLATE_NOT_FOUND from now on. Published versions are kept for history, and creating the same key again starts a new draft."
              confirmLabel="Delete"
            >
              Delete
            </ConfirmButton>
          </ActionForm>
        </div>
      </div>

      {flash && <Banner tone="success">{flash}</Banner>}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={detail} fix={fix} map={ERR} />
        </Banner>
      )}
      {blocked && <Banner tone="warning">{blocked}</Banner>}

      <Card className="space-y-4">
        <h3 className="text-sm font-semibold">Details</h3>
        <ActionForm
          key={savedStateKey({
            name: template.name,
            category: template.category,
            fromName: template.fromName,
            linkDomains: template.linkDomains,
            variableSchema: template.variableSchema,
          })}
          action={saveDetails.bind(null, id, key)}
          className="space-y-4"
        >
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <Field label="Name" required>
              <input name="name" required maxLength={120} defaultValue={template.name} className={inputCls} />
            </Field>
            <Field label="Category" hint="Notification mail carries one-click unsubscribe; critical mail does not.">
              <select name="category" defaultValue={template.category} className={inputCls}>
                <option value="notification">Notification</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
            <Field
              label="From name"
              hint={`Optional. The address is always ${settings?.fromAddress ?? "your Application's From address"}.`}
            >
              <input name="fromName" maxLength={120} defaultValue={template.fromName ?? ''} className={inputCls} />
            </Field>
          </div>
          <Field label="Link domains" hint="Hostnames that link variables may point at, one per line. Exact match, https only.">
            <textarea
              name="linkDomains"
              rows={2}
              defaultValue={template.linkDomains.join('\n')}
              className={`${inputCls} font-mono`}
            />
          </Field>
          <div className="space-y-1">
            <span className="text-xs font-medium">Variables</span>
            <VariableSchemaEditor initial={template.variableSchema} />
          </div>
          <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
        </ActionForm>
      </Card>

      {/* Declared variables become the editor's merge tags, so every tag an
          operator can drag in is one the send will accept. */}
      <EmailEditorClient
        key={template.updatedAt}
        applicationId={id}
        eventKey={template.key}
        initialSubject={template.subject}
        initialDesignJson={template.designJson ?? null}
        action={saveContent.bind(null, id, key)}
        variables={template.variableSchema.map((v) => v.name)}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="space-y-3">
          <header>
            <h3 className="text-base font-semibold">Preview</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              The draft, rendered with each variable's sample value. Nothing is sent.
            </p>
          </header>
          {preview === null ? (
            <p className="text-sm text-[var(--color-muted-fg)]">The preview could not be rendered.</p>
          ) : (
            <>
              {preview.undeclared.length > 0 && (
                <Banner tone="warning">
                  Not declared: {preview.undeclared.map((n) => `{{${n}}}`).join(', ')}. Add{' '}
                  {preview.undeclared.length === 1 ? 'it' : 'them'} under Variables or remove{' '}
                  {preview.undeclared.length === 1 ? 'it' : 'them'} from the email. Publishing is refused until then.
                </Banner>
              )}
              <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
                <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs">
                  <strong>Subject:</strong>{' '}
                  {splitUndeclared(preview.subject, preview.undeclared).map((part, i) =>
                    part.undeclared ? (
                      <mark key={i} className="rounded-sm bg-amber-500/20 px-0.5 font-mono text-amber-700 dark:text-amber-400">
                        {part.text}
                      </mark>
                    ) : (
                      <React.Fragment key={i}>{part.text}</React.Fragment>
                    ),
                  )}
                </div>
                {/* Empty sandbox: operator HTML is not sanitised, so it gets no
                    scripts, no same-origin access and no navigation. White
                    canvas because email HTML is authored against one. */}
                <iframe
                  srcDoc={markUndeclared(preview.html, preview.undeclared)}
                  sandbox=""
                  title="Email preview"
                  className="w-full bg-white"
                  style={{ height: 480 }}
                />
              </div>
            </>
          )}
        </Card>

        <Card className="space-y-3">
          <header>
            <h3 className="text-base font-semibold">Send a test</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Sends the draft with sample values to your own address, through this Application's provider.
              Counts toward the send limits.
            </p>
          </header>
          {blocked ? (
            <Button disabled variant="secondary">
              Send test to me
            </Button>
          ) : (
            <ActionForm action={testSend.bind(null, id, key)}>
              <SubmitButton pendingLabel="Sending…">Send test to me</SubmitButton>
            </ActionForm>
          )}
          <div className="space-y-1 pt-2">
            <h4 className="text-xs font-semibold">Send from your backend</h4>
            <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-[11px]">
              {`await rekey.email.send({
  template: '${template.key}',
  to: user.email,
  variables: { ${template.variableSchema.map((v) => `${v.name}: ...`).join(', ')} },
  idempotencyKey: 'a-stable-id-for-this-email',
});`}
            </pre>
            <p className="text-[11px] text-[var(--color-muted-fg)]">
              Needs a secret key with the email:send scope (API Keys, Elevated scopes).
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
