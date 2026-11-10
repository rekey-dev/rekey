/**
 * The inputs for an application's profile fields, one per field, labelled and
 * with its error underneath. Renders no `<form>` and no button: the caller
 * owns the form, its action and its submit, so the profile page and the
 * first-run questions share it. Input names come from `profileInputName`, and
 * `readProfileForm` in `lib/profile-form.ts` reads them back.
 */

import * as React from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import { MAX_PROFILE_TEXT } from '@rekey.dev/shared-types/profile-limits';
import { profileInputName, type ProfileDraft } from '@/lib/profile-form';

export interface ProfileFieldsProps {
  /** The fields to ask, in order. Pass only `writableBy: 'user'` ones: the API refuses the rest. */
  fields: readonly ProfileField[];
  /** Input text per field key: `draftOf(fields, profile)`, or the draft a refused save returned. */
  values: ProfileDraft;
  /** Message per field key, shown under that field and tied to it with `aria-describedby`. */
  errors?: Readonly<Record<string, string>>;
  /** Marks `requiredForOnboarding` fields `required`. Off on a page where clearing an answer is allowed. */
  enforceRequired?: boolean;
}

const inputCls =
  'w-full min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]';

function inputFor(
  field: ProfileField,
  common: { id: string; name: string; defaultValue: string; required: boolean; 'aria-invalid'?: true; 'aria-describedby'?: string },
): React.JSX.Element {
  switch (field.type) {
    case 'select':
      return (
        <select {...common} className={inputCls}>
          <option value="">Not set</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'boolean':
      return (
        <select {...common} className={inputCls}>
          <option value="">Not set</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case 'number':
      return <input {...common} type="number" step="any" inputMode="decimal" className={inputCls} />;
    case 'url':
      return <input {...common} type="url" inputMode="url" placeholder="https://" className={inputCls} />;
    case 'date':
      return <input {...common} type="date" className={inputCls} />;
    default:
      return <input {...common} type="text" maxLength={MAX_PROFILE_TEXT} className={inputCls} />;
  }
}

export function ProfileFields({ fields, values, errors = {}, enforceRequired = false }: ProfileFieldsProps): React.JSX.Element {
  const baseId = React.useId();
  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const id = `${baseId}-${field.key}`;
        const error = errors[field.key];
        const required = enforceRequired && field.requiredForOnboarding;
        return (
          <div key={field.key} className="space-y-1.5">
            <label htmlFor={id} className="block text-sm font-medium text-[var(--color-fg)]">
              {field.label}
              {required && <span className="text-[var(--color-muted-fg)]"> (required)</span>}
            </label>
            {inputFor(field, {
              id,
              name: profileInputName(field.key),
              defaultValue: values[field.key] ?? '',
              required,
              ...(error && { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` }),
            })}
            {error && (
              <p id={`${id}-error`} className="text-xs text-[var(--color-danger)]">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
