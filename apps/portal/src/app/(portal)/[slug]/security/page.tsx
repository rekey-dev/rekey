import * as React from 'react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { AuthConfigSchema } from '@rekey.dev/shared-types';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { checkoutLocale } from '@/lib/checkout-format';
import { PORTAL_TIME_ZONE, formatDate } from '@/lib/format';
import { parseRetryAfter } from '@/lib/auth-error-copy';
import { listIdentities, listSessions, securityPath, twoFactorStatus } from '@/lib/security';
import {
  FIRST_PASSWORD_ERRORS,
  providerName,
  securityDoneCopy,
  securityErrorCopy,
  sessionLabel,
  SECURITY_DONE,
} from '@/lib/security-copy';
import {
  changePasswordAction,
  removeProviderAction,
  revokeSessionAction,
  sendPasswordCodeAction,
  setPasswordAction,
  signOutEverywhereAction,
  turnOffTwoFactorAction,
} from '@/lib/security-actions';
import {
  confirmTwoFactorSetUpAction,
  replaceBackupCodesAction,
  startTwoFactorSetUpAction,
} from '@/lib/two-factor-actions';
import { BackupCodesReplacement } from '@/components/backup-codes-replacement';
import { Banner } from '@/components/banner';
import { Card } from '@/components/card';
import { ConfirmSubmit } from '@/components/confirm-submit';
import { PasswordField } from '@/components/password-field';
import { SubmitButton } from '@/components/submit-button';
import { TwoFactorSetUpSteps } from '@/components/two-factor-set-up-steps';

export const dynamic = 'force-dynamic';

/** The lowest minimum any application can set; a longer one is refused by the API and explained. */
const PASSWORD_FLOOR = AuthConfigSchema.innerType().shape.passwordMinLength.removeDefault().minValue ?? 8;

const headingCls = 'mb-2 text-sm font-semibold text-[var(--color-fg)]';
const mutedCls = 'text-sm text-[var(--color-muted-fg)]';

export default async function SecurityPage({
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
  const hasPassword = session.user.hasPassword === true;
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const dateOf = (value: string): string => formatDate(value, locale, PORTAL_TIME_ZONE);
  const done = typeof sp.done === 'string' ? securityDoneCopy(sp.done) : null;
  const error = typeof sp.error === 'string' ? sp.error : undefined;

  const [twoFactor, sessions, identities] = await Promise.all([
    twoFactorStatus(config, session.accessToken),
    listSessions(config, session.accessToken),
    listIdentities(config, session.accessToken),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Security</h1>
      {done && <Banner tone="success">{done}</Banner>}
      {error && <Banner tone="error">{securityErrorCopy(error, parseRetryAfter(sp.retry))}</Banner>}

      <Card>
        <h2 className={headingCls}>Password</h2>
        {config.auth.password ? (
          <div className="space-y-4">
            {hasPassword && (
            <form action={changePasswordAction.bind(null, slug)} className="space-y-3">
              <PasswordField name="currentPassword" label="Current password" autoComplete="current-password" />
              <PasswordField
                name="newPassword"
                label="New password"
                autoComplete="new-password"
                minLength={PASSWORD_FLOOR}
                rule={`At least ${PASSWORD_FLOOR} characters. Some accounts ask for more.`}
              />
              <p className={mutedCls}>
                Changing your password signs you out everywhere, here included. Sign in again with the new password.
              </p>
              <SubmitButton pendingLabel="Changing…">Change password</SubmitButton>
            </form>
            )}
            {!hasPassword && (
            <details
              open={sp.done === SECURITY_DONE.passwordCodeSent || (error !== undefined && FIRST_PASSWORD_ERRORS.has(error))}
              className="space-y-3"
            >
              <summary className="cursor-pointer text-sm font-medium text-[var(--color-fg)]">Create a password</summary>
              <p className={mutedCls}>
                Signed up with an emailed link or another provider and never chose a password? We email you a code to
                confirm it is you, then you choose a password.
              </p>
              <form action={sendPasswordCodeAction.bind(null, slug)}>
                <SubmitButton variant="secondary" pendingLabel="Sending…">
                  Email me a code
                </SubmitButton>
              </form>
              <form action={setPasswordAction.bind(null, slug)} className="space-y-3">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-[var(--color-fg)]">Code from the email</span>
                  <input
                    name="emailCode"
                    type="text"
                    required
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                  />
                </label>
                <PasswordField
                  name="newPassword"
                  label="New password"
                  autoComplete="new-password"
                  minLength={PASSWORD_FLOOR}
                  rule={`At least ${PASSWORD_FLOOR} characters. Some accounts ask for more.`}
                />
                <p className={mutedCls}>Creating a password signs you out everywhere. Sign in again with it.</p>
                <SubmitButton pendingLabel="Creating…">Create password</SubmitButton>
              </form>
            </details>
            )}
          </div>
        ) : (
          <p className={mutedCls}>
            {appName} signs you in{config.auth.magicLink ? ' with a link sent to your email address' : ' another way'},
            so this account has no password to change.
          </p>
        )}
      </Card>

      {twoFactor && twoFactor.policy !== 'off' && (
        <Card>
          <h2 className={headingCls}>Two-factor authentication</h2>
          {twoFactor.enabled ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--color-fg)]">
                On. Signing in asks for a code from your authenticator app.
                {twoFactor.remainingBackupCodes !== null &&
                  ` You have ${twoFactor.remainingBackupCodes === 1 ? '1 backup code' : `${twoFactor.remainingBackupCodes} backup codes`} left.`}
              </p>
              <BackupCodesReplacement replace={replaceBackupCodesAction.bind(null, slug)} />
              {twoFactor.policy === 'required' ? (
                <p className={mutedCls}>{appName} requires two-factor authentication, so it cannot be turned off.</p>
              ) : (
                <form action={turnOffTwoFactorAction.bind(null, slug)}>
                  <ConfirmSubmit
                    variant="danger"
                    label="Turn off"
                    triggerName="Turn off two-factor authentication"
                    title="Turn off two-factor authentication?"
                    message="Signing in will no longer ask for a code. Enter a current code from your authenticator app, or a backup code, to confirm."
                    confirmLabel="Turn off two-factor"
                    cancelLabel="Keep it on"
                    pendingLabel="Turning off…"
                  >
                    <label className="block space-y-1.5">
                      <span className="text-sm font-medium text-[var(--color-fg)]">Code</span>
                      <input
                        name="code"
                        type="text"
                        required
                        autoComplete="one-time-code"
                        className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                      />
                    </label>
                  </ConfirmSubmit>
                </form>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <TwoFactorSetUpSteps
                intro={
                  <p className={mutedCls}>
                    Off. Turn it on to have signing in ask for a code from an authenticator app on your phone or
                    computer.
                  </p>
                }
                start={startTwoFactorSetUpAction.bind(null, slug)}
                confirm={confirmTwoFactorSetUpAction.bind(null, slug)}
                continueHref={`${securityPath(slug)}?done=${SECURITY_DONE.twoFactorOn}`}
              />
            </div>
          )}
        </Card>
      )}

      <Card>
        <h2 className={headingCls}>Where you are signed in</h2>
        {sessions === null ? (
          <p className={mutedCls}>Your sessions could not be loaded right now. Reload the page to try again.</p>
        ) : sessions.length === 0 ? (
          <p className={mutedCls}>
            Each browser and app signed in to {appName} appears here, so you can sign out of one you do not recognise.
          </p>
        ) : (
          <div className="space-y-4">
            <ul className="divide-y divide-[var(--color-border)]">
              {sessions.map((s) => {
                const name = sessionLabel(s.userAgent);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0 text-sm text-[var(--color-fg)]">
                      {name}
                      {s.current && (
                        <span className="ml-2 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-muted-fg)]">
                          This session
                        </span>
                      )}
                      <span className="block text-xs text-[var(--color-muted-fg)]">
                        Last active {dateOf(s.createdAt)}
                        {s.ip && ` · IP address ${s.ip}`}
                      </span>
                    </span>
                    <form action={revokeSessionAction.bind(null, slug, s.id, s.current)} className="shrink-0">
                      <ConfirmSubmit
                        variant="danger"
                        size="sm"
                        label="Sign out"
                        triggerName={
                          s.current ? 'Sign out of this session' : `Sign out ${name}, last active ${dateOf(s.createdAt)}`
                        }
                        title={s.current ? 'Sign out of this session?' : `Sign out ${name}?`}
                        message={
                          s.current
                            ? 'This is the browser you are using now. You will be signed out here and will have to sign in again.'
                            : 'That browser or app will have to sign in again.'
                        }
                        confirmLabel="Sign out"
                        cancelLabel="Cancel"
                        pendingLabel="Signing out…"
                      />
                    </form>
                  </li>
                );
              })}
            </ul>
            <form action={signOutEverywhereAction.bind(null, slug)}>
              <ConfirmSubmit
                variant="danger"
                label="Sign out everywhere"
                title="Sign out everywhere?"
                message={`Every browser and app signed in to ${appName} will have to sign in again, and you will be signed out here too.`}
                confirmLabel="Sign out everywhere"
                cancelLabel="Cancel"
                pendingLabel="Signing out…"
              />
            </form>
          </div>
        )}
      </Card>

      {identities !== null && identities.length > 0 && (
        <Card>
          <h2 className={headingCls}>Sign-in providers</h2>
          <ul className="divide-y divide-[var(--color-border)]">
            {identities.map((identity) => {
              const name = providerName(identity.provider);
              return (
                <li key={identity.provider} className="flex items-center justify-between gap-3 py-3">
                  <span className="min-w-0 text-sm text-[var(--color-fg)]">
                    {name}
                    <span className="block truncate text-xs text-[var(--color-muted-fg)]">
                      {identity.email ? `${identity.email} · ` : ''}Linked {dateOf(identity.createdAt)}
                    </span>
                  </span>
                  <form action={removeProviderAction.bind(null, slug, identity.provider)} className="shrink-0">
                    <ConfirmSubmit
                      variant="danger"
                      size="sm"
                      label="Remove"
                      triggerName={`Remove ${name}`}
                      title={`Remove ${name}?`}
                      message={`You will no longer be able to sign in to ${appName} with ${name}. You can link it again later in ${appName}.`}
                      confirmLabel={`Remove ${name}`}
                      cancelLabel="Cancel"
                      pendingLabel="Removing…"
                    />
                  </form>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
