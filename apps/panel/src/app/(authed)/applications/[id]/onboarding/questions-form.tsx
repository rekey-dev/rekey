/**
 * The onboarding questions editor. One form edits the whole list, because the
 * API replaces it as a whole (`PUT .../profile-schema`). A field that has
 * answers keeps its key and type, so existing rows show the key as text and
 * the API refuses a retype. The form sends the `version` it was rendered
 * from, so a save made after someone else's is refused rather than undoing
 * theirs, and names each row by its key, never its position.
 */

import * as React from 'react';
import { redirect } from 'next/navigation';
import { PROFILE_FIELD_TYPES, type ProfileField } from '@rekey.dev/shared-types';
import { api, errorQuery, PanelApiError } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Card } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { fieldInputCls } from '@/components/Field';
import { savedStateKey } from '@/lib/saved-state-key';
import { fieldsFromForm, rowPrefix } from '@/lib/profile-fields-form';

export const onboardingUrl = (id: string): string => `/applications/${id}/onboarding`;
export const schemaPath = (id: string): string => `/api/v1/tenant/applications/${encodeURIComponent(id)}/profile-schema`;

const TYPE_LABEL: Record<(typeof PROFILE_FIELD_TYPES)[number], string> = {
  text: 'Text',
  select: 'Choice',
  number: 'Number',
  boolean: 'Yes / no',
  url: 'URL',
  date: 'Date',
};

async function saveFields(applicationId: string, version: number, formData: FormData): Promise<void> {
  'use server';
  try {
    await api({ method: 'PUT', path: schemaPath(applicationId), body: { fields: fieldsFromForm(formData), version } });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${onboardingUrl(applicationId)}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${onboardingUrl(applicationId)}?saved=1`);
}

export function QuestionsForm({
  applicationId,
  fields,
  version,
  canWrite,
}: {
  applicationId: string;
  fields: ProfileField[];
  version: number;
  canWrite: boolean;
}): React.JSX.Element {
  return (
    <ActionForm
      key={savedStateKey({ fields, version })}
      action={saveFields.bind(null, applicationId, version)}
      className="space-y-4"
    >
      <input type="hidden" name="keys" value={JSON.stringify(fields.map((f) => f.key))} />
      <fieldset disabled={!canWrite} className="space-y-3">
        {fields.length === 0 && (
          <p className="text-sm text-[var(--color-muted-fg)]">
            No questions yet. Add the first one below, for example Company, Role or Team size.
          </p>
        )}
        {fields.map((f) => (
          <FieldRow key={f.key} prefix={rowPrefix(f.key)} field={f} />
        ))}
        <Card className="space-y-3">
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Add a question</h3>
          <FieldRow prefix="new_" />
        </Card>
      </fieldset>
      {canWrite && <SubmitButton pendingLabel="Saving…">Save questions</SubmitButton>}
    </ActionForm>
  );
}

function FieldRow({ prefix, field }: { prefix: string; field?: ProfileField }): React.JSX.Element {
  const existing = field !== undefined;
  const inner = (
    <div className="grid gap-3 sm:grid-cols-[10rem_1fr_9rem_1fr]">
      <label className="space-y-1 text-xs">
        <span className="font-medium text-[var(--color-fg)]">Key</span>
        {existing ? (
          <>
            <input type="hidden" name={`${prefix}key`} value={field.key} />
            <span className="block py-2 font-mono text-sm">{field.key}</span>
          </>
        ) : (
          <input
            name={`${prefix}key`}
            placeholder="job_title"
            pattern="[a-z][a-z0-9_]{0,39}"
            title="Lowercase letters, digits and _, starting with a letter"
            className={`${fieldInputCls} font-mono`}
          />
        )}
      </label>
      <label className="space-y-1 text-xs">
        <span className="font-medium text-[var(--color-fg)]">Question</span>
        <input name={`${prefix}label`} defaultValue={field?.label ?? ''} maxLength={80} placeholder="Job title" className={fieldInputCls} />
      </label>
      <label className="space-y-1 text-xs">
        <span className="font-medium text-[var(--color-fg)]">Type</span>
        <select name={`${prefix}type`} defaultValue={field?.type ?? 'text'} className={fieldInputCls}>
          {PROFILE_FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-xs">
        <span className="font-medium text-[var(--color-fg)]">Choices</span>
        <textarea
          name={`${prefix}options`}
          defaultValue={field?.options?.join('\n') ?? ''}
          rows={Math.min(6, Math.max(2, field?.options?.length ?? 2))}
          placeholder={'Only for Choice, one per line:\n1\n2-10'}
          className={fieldInputCls}
        />
      </label>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs sm:col-span-4">
        <Check
          name={`${prefix}required`}
          checked={field?.requiredForOnboarding ?? false}
          label="Required to complete"
          title="Completing onboarding is refused until this is answered. Signing in and skipping never check it."
        />
        <Check name={`${prefix}showInList`} checked={field?.showInList ?? false} label="Show in the end-user list" />
        <Check name={`${prefix}pii`} checked={field?.pii ?? false} label="Personal data" />
        <label className="flex items-center gap-2">
          <span>Answered by</span>
          <select
            name={`${prefix}writableBy`}
            defaultValue={field?.writableBy ?? 'user'}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs"
          >
            <option value="user">the user</option>
            <option value="server">your server only</option>
          </select>
        </label>
        {existing && (
          <span className="ml-auto flex items-center gap-3">
            {field.requiredForOnboarding && <Badge tone="info">required</Badge>}
            <Check name={`${prefix}remove`} checked={false} label="Remove" />
          </span>
        )}
      </div>
    </div>
  );
  return existing ? <Card>{inner}</Card> : inner;
}

function Check({
  name,
  checked,
  label,
  title,
}: {
  name: string;
  checked: boolean;
  label: string;
  title?: string;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2" title={title}>
      <input type="checkbox" name={name} defaultChecked={checked} />
      <span>{label}</span>
    </label>
  );
}
