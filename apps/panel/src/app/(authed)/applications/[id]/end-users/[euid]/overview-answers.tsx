/**
 * The Overview's onboarding answers: every profile field with this user's
 * answer or "not answered", and an edit dialog for operators who may write.
 * With no fields defined it points at the Profile fields page and shows the
 * free-form metadata instead, which is where such answers lived until now.
 */

import * as React from 'react';
import Link from '@/components/Link';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { SavedBanner } from '@/components/SavedBanner';
import { Modal } from '@/components/Modal';
import { Field, fieldInputCls } from '@/components/Field';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { savedStateKey } from '@/lib/saved-state-key';
import type { ProfileField, ProfileValue } from '@rekey.dev/shared-types';
import { isAnswered, isRetiredOption } from '@/lib/profile-answers';
import { saveProfileAnswers } from './actions';
import type { EndUserInsightsDto } from './insights';
import { AnswerValue } from './answer-value';

const PROFILE_ERROR_COPY: Record<string, string> = {
  PROFILE_FIELD_INVALID: 'One of the answers is not in the shape its field takes.',
  PROFILE_FIELD_UNKNOWN: 'A field was removed while you were editing. Reload and try again.',
  PROFILE_TOO_LARGE: 'The answers together are over 16 KB. Shorten some of them.',
  END_USER_ERASED: 'This end-user has been erased, so their answers cannot be changed.',
  PROFILE_FORM_INVALID: 'Nothing was saved: the form arrived incomplete. Reload the page and try again.',
};

/** The input's value for an answer, which is also what the form sends back as unchanged. */
function inputValue(answers: Record<string, ProfileValue>, key: string): string {
  return isAnswered(answers, key) ? String(answers[key]) : '';
}

export function OnboardingAnswers({
  applicationId,
  euid,
  profile,
  metadata,
  canWrite,
  erased,
  saved,
  error,
}: {
  applicationId: string;
  euid: string;
  profile: EndUserInsightsDto['profile'] | null;
  metadata: unknown;
  canWrite: boolean;
  erased: boolean;
  saved: boolean;
  error: string | undefined;
}): React.JSX.Element {
  const fieldsHref = `/applications/${applicationId}/onboarding`;
  if (profile === null) {
    return (
      <Card className="space-y-2">
        <SectionHeader title="Onboarding answers" />
        <p className="text-sm text-[var(--color-muted-fg)]">The answers could not be read. Reload to try again.</p>
      </Card>
    );
  }
  if (profile.fields.length === 0) {
    return (
      <Card className="space-y-3">
        <SectionHeader title="Onboarding answers" />
        <p className="text-sm text-[var(--color-muted-fg)]">
          No onboarding questions defined.{' '}
          <Link href={fieldsHref} className="underline underline-offset-2 hover:text-[var(--color-fg)]">
            Add them in Users, Onboarding
          </Link>
          .
        </p>
        {metadata !== null && metadata !== undefined && Object.keys(metadata as object).length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--color-muted-fg)]">Raw metadata</summary>
            <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 font-mono text-[11px]">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </details>
        )}
      </Card>
    );
  }

  const types = Object.fromEntries(profile.fields.map((f) => [f.key, f.type]));
  return (
    <Card className="space-y-3">
      <SectionHeader
        title="Onboarding answers"
        description={
          profile.onboardingCompletedAt
            ? 'Onboarding complete.'
            : profile.onboardingSkippedAt
              ? 'They skipped onboarding. Your app decides whether to ask again.'
              : profile.missingRequired.length > 0
              ? `${profile.missingRequired.length} required ${profile.missingRequired.length === 1 ? 'answer is' : 'answers are'} missing.`
              : 'Every required answer is in; onboarding has not been marked complete.'
        }
        action={
          canWrite && !erased ? (
            <Modal
              title="Edit onboarding answers"
              description="Operators can set every field, including ones only your server may write. Leave a field empty to clear it."
              trigger="Edit"
              triggerClassName="text-xs font-medium text-[var(--color-fg)] hover:underline"
              modalKey="editProfile"
            >
              <ActionForm
                key={savedStateKey(profile.answers)}
                action={saveProfileAnswers.bind(null, applicationId, euid)}
                className="space-y-3"
              >
                {error && <Banner tone="error">{PROFILE_ERROR_COPY[error] ?? `The answers were not saved (${error}).`}</Banner>}
                <input type="hidden" name="types" value={JSON.stringify(types)} />
                {profile.fields.map((f) => (
                  <Field
                    key={f.key}
                    label={f.label}
                    hint={
                      isRetiredOption(f, profile.answers[f.key])
                        ? 'The current answer is no longer an option. It is kept unless you pick another.'
                        : f.writableBy === 'server'
                          ? 'Set by your server'
                          : undefined
                    }
                  >
                    <input type="hidden" name={`o_${f.key}`} value={inputValue(profile.answers, f.key)} />
                    <AnswerInput field={f} value={inputValue(profile.answers, f.key)} />
                  </Field>
                ))}
                <SubmitButton pendingLabel="Saving…">Save answers</SubmitButton>
              </ActionForm>
            </Modal>
          ) : undefined
        }
      />
      {saved && <SavedBanner params={['profileSaved']} message="Answers saved." />}
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        {profile.fields.map((f) => {
          return (
            <div key={f.key} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs text-[var(--color-muted-fg)]">
                {f.label}
                {f.requiredForOnboarding && <span title="Required for onboarding">*</span>}
                {f.pii && (
                  <Badge tone="neutral" mono>
                    pii
                  </Badge>
                )}
              </dt>
              <dd className="truncate text-[var(--color-fg)]">
                <AnswerValue field={f} answers={profile.answers} />
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

function AnswerInput({ field, value }: { field: ProfileField; value: string }): React.JSX.Element {
  const name = `f_${field.key}`;
  switch (field.type) {
    case 'select': {
      const retired = value !== '' && !field.options!.includes(value);
      return (
        <select name={name} defaultValue={value} className={fieldInputCls}>
          <option value="">Not answered</option>
          {retired && <option value={value}>{value} (no longer an option)</option>}
          {field.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    case 'boolean':
      return (
        <select name={name} defaultValue={value} className={fieldInputCls}>
          <option value="">Not answered</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'number':
      return <input type="number" step="any" name={name} defaultValue={value} className={fieldInputCls} />;
    case 'url':
      return <input type="url" name={name} defaultValue={value} className={fieldInputCls} />;
    case 'date':
      return <input type="date" name={name} defaultValue={value} className={fieldInputCls} />;
    default:
      return <input type="text" name={name} maxLength={500} defaultValue={value} className={fieldInputCls} />;
  }
}
