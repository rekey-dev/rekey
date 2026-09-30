/**
 * Onboarding: the questions new users answer, and how the record of their
 * answers, completion and skip reaches the app. Rekey records; the app
 * decides whether an unfinished user may carry on.
 */

import * as React from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import { api, getApplication, readErrorFlash } from '@/lib/api';
import { hasScope } from '@/lib/operator-scopes';
import { onboardingSnippets } from '@/lib/onboarding-snippets';
import { ApiErrorText } from '@/components/api-error';
import { SavedBanner } from '@/components/SavedBanner';
import { Card, SectionHeader } from '@/components/Card';
import { Banner } from '@/components/Banner';
import { CopyButton } from '@/components/CopyButton';
import { QuestionsForm, schemaPath } from './questions-form';
import { OnboardingStatusCounts } from './status-counts';

const ERR: Record<string, string> = {
  PROFILE_SCHEMA_INVALID: 'The questions were not saved: one of them is not valid.',
  PROFILE_FIELD_KEY_IMMUTABLE:
    'The questions were not saved: a question that users have answered cannot be removed or change type. Change its wording instead.',
  PROFILE_OPTION_IN_USE:
    'The questions were not saved: users picked a choice you removed. Keep it, or change those users\' answers first.',
  PROFILE_SCHEMA_CHANGED:
    'The questions were not saved: someone else saved them since you opened this page. The form now shows their version; reapply your change and save again.',
};

const HOW = [
  {
    title: 'Your app asks',
    body: 'After sign-up, your app shows the questions below and saves the answers to Rekey. You design the screen.',
  },
  {
    title: 'Rekey records',
    body: 'The answers, and whether the user completed or skipped, with the time. Webhooks user.onboarding_completed and user.onboarding_skipped fire once each.',
  },
  {
    title: 'Your app decides',
    body: 'Rekey never blocks sign-in or any request. Whether a user who has not finished may carry on, or must come back to the form, is up to your app.',
  },
] as const;

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const [app, schema] = await Promise.all([
    getApplication(id),
    api<{ fields: ProfileField[]; version: number }>({ method: 'GET', path: schemaPath(id) }),
  ]);
  const scopes = app.access?.scopes ?? null;
  const canWrite = hasScope(scopes, 'end-users:write');
  const showCounts = hasScope(scopes, 'overview:read') && app.reportingTimezone !== undefined;
  const fields = schema.fields;
  const required = fields.filter((f) => f.requiredForOnboarding).length;
  const snippets = onboardingSnippets(fields);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Onboarding"
        description="The questions you ask new users, and the record of how each user got on. Every user is pending until they complete or skip."
      />

      {showCounts && (
        <React.Suspense fallback={<div aria-busy="true" className="h-20 animate-pulse rounded-lg bg-[var(--color-surface-muted)]" />}>
          <OnboardingStatusCounts applicationId={id} />
        </React.Suspense>
      )}

      <ol className="grid gap-3 sm:grid-cols-3">
        {HOW.map((h, i) => (
          <li key={h.title} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="text-xs font-medium tabular-nums text-[var(--color-muted-fg)]">{i + 1}</div>
            <div className="text-sm font-semibold">{h.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-fg)]">{h.body}</p>
          </li>
        ))}
      </ol>

      <section className="space-y-3">
        <SectionHeader
          title="Questions"
          count={fields.length}
          description={
            required > 0
              ? `${required} of ${fields.length} ${fields.length === 1 ? 'is' : 'are'} required to complete. Required only affects completing: a user can still sign in, answer some questions or skip.`
              : 'None is required, so any user can complete onboarding. Mark a question required to refuse completing until it is answered.'
          }
        />
        {sp.saved === '1' && <SavedBanner message="Questions saved." />}
        {error && (
          <Banner tone="error">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </Banner>
        )}
        {!canWrite && (
          <Banner tone="info">You can read these questions. Changing them needs write access to end users.</Banner>
        )}
        <QuestionsForm applicationId={id} fields={fields} version={schema.version} canWrite={canWrite} />
      </section>

      <section className="space-y-3">
        <SectionHeader
          title="In your app"
          description="Examples using your own question keys. Each user's status and answers also show on their Overview in End-users."
        />
        {snippets.map((s) => (
          <Card key={s.label} className="space-y-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <h3 className="text-sm font-semibold">{s.label}</h3>
                <p className="max-w-2xl text-xs text-[var(--color-muted-fg)]">{s.when}</p>
              </div>
              <CopyButton value={s.code} label="Copy" />
            </div>
            <pre className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs">
              <code>{s.code}</code>
            </pre>
          </Card>
        ))}
      </section>
    </div>
  );
}
