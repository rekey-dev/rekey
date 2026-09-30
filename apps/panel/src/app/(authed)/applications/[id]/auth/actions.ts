'use server';

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';
import { PRIMARY_METHODS } from './methods';

export async function saveAuth(applicationId: string, formData: FormData): Promise<void> {
  const methods = PRIMARY_METHODS.filter((m) => formData.get(`method_${m.key}`) === 'on').map(
    (m) => m.key,
  );
  const signupModeRaw = String(formData.get('signupMode') ?? 'public');
  const signupMode = (
    ['public', 'secret_only', 'invite_only'].includes(signupModeRaw) ? signupModeRaw : 'public'
  ) as 'public' | 'secret_only' | 'invite_only';
  const passwordMinLength = Math.max(8, Number(formData.get('passwordMinLength') ?? 8) || 8);
  const mfaRaw = String(formData.get('mfa') ?? 'optional');
  const mfa = (['off', 'optional', 'required'].includes(mfaRaw) ? mfaRaw : 'optional') as
    | 'off'
    | 'optional'
    | 'required';
  const organizationsEnabled = formData.get('organizationsEnabled') === 'on';
  const passwordBreachCheckEnabled = formData.get('passwordBreachCheckEnabled') === 'on';
  const sendVerificationEmailOnSignUp = formData.get('sendVerificationEmailOnSignUp') === 'on';
  const requireEmailVerification = formData.get('requireEmailVerification') === 'on';
  const welcomeEmailRaw = String(formData.get('welcomeEmail') ?? 'on_signup');
  const welcomeEmail = (
    ['on_signup', 'on_verified', 'off'].includes(welcomeEmailRaw) ? welcomeEmailRaw : 'on_signup'
  ) as 'on_signup' | 'on_verified' | 'off';
  // Same shape as `mfa` and `tokenAlg`: a closed set, defaulted rather
  // than trusted, because the value arrives from a form post.
  const deviceBindingRaw = String(formData.get('deviceBinding') ?? 'optional');
  const deviceBinding = (deviceBindingRaw === 'required' ? 'required' : 'optional') as
    | 'optional'
    | 'required';
  // Only ever HS256 or RS256, anything else is a crafted form post, and the
  // API would reject it anyway. Falling back to HS256 keeps the default.
  const rawAlg = String(formData.get('tokenAlg') ?? '');
  const tokenAlg = rawAlg === 'RS256' ? 'RS256' : 'HS256';
  const redirectUrls = String(formData.get('redirectUrls') ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Empty string is meaningful, it CLEARS the stored URL. Sending it through
  // unchanged is what lets an operator remove a stale value; the API treats
  // '' and null identically.
  const appUrl = String(formData.get('appUrl') ?? '').trim();
  const allowedDomains = domainLines(formData.get('allowedDomains'));
  const blockedDomains = domainLines(formData.get('blockedDomains'));
  const blockDisposable = formData.get('blockDisposable') === 'on';
  // Nothing set means no rules at all, so clear them rather than store an
  // empty object that reads back as "configured".
  const signupRestrictions =
    allowedDomains.length === 0 && blockedDomains.length === 0 && !blockDisposable
      ? null
      : { allowedDomains, blockedDomains, blockDisposable };

  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/auth-config`,
      body: {
        methods,
        signupMode,
        passwordMinLength,
        mfa,
        organizationsEnabled,
        passwordBreachCheckEnabled,
        sendVerificationEmailOnSignUp,
        requireEmailVerification,
        welcomeEmail,
        deviceBinding,
        tokenAlg,
        redirectUrls,
        appUrl,
        signupRestrictions,
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/auth?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/auth?saved=1`);
}

/** One domain per line (commas also split), blanks dropped. The API normalises and validates. */
function domainLines(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
