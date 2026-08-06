import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { errorQuery, readErrorFlash, api, PanelApiError } from '@/lib/api';
import { EmailEditorClient } from '@/components/EmailEditorClient';
import { ApiErrorText } from '@/components/api-error';
import { ConfirmButton } from '@/components/ConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';
import { Banner } from '@/components/Banner';

interface TemplateRow {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  customised: boolean;
  designJson: unknown | null;
  variables: readonly string[];
}

interface PreviewRow {
  subject: string;
  html: string;
  text: string;
  customised: boolean;
}

interface EventListRow {
  key: string;
  label: string;
}

const ERR: Record<string, string> = {
  missing: 'Subject and body are required.',
  'bad-design': 'The editor produced invalid design data — reload the page and try again.',
  'missing-to': 'Enter an email address to send the test to.',
  EMAIL_EVENT_UNKNOWN: 'Unknown email event — this template no longer exists.',
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can edit email templates.',
  APPLICATION_NOT_FOUND: 'Application not found.',
};

async function saveTemplate(applicationId: string, eventKey: string, formData: FormData): Promise<void> {
  'use server';
  const subject = String(formData.get('subject') ?? '').trim();
  const designJsonRaw = String(formData.get('designJson') ?? '');
  const bodyHtml = String(formData.get('bodyHtml') ?? '');
  if (!subject || !designJsonRaw || !bodyHtml) {
    redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?error=missing`);
  }
  let designJson: unknown;
  try {
    designJson = JSON.parse(designJsonRaw);
  } catch {
    redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?error=bad-design`);
  }
  try {
    await api({
      method: 'PUT',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-templates/${encodeURIComponent(eventKey)}`,
      body: { subject, designJson, bodyHtml },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?saved=1`);
}

async function revertTemplate(applicationId: string, eventKey: string): Promise<void> {
  'use server';
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-templates/${encodeURIComponent(eventKey)}`,
  });
  redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?reverted=1`);
}

async function testSend(applicationId: string, eventKey: string, formData: FormData): Promise<void> {
  'use server';
  const to = String(formData.get('to') ?? '').trim();
  if (!to) {
    redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?error=missing-to`);
  }
  try {
    await api({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/email-templates/${encodeURIComponent(eventKey)}/test-send`,
      body: { to },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/email/${encodeURIComponent(eventKey)}?test=sent`);
}

export default async function TemplateEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; eventKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, eventKey } = await params;
  const sp = await searchParams;
  const saved = typeof sp.saved === 'string';
  const reverted = typeof sp.reverted === 'string';
  const testSent = sp.test === 'sent';
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);

  const [template, preview, events] = await Promise.all([
    api<TemplateRow | null>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-templates/${encodeURIComponent(eventKey)}`,
    }),
    api<PreviewRow>({
      method: 'POST',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-templates/${encodeURIComponent(eventKey)}/preview`,
      body: {},
    }),
    // For the friendly heading — the per-event endpoint doesn't return the label.
    api<EventListRow[]>({
      method: 'GET',
      path: `/api/v1/tenant/applications/${encodeURIComponent(id)}/email-templates`,
    }).catch(() => [] as EventListRow[]),
  ]);

  const heading = events.find((e) => e.key === eventKey)?.label ?? eventKey;

  if (!template) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <p className="text-sm">Unknown event: {eventKey}</p>
        <Link href={`/applications/${id}/email`} className="text-sm text-[var(--color-primary)] hover:underline">
          ← Back to email
        </Link>
      </div>
    );
  }

  const saveBound = saveTemplate.bind(null, id, eventKey);
  const revertBound = revertTemplate.bind(null, id, eventKey);
  const testSendBound = testSend.bind(null, id, eventKey);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <Link
            href={`/applications/${id}/email`}
            className="text-xs text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
          >
            ← Email
          </Link>
          <h2 className="text-lg font-semibold mt-0.5">{heading}</h2>
          {heading !== eventKey && (
            <p className="font-mono text-[11px] text-[var(--color-muted-fg)]">{eventKey}</p>
          )}
          <p className="text-xs text-[var(--color-muted-fg)]">
            {template.customised
              ? 'Customized for this Application. Revert to drop your changes.'
              : 'Showing the Rekey default. Save to customize.'}
          </p>
        </div>
        {template.customised && (
          <form action={revertBound}>
            <ConfirmButton confirm="Revert this template to the Rekey default? Your custom subject + body will be lost.">
              Revert to default
            </ConfirmButton>
          </form>
        )}
      </div>

      {(saved || reverted || testSent) && (
        <SavedBanner
          params={['saved', 'reverted', 'test']}
          message={saved ? 'Template saved.' : reverted ? 'Reverted to the built-in default.' : 'Test email sent.'}
        />
      )}
      {error && (
        <Banner tone="error">
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
        </Banner>
      )}

      <EmailEditorClient
        applicationId={id}
        eventKey={eventKey}
        initialSubject={template.subject}
        initialDesignJson={template.designJson}
        action={saveBound}
        variables={template.variables}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
          <header>
            <h3 className="text-base font-semibold">Preview</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Rendered with the event's sample values (see API events.ts).
            </p>
          </header>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            <div className="px-3 py-2 text-xs border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]">
              <strong>Subject:</strong> {preview.subject}
            </div>
            {/* bg-white is deliberate (no dark: variant): email HTML is
                authored against a white canvas — rendering it on a dark
                surface would break most templates. */}
            <iframe
              srcDoc={preview.html}
              sandbox=""
              title="Email preview"
              className="w-full bg-white"
              style={{ height: 480 }}
            />
          </div>
        </section>

        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-3">
          <header>
            <h3 className="text-base font-semibold">Send a test</h3>
            <p className="text-xs text-[var(--color-muted-fg)]">
              Renders with sample values and sends via the Application's configured transport.
            </p>
          </header>
          <form action={testSendBound} className="flex items-end gap-2">
            <label className="block flex-1 space-y-1.5">
              <span className="text-sm font-medium">To</span>
              <input
                type="email"
                name="to"
                required
                placeholder="you@example.com"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
              />
            </label>
            <SubmitButton pendingLabel="Sending…">Send test</SubmitButton>
          </form>
        </section>
      </div>
    </div>
  );
}
