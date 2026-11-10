import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { customerRecord, profileFields } from '@/lib/profile';
import { draftOf } from '@/lib/profile-form';
import {
  DELETE_CODE_SENT,
  DELETE_CODE_SENT_COPY,
  DELETE_CONFIRMATION,
  EMAIL_CHANGE_SENT,
  EMAIL_CHANGE_SENT_COPY,
  deleteAccountErrorCopy,
  deleteAccountMessage,
  emailChangeErrorCopy,
} from '@/lib/profile-copy';
import { requestEmailChangeAction } from '@/lib/email-change-actions';
import { parseRetryAfter } from '@/lib/auth-error-copy';
import { SubmitButton } from '@/components/submit-button';
import { deleteAccountAction, saveProfileAction, sendDeleteCodeAction } from '@/lib/profile-actions';
import { twoFactorStatus } from '@/lib/security';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { ProfileForm } from '@/components/profile-form';

export const dynamic = 'force-dynamic';

const headingCls = 'mb-2 text-sm font-semibold text-[var(--color-fg)]';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';
const inputCls =
  'w-full min-h-11 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]';

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  const config = await getPortalConfig(slug);
  if (!config) notFound();

  const appName = config.branding.displayName || config.name;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const emailError = typeof sp.email_error === 'string' ? sp.email_error : undefined;
  const [record, fields, twoFactor] = await Promise.all([
    customerRecord(config, session.accessToken),
    profileFields(config, session.accessToken),
    twoFactorStatus(config, session.accessToken),
  ]);
  const email = record?.email ?? session.user.email;
  // Deleting is confirmed with the password when there is one to ask for,
  // otherwise with an emailed code; an authenticator code works either way.
  const asksPassword = config.auth.password && session.user.hasPassword === true;
  const emailCodeOffered = twoFactor !== null && !twoFactor.enabled && !asksPassword;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Profile</h1>
      {error && <Banner tone="error">{deleteAccountErrorCopy(error, appName)}</Banner>}

      <Card>
        <h2 className={headingCls}>Email address</h2>
        <p className="break-all text-sm text-[var(--color-fg)]">{email}</p>
        {record && !record.emailVerified && <p className={mutedCls}>Not confirmed yet.</p>}
        {sp.done === EMAIL_CHANGE_SENT && (
          <div className="mt-3">
            <Banner tone="success">{EMAIL_CHANGE_SENT_COPY}</Banner>
          </div>
        )}
        {emailError && (
          <div className="mt-3">
            <Banner tone="error">{emailChangeErrorCopy(emailError, parseRetryAfter(sp.retry))}</Banner>
          </div>
        )}
        <form action={requestEmailChangeAction.bind(null, slug)} className="mt-4 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-[var(--color-fg)]">New email address</span>
            <input name="newEmail" type="email" required autoComplete="email" maxLength={254} className={inputCls} />
          </label>
          <p className={mutedCls}>
            We email a link to the new address. Your address changes when you open it, and you are then signed out
            everywhere.
          </p>
          <SubmitButton variant="secondary" pendingLabel="Sending…">
            Change email address
          </SubmitButton>
        </form>
      </Card>

      {fields === null || record === null ? (
        <Card>
          <h2 className={headingCls}>About you</h2>
          <p className={mutedCls}>Your profile could not be loaded right now. Reload the page to try again.</p>
        </Card>
      ) : (
        fields.length > 0 && (
          <Card>
            <h2 className={headingCls}>About you</h2>
            <p className={`mb-4 ${mutedCls}`}>{appName} asks these questions. Leave one empty to clear your answer.</p>
            <ProfileForm fields={fields} stored={draftOf(fields, record.profile)} save={saveProfileAction.bind(null, slug)} />
          </Card>
        )
      )}

      <Card>
        <h2 className="mb-2 text-sm font-semibold text-[var(--color-danger)]">Delete account</h2>
        <p className={`mb-3 ${mutedCls}`}>{deleteAccountMessage(appName)}</p>
        {sp.done === DELETE_CODE_SENT && (
          <div className="mb-3">
            <Banner tone="success">{DELETE_CODE_SENT_COPY}</Banner>
          </div>
        )}
        {emailCodeOffered && (
          <form action={sendDeleteCodeAction.bind(null, slug)} className="mb-3 space-y-2">
            <p className={mutedCls}>We email you a code to confirm the deletion with.</p>
            <SubmitButton variant="secondary" pendingLabel="Sending…">
              Email me a code
            </SubmitButton>
          </form>
        )}
        <form action={deleteAccountAction.bind(null, slug)}>
          <ConfirmSubmit
            variant="danger"
            label="Delete account"
            triggerName="Delete your account"
            title="Delete your account?"
            message={`${deleteAccountMessage(appName)} A subscription that is still billing has to be canceled first.`}
            confirmLabel="Delete my account"
            cancelLabel="Keep my account"
            pendingLabel="Deleting…"
          >
            <div className="space-y-3">
              {asksPassword && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-[var(--color-fg)]">Your password</span>
                  <input name="password" type="password" autoComplete="current-password" className={inputCls} />
                </label>
              )}
              {twoFactor?.enabled && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-[var(--color-fg)]">
                    {asksPassword ? 'Or a code from your authenticator app' : 'A code from your authenticator app'}
                  </span>
                  <input name="code" type="text" inputMode="numeric" autoComplete="one-time-code" className={inputCls} />
                </label>
              )}
              {emailCodeOffered && (
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-[var(--color-fg)]">
                    The code from the email
                  </span>
                  <input name="emailCode" type="text" inputMode="numeric" autoComplete="one-time-code" className={inputCls} />
                </label>
              )}
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-[var(--color-fg)]">Type {DELETE_CONFIRMATION} to confirm</span>
                <input name="confirm" type="text" required autoComplete="off" className={inputCls} />
              </label>
            </div>
          </ConfirmSubmit>
        </form>
      </Card>
    </div>
  );
}
