import * as React from 'react';
import Link from '@/components/Link';
import { readErrorFlash, getApplication } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { PageHeader } from '@/components/PageHeader';
import { ApiErrorText } from '@/components/api-error';
import { Card, SectionHeader } from '@/components/Card';
import { SavedBanner } from '@/components/SavedBanner';
import { StickyFormFooter } from '@/components/StickyFormFooter';
import { saveAuth } from './actions';
import { PRIMARY_METHODS } from './methods';
import { JumpList } from '@/components/JumpList';
import { BlockedDomainsInput } from '@/components/BlockedDomainsInput';
import { savedStateKey } from '@/lib/saved-state-key';




const ERR: Record<string, string> = {
  TENANT_ROLE_INSUFFICIENT: 'Only owners and admins can change auth settings.',
};

export default async function AuthMethodsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const saved = sp.saved === '1';

  const app = await getApplication(id);
  const enabled = new Set(app.authConfig.methods ?? []);
  const oauthCount = Object.keys(app.oauthConfig ?? {}).length;
  // Prefer the 3-way signupMode; fall back to the legacy boolean for apps
  // written before signupMode existed (false ⇒ invite_only, else public).
  const ac = app.authConfig as { signupMode?: string; signupEnabled?: boolean };
  const signupMode: 'public' | 'secret_only' | 'invite_only' =
    ac.signupMode === 'secret_only' || ac.signupMode === 'invite_only' || ac.signupMode === 'public'
      ? ac.signupMode
      : ac.signupEnabled === false
        ? 'invite_only'
        : 'public';
  const mfaPolicy = (app.authConfig as { mfa?: 'off' | 'optional' | 'required' }).mfa ?? 'optional';
  const organizationsEnabled =
    (app.authConfig as { organizationsEnabled?: boolean }).organizationsEnabled === true;
  const breachCheckEnabled =
    (app.authConfig as { passwordBreachCheckEnabled?: boolean }).passwordBreachCheckEnabled !== false;
  // Both default-sensitive: `!== false` for the on-by-default send, `=== true`
  // for the off-by-default gate, so an app saved before these fields existed
  // reads back the same answer the API applies.
  const sendVerificationEmailOnSignUp =
    (app.authConfig as { sendVerificationEmailOnSignUp?: boolean }).sendVerificationEmailOnSignUp !==
    false;
  const requireEmailVerification =
    (app.authConfig as { requireEmailVerification?: boolean }).requireEmailVerification === true;
  const welcomeEmail = app.authConfig.welcomeEmail ?? 'on_signup';
  // HS256 unless explicitly RS256, matches the schema default, so an app
  // saved before the field existed reads back what the API actually applies.
  const tokenAlg =
    (app.authConfig as { tokenAlg?: string }).tokenAlg === 'RS256' ? 'RS256' : 'HS256';
  const redirectUrls = app.authConfig.redirectUrls ?? [];
  const appUrl = (app.authConfig as { appUrl?: string }).appUrl ?? '';
  const signupRestrictions = app.authConfig.signupRestrictions;
  // What emails would actually link to today if the operator saves nothing:
  // the origin of the first redirect URL. Shown as the placeholder so the
  // inferred fallback is visible rather than a surprise.
  const inferredAppUrl = ((): string | null => {
    for (const url of redirectUrls) {
      try {
        return new URL(url).origin;
      } catch {
        /* skip unparseable entries */
      }
    }
    return null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        level={2}
        title="Methods"
        description={
          <>
            How end-users sign up and sign in to this application, and the rules their accounts
            follow. Acting as an OpenID Connect provider is set up under{' '}
            <Link href={`/applications/${id}/oauth-clients#oidc-provider`} className="underline underline-offset-2">
              OAuth clients
            </Link>
            .
          </>
        }
      />

      <JumpList
        items={[
          { href: '#sign-in', label: 'Sign-in methods' },
          { href: '#sign-up', label: 'Sign-up & access' },
          { href: '#email-rules', label: 'Email rules' },
          { href: '#app-urls', label: 'Your application' },
          { href: '#passwords', label: 'Passwords & 2FA' },
          { href: '#sessions', label: 'Verification & sessions' },
        ]}
      />

      {saved && <SavedBanner message="Auth settings saved." />}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
        </p>
      )}

      <ActionForm
        key={savedStateKey(app.authConfig)}
        action={saveAuth.bind(null, id)}
        className="space-y-6"
      >
        {/* 1, Sign-in methods: credential toggles + read-only OAuth summary. */}
        <section id="sign-in" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Sign-in methods"
            description="What end-users can authenticate with. OAuth providers are managed on their own tab. A provider counts as on once it's configured."
          />
          <Card padded={false} className="divide-y divide-[var(--color-border)]">
            {PRIMARY_METHODS.map((m) => (
              <ToggleRow
                key={m.key}
                name={`method_${m.key}`}
                label={m.label}
                hint={m.hint}
                defaultChecked={enabled.has(m.key)}
              />
            ))}
            <div className="flex items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--color-fg)]">OAuth providers</div>
                <div className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
                  {oauthCount === 0
                    ? 'No providers configured yet.'
                    : `${oauthCount} provider${oauthCount === 1 ? '' : 's'} configured.`}{' '}
                  Add or remove them under Sign-in providers.
                </div>
              </div>
              <Link
                href={`/applications/${id}/oauth`}
                className="shrink-0 text-xs font-medium text-[var(--color-primary)] hover:underline"
              >
                {oauthCount === 0 ? 'Configure →' : 'Manage →'}
              </Link>
            </div>
          </Card>
        </section>

        {/* 2, Sign-up & access: who can create accounts, org model. */}
        <section id="sign-up" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Sign-up & access"
            description="Who can create accounts, and whether end-users can form multi-user teams."
          />
          <Card padded={false} className="divide-y divide-[var(--color-border)]">
            <div className="px-5 py-4">
              <Field
                label="End-user sign-up"
                hint={
                  <>
                    Controls who can create new accounts, whatever the sign-up method (password,
                    magic link, or OAuth). <strong>Secret-key only</strong> means only your own
                    server can create accounts. Use it when you provision users yourself.{' '}
                    <strong>Invite only</strong> blocks all new sign-ups. Existing users can always
                    sign in. Blocked attempts return a clear error code (e.g.{' '}
                    <code className="text-xs">SIGNUP_DISABLED</code>) your app can handle.
                  </>
                }
              >
                <select
                  name="signupMode"
                  defaultValue={signupMode}
                  className={`${inputCls} w-full sm:w-80`}
                >
                  <option value="public">Public: any key may create users</option>
                  <option value="secret_only">Secret-key only: server-side sign-up</option>
                  <option value="invite_only">Invite only: no public sign-up</option>
                </select>
              </Field>
            </div>
            <ToggleRow
              name="sendVerificationEmailOnSignUp"
              label="Send a verification email on sign-up"
              defaultChecked={sendVerificationEmailOnSignUp}
              hint={
                <>
                  Emails new password sign-ups a confirmation link, in addition to the welcome
                  email, so you don&apos;t have to call{' '}
                  <code className="text-xs">auth.sendVerificationEmail()</code> yourself. Sent
                  through this app&apos;s email transport (Email tab); with none configured nothing
                  goes out and sign-up still succeeds. Magic-link and OAuth sign-ups skip it: those
                  addresses are already proven. Ignored while{' '}
                  <strong>Require a verified email</strong> is on: the link is then the only way
                  into a new account, so it always goes out.
                </>
              }
            />
            <div className="px-5 py-4">
              <Field
                label="Welcome email"
                hint={
                  <>
                    When a new account gets the welcome email. <strong>On sign-up</strong> sends it
                    as the account is created, except that while <strong>Require a verified
                    email</strong> is on, an unverified address gets it once it is confirmed.{' '}
                    <strong>After verification</strong> always waits for a confirmed address.
                    Magic-link sign-ups, and OAuth sign-ups whose provider vouches for the address,
                    get it straight away in both. Users you create or import never get one. The
                    Email tab can still switch the welcome email off.
                  </>
                }
              >
                <select
                  name="welcomeEmail"
                  defaultValue={welcomeEmail}
                  className={`${inputCls} w-full sm:w-80`}
                >
                  <option value="on_signup">On sign-up</option>
                  <option value="on_verified">After email verification</option>
                  <option value="off">Never</option>
                </select>
              </Field>
            </div>
            <ToggleRow
              name="organizationsEnabled"
              label="Organizations (teams)"
              defaultChecked={organizationsEnabled}
              hint={
                <>
                  Lets end-users create shared team accounts and invite teammates. Enable this if
                  your product has team workspaces; leave it off for purely individual accounts.
                  View existing orgs on the Organizations tab. While off, organization API calls
                  return <code className="text-xs">ORGANIZATIONS_NOT_ENABLED</code>.
                </>
              }
            />
          </Card>
        </section>

        {/* 2b, Sign-up email rules: which addresses may create an account. */}
        <section id="email-rules" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Sign-up email rules"
            description="Which email addresses may create an account. Existing users always sign in, and users you create or import here are never checked."
          />
          <Card className="space-y-5">
            <Field
              label="Allowed domains"
              hint={
                <>
                  One per line. When any are listed, only these domains can sign up.{' '}
                  <code className="text-xs">example.com</code> allows only that domain; add{' '}
                  <code className="text-xs">*.example.com</code> to cover its subdomains. Leave
                  empty to allow every domain. The person refused sees{' '}
                  <code className="text-xs">SIGNUP_EMAIL_DOMAIN_NOT_ALLOWED</code>, never this
                  list.
                </>
              }
            >
              <textarea
                name="allowedDomains"
                rows={3}
                defaultValue={(signupRestrictions?.allowedDomains ?? []).join('\n')}
                placeholder={'acme.com\n*.acme.com'}
                className={`${inputCls} w-full font-mono`}
              />
            </Field>
            <Field
              label="Blocked domains"
              hint={
                <>
                  One per line. <code className="text-xs">example.com</code> blocks only that
                  domain; add <code className="text-xs">*.example.com</code> to cover its
                  subdomains. A blocked domain wins over an allowed one. Up to 500 in each list.
                </>
              }
            >
              <BlockedDomainsInput
                defaultValue={(signupRestrictions?.blockedDomains ?? []).join('\n')}
                className={`${inputCls} w-full font-mono`}
              />
            </Field>
            <ToggleRow
              padded={false}
              name="blockDisposable"
              label="Block disposable email addresses"
              defaultChecked={signupRestrictions?.blockDisposable === true}
              hint={
                <>
                  Refuses throwaway-inbox services such as mailinator.com. Unlike the blocked
                  domains list, this also covers their subdomains, with no{' '}
                  <code className="text-xs">*.</code> entry needed. The list ships with Rekey and
                  updates with each release. A magic-link
                  request for a refused address answers as if it sent, so the rules cannot be
                  probed.
                </>
              }
            />
          </Card>
        </section>

        {/* 3, Where the application lives: email links and allowed redirects. */}
        <section id="app-urls" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Your application"
            description="Where this application lives on the web: the address emails link back to, and where sign-in may send users afterwards."
          />
          <Card>
            <Field
              label="Application URL"
              hint={
                <>
                  The base address of your own app, e.g.{' '}
                  <code className="text-xs">https://app.yourcompany.com</code>. It&apos;s the
                  destination of the <strong>Get started</strong> button in the welcome email, and
                  the base for password-reset, email-verification and magic-link URLs when your
                  code doesn&apos;t pass one explicitly.
                  {inferredAppUrl ? (
                    <>
                      {' '}
                      Leave blank and we&apos;ll use{' '}
                      <code className="text-xs">{inferredAppUrl}</code>, taken from your first
                      redirect URL below.
                    </>
                  ) : (
                    <>
                      {' '}
                      With this blank and no redirect URLs set we can&apos;t build a link, so the
                      welcome email <strong>goes out without its button</strong> and the{' '}
                      <strong>verification email isn&apos;t sent at all</strong>: its whole body is
                      a button, and a confirmation nobody can click is worse than none.{' '}
                      <strong>Require a verified email</strong> cannot be turned on until this, or
                      a redirect URL, is set.
                    </>
                  )}
                </>
              }
            >
              <input
                type="url"
                name="appUrl"
                defaultValue={appUrl}
                placeholder={inferredAppUrl ?? 'https://app.yourcompany.com'}
                className={`${inputCls} w-full font-mono`}
              />
            </Field>

            <Field
              label="Redirect URLs"
              hint={
                <>
                  Where users can be sent back to after signing in. One URL per line, for example{' '}
                  <code className="text-xs">https://yourapp.com/callback</code>. Sign-in flows may
                  only redirect to addresses on this list, which stops attackers bouncing users to
                  look-alike sites. Invalid URLs are rejected on save.
                </>
              }
            >
              <textarea
                name="redirectUrls"
                rows={3}
                defaultValue={redirectUrls.join('\n')}
                placeholder={'https://app.example.com/auth/callback\nhttps://app.example.com/welcome'}
                className={`${inputCls} w-full font-mono`}
              />
            </Field>
          </Card>
        </section>

        {/* 4, Passwords and two-factor */}
        <section id="passwords" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Passwords & two-factor"
            description="Rules every end-user password meets, and whether a second sign-in step is offered or required."
          />
          <Card className="space-y-5">
            <ToggleRow
              padded={false}
              name="passwordBreachCheckEnabled"
              label="Refuse breached passwords"
              defaultChecked={breachCheckEnabled}
              hint={
                <>
                  Refuses a password that has appeared in a known data breach, checked whenever a
                  user sets or changes one. Recommended on. The password never leaves your server:
                  only an anonymous fragment of its fingerprint is compared against the public
                  breach list (
                  <a
                    href="https://haveibeenpwned.com/Passwords"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    Have I Been Pwned
                  </a>
                  ). Turn off only if this deployment can&apos;t reach the internet.
                </>
              }
            />
            <Field
              label="Minimum password length"
              hint="Enforced server-side on sign-up; 8 minimum."
            >
              <input
                type="number"
                name="passwordMinLength"
                defaultValue={app.authConfig.passwordMinLength ?? 8}
                min={8}
                max={128}
                className={`${inputCls} w-32 font-mono`}
              />
            </Field>
            <Field
              label="Two-factor authentication (TOTP)"
              hint={
                <>
                  Adds a second sign-in step using an authenticator app (with backup codes).{' '}
                  <strong>Optional</strong> lets each user decide; <strong>required</strong>{' '}
                  enforces it for everyone: users who haven&apos;t set it up are asked to at their
                  next sign-in (your app sees{' '}
                  <code className="text-xs">mfaEnrollmentRequired</code> and routes them to setup).
                </>
              }
            >
              <select name="mfa" defaultValue={mfaPolicy} className={`${inputCls} w-full sm:w-72`}>
                <option value="off">Off: end-users cannot enable 2FA</option>
                <option value="optional">Optional: end-users may enable 2FA</option>
                <option value="required">Required: force enrollment at sign-in</option>
              </select>
            </Field>
          </Card>
        </section>

        {/* 5, Verification and sessions */}
        <section id="sessions" className="scroll-mt-28 md:scroll-mt-20 space-y-3">
          <SectionHeader
            title="Verification & sessions"
            description={
              <>
                Whether an unverified address gets a session, how sessions are tied to devices, and
                how access tokens are signed. To sign every end-user out at once, use{' '}
                <Link href={`/applications/${id}/settings#force-logout`} className="underline">
                  Sign out all end-users
                </Link>{' '}
                in Settings.
              </>
            }
          />
          <Card className="space-y-5">

            <ToggleRow
              padded={false}
              name="requireEmailVerification"
              label="Require a verified email"
              defaultChecked={requireEmailVerification}
              hint={
                <>
                  No session until the user clicks their verification link: sign-up, sign-in and
                  refresh answer <code className="text-xs">EMAIL_NOT_VERIFIED</code> (403) instead.{' '}
                  <strong>Applies to existing accounts the moment you save</strong>: anyone who
                  never confirmed is signed out within 15 minutes, so check the verification email
                  is going out first, and give your sign-in screen a &ldquo;send it again&rdquo;
                  button wired to{' '}
                  <code className="text-xs">POST /api/v1/auth/resend-verification</code>. A
                  magic link counts as proof. A social sign-in counts only when the provider
                  vouches for the address. Needed to share email addresses over OpenID Connect.{' '}
                  <a
                    href="https://github.com/rekey-dev/rekey/blob/main/docs/auth.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    How verification works
                  </a>
                </>
              }
            />

            <Field
              label="End-user token signing"
              hint={
                <>
                  <strong>HS256</strong> signs with this deployment&apos;s shared secret, so checking
                  a token needs that secret: fine when only your own backend checks them. <strong>RS256</strong> signs with a key pair
                  and publishes the public half at{' '}
                  <code className="text-xs">/.well-known/jwks.json</code>, so anyone can check a
                  token without being able to make one. OpenID Connect ID tokens always use RS256.
                  Changing this invalidates access tokens signed the old way, so expect a round
                  of refreshes and sign-ins.
                </>
              }
            >
              <select
                name="tokenAlg"
                defaultValue={tokenAlg}
                className="w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <option value="HS256">HS256: shared secret (default)</option>
                <option value="RS256">RS256: public keypair, third parties can verify</option>
              </select>
            </Field>



            {/* This setting exists on the schema, on the PATCH body, in the
                published OpenAPI and in the operator MCP tool, and had no
                control here, so device binding could only ever be switched on
                over the API or by an agent, and a deployment driven from the
                panel could not use the feature at all. The parity test that
                keeps those four surfaces in step compares API artifacts only,
                which is why the omission was silent. */}
            <Field
              label="Device binding"
              hint={
                <>
                  Binds each session to the machine it was created on. The client sends an opaque
                  fingerprint at sign-in; Rekey records a device, enforces the{' '}
                  <code className="text-xs">max_devices</code> feature entitlement against it, and
                  puts the device id in the token as the <code className="text-xs">dev</code> claim.{' '}
                  <strong>Required</strong> refuses a sign-in that carries no fingerprint, so turn
                  it on only once your clients send one. Otherwise every sign-in fails. Devices
                  are listed and released per end-user under End-users.
                </>
              }
            >
              <select
                name="deviceBinding"
                defaultValue={app.authConfig.deviceBinding ?? 'optional'}
                className={`${inputCls} w-full sm:w-72`}
              >
                <option value="optional">Optional: bind when a fingerprint is sent</option>
                <option value="required">Required: refuse sign-in without a fingerprint</option>
              </select>
            </Field>

          </Card>
        </section>

        {/* A long page with one Save: the bar stays in view and guards unsaved edits. */}
        <StickyFormFooter hint="Changes apply to new sign-ins immediately." />
      </ActionForm>
    </div>
  );
}

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/**
 * Checkbox row with a bold label + muted hint, matching the panel's grouped
 * toggle cards. `padded` (default) adds the px-5 py-4 used inside divide-y
 * cards; pass false when the row sits in an already-padded <Card>.
 */
function ToggleRow({
  name,
  label,
  hint,
  defaultChecked,
  padded = true,
}: {
  name: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  defaultChecked?: boolean;
  padded?: boolean;
}): React.JSX.Element {
  return (
    <label className={`flex cursor-pointer items-start gap-3 ${padded ? 'px-5 py-4' : ''}`}>
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 rounded border-[var(--color-border)]"
      />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-[var(--color-fg)]">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-[var(--color-muted-fg)]">{hint}</div>}
      </div>
    </label>
  );
}

/** Labelled input + hint, shared by the security-policy fields. */
function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}
