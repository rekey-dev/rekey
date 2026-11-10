'use server';

/**
 * Profile changes a signed-in customer makes for themselves. Saving returns
 * its result to the form, so typed answers survive a refusal; deleting ends
 * in a redirect that carries no password or code.
 */

import { redirect } from 'next/navigation';
import { getPortalConfig } from './config';
import { customerCall } from './customer-call';
import { clearSession, getAccessToken } from './session';
import { isSessionRefusal } from './devices';
import { readProfileForm, type ProfileDraft } from './profile-form';
import { customerRecord, profileFields, profilePath } from './profile';
import {
  DELETE_CODE_SENT,
  DELETE_CONFIRMATION,
  PROFILE_FIX_FIELDS_COPY,
  PROFILE_SAVED_COPY,
  PROFILE_UNCHANGED_COPY,
  profileSaveErrorCopy,
} from './profile-copy';

export type ProfileSaveState = {
  status: 'idle' | 'saved' | 'refused';
  message: string;
  errors: Record<string, string>;
  draft: ProfileDraft | null;
};

async function signedIn(slug: string) {
  const [config, accessToken] = await Promise.all([getPortalConfig(slug), getAccessToken()]);
  if (!config || !accessToken) redirect(`/${slug}/login?reason=expired`);
  return { config, accessToken };
}

/** The fields are read again here, never taken from the form, so a posted key cannot name a field the customer was not shown. */
export async function saveProfileAction(
  slug: string,
  _previous: ProfileSaveState,
  formData: FormData,
): Promise<ProfileSaveState> {
  const { config, accessToken } = await signedIn(slug);
  const [fields, record] = await Promise.all([profileFields(config, accessToken), customerRecord(config, accessToken)]);
  if (!fields || !record) return { status: 'refused', message: profileSaveErrorCopy('UNAVAILABLE'), errors: {}, draft: null };
  const { patch, errors, draft } = readProfileForm(fields, record.profile, formData, { requireOnboarding: true });
  if (Object.keys(errors).length > 0) return { status: 'refused', message: PROFILE_FIX_FIELDS_COPY, errors, draft };
  if (Object.keys(patch).length === 0) return { status: 'saved', message: PROFILE_UNCHANGED_COPY, errors: {}, draft };
  const result = await customerCall(config, accessToken, 'PATCH', '/api/v1/users/me/profile', patch);
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    return { status: 'refused', message: profileSaveErrorCopy(result.code), errors: {}, draft };
  }
  return { status: 'saved', message: PROFILE_SAVED_COPY, errors: {}, draft };
}

/** Immediate and irreversible on the API's side, so the typed confirmation is checked before anything is sent. */
export async function deleteAccountAction(slug: string, formData: FormData): Promise<void> {
  if (String(formData.get('confirm') ?? '').trim() !== DELETE_CONFIRMATION) {
    redirect(`${profilePath(slug)}?error=confirm_mismatch`);
  }
  const password = String(formData.get('password') ?? '');
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  const emailCode = String(formData.get('emailCode') ?? '').replace(/\s/g, '');
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'DELETE', '/api/v1/users/me', {
    ...(password && { password }),
    ...(code && { code }),
    ...(emailCode && { emailCode }),
  });
  if (!result.ok && result.code !== 'END_USER_ERASED') {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    redirect(`${profilePath(slug)}?error=${encodeURIComponent(result.code)}`);
  }
  await clearSession(slug);
  redirect(`/${slug}/goodbye`);
}

/** For an account with no password and no two-factor: the API emails a code that confirms the deletion. */
export async function sendDeleteCodeAction(slug: string): Promise<void> {
  const { config, accessToken } = await signedIn(slug);
  const result = await customerCall(config, accessToken, 'POST', '/api/v1/auth/email-code', { purpose: 'delete_account' });
  if (!result.ok) {
    if (isSessionRefusal(result.code)) redirect(`/${slug}/login?reason=expired`);
    redirect(`${profilePath(slug)}?error=${encodeURIComponent(result.code)}`);
  }
  redirect(`${profilePath(slug)}?done=${DELETE_CODE_SENT}`);
}
