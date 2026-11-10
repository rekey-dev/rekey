'use client';

/**
 * The first-run profile questions. Answers that come back refused stay in the
 * form with the reason under the field, and focus moves to the first one.
 */

import * as React from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import type { ProfileFormState } from '@/lib/profile-completion-actions';
import { PROFILE_ANSWERS_REFUSED_COPY } from '@/lib/profile-completion-copy';
import { Banner } from './banner';
import { ProfileFields } from './profile-fields';
import { SubmitButton } from './submit-button';

export function ProfileQuestionsForm({
  fields,
  initialValues,
  action,
}: {
  fields: readonly ProfileField[];
  initialValues: Record<string, string>;
  action: (state: ProfileFormState, formData: FormData) => Promise<ProfileFormState>;
}): React.JSX.Element {
  const [state, formAction] = React.useActionState(action, {
    errors: {},
    formError: null,
    values: initialValues,
  });
  const formRef = React.useRef<HTMLFormElement>(null);
  const bannerRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (state.formError) bannerRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate>
      {state.formError && (
        <div ref={bannerRef} tabIndex={-1} className="outline-none">
          <Banner tone="error">{state.formError}</Banner>
        </div>
      )}
      {!state.formError && Object.keys(state.errors).length > 0 && (
        <Banner tone="error">{PROFILE_ANSWERS_REFUSED_COPY}</Banner>
      )}
      <ProfileFields fields={fields} values={state.values} errors={state.errors} enforceRequired />
      <SubmitButton pendingLabel="Saving…" className="w-full">
        Save and continue
      </SubmitButton>
    </form>
  );
}
