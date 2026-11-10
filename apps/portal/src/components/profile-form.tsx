'use client';

import * as React from 'react';
import type { ProfileField } from '@rekey.dev/shared-types';
import type { ProfileSaveState } from '@/lib/profile-actions';
import type { ProfileDraft } from '@/lib/profile-form';
import { Banner } from './banner';
import { ProfileFields } from './profile-fields';
import { SubmitButton } from './submit-button';

const INITIAL: ProfileSaveState = { status: 'idle', message: '', errors: {}, draft: null };

export function ProfileForm({
  fields,
  stored,
  save,
}: {
  fields: readonly ProfileField[];
  stored: ProfileDraft;
  save: (previous: ProfileSaveState, formData: FormData) => Promise<ProfileSaveState>;
}): React.JSX.Element {
  const [state, action] = React.useActionState(save, INITIAL);
  return (
    <form action={action} className="space-y-4">
      <div aria-live="polite">
        {state.status !== 'idle' && <Banner tone={state.status === 'saved' ? 'success' : 'error'}>{state.message}</Banner>}
      </div>
      <ProfileFields fields={fields} values={state.draft ?? stored} errors={state.errors} enforceRequired />
      <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
    </form>
  );
}
