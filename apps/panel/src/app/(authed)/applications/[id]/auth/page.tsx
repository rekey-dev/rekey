import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, PanelApiError, getApplication } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { SavedBanner } from '@/components/SavedBanner';
import { StickyFormFooter } from '@/components/StickyFormFooter';

const PRIMARY_METHODS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: 'password',
    label: 'Email + password',
    hint: 'Standard sign-up / sign-in. Argon2id-hashed at rest. Toggle off for OAuth-only apps.',
  },
  {
    key: 'magic_link',
    label: 'Magic link',
    hint: "One-click sign-in via email — the SDK's auth.requestMagicLink() + verifyMagicLink(). Delivered through this app's configured email transport (set one on the Email tab; otherwise the raw token is returned to your server to send).",
  },
];

async function saveAuth(applicationId: string, formData: FormData): Promise<void> {
  'use server';
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
  const oidcEnabled = formData.get('oidcEnabled') === 'on';
  // Only ever HS256 or RS256 — anything else is a crafted form post, and the
  // API would reject it anyway. Falling back to HS256 keeps the default.
  const rawAlg = String(formData.get('tokenAlg') ?? '');
  const tokenAlg = rawAlg === 'RS256' ? 'RS256' : 'HS256';
  const redirectUrls = String(formData.get('redirectUrls') ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Empty string is meaningful — it CLEARS the stored URL. Sending it through
  // unchanged is what lets an operator remove a stale value; the API treats
  // '' and null identically.
  const appUrl = String(formData.get('appUrl') ?? '').trim();

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
        oidcEnabled,
        tokenAlg,
        redirectUrls,
        appUrl,
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/auth?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/auth?saved=1`);
}

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
  // Off by default, same as `requireEmailVerification` — an app saved before
  // the field existed must read back as OFF, never as "we're already an IdP".
  const oidcEnabled = app.authConfig.oidcEnabled === true;
  // HS256 unless explicitly RS256 — matches the schema default, so an app
  // saved before the field existed reads back what the API actually applies.
  const tokenAlg =
    (app.authConfig as { tokenAlg?: string }).tokenAlg === 'RS256' ? 'RS256' : 'HS256';
  const redirectUrls = app.authConfig.redirectUrls ?? [];
  const appUrl = (app.authConfig as { appUrl?: string }).appUrl ?? '';
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
        title="Auth methods"
        description="How end-users sign up and sign in to this application, and the security policy enforced on their accounts."
      />

      {saved && <SavedBanner message="Auth settings saved." />}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {ERR[error] ?? error}
        </p>
      )}

      <form action={saveAuth.bind(null, id)} className="space-y-6">
        {/* 1 — Sign-in methods: credential toggles + read-only OAuth summary. */}
        <section className="space-y-3">
          <SectionHeader
            title="Sign-in methods"
            description="What end-users can authenticate with. OAuth providers are managed on their own tab — a provider counts as on once it's configured."
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
                  Add or remove them on the OAuth tab.
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

        {/* 2 — Sign-up & access: who can create accounts, org model. */}
        <section className="space-y-3">
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
                    server can create accounts — use it when you provision users yourself.{' '}
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
                  <option value="public">Public — any key may create users</option>
                  <option value="secret_only">Secret-key only — server-side sign-up</option>
                  <option value="invite_only">Invite only — no public sign-up</option>
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
                  email — you don&apos;t have to call{' '}
                  <code className="text-xs">auth.sendVerificationEmail()</code> yourself. Sent
                  through this app&apos;s email transport (Email tab); with none configured nothing
                  goes out and sign-up still succeeds. Magic-link and OAuth sign-ups skip it — those
                  addresses are already proven. Ignored while{' '}
                  <strong>Require a verified email</strong> is on: the link is then the only way
                  into a new account, so it always goes out.
                </>
              }
            />
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

        {/* 3 — Application URL: the origin transactional emails link back to. */}
        <section className="space-y-3">
          <SectionHeader
            title="Your application"
            description="Where this application lives on the web. Transactional emails link back here."
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
                      <strong>verification email isn&apos;t sent at all</strong> — its whole body is
                      a button, and a confirmation nobody can click is worse than none. Set this
                      before turning on <strong>Require a verified email</strong>.
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
          </Card>
        </section>

        {/* 4 — Security policy: MFA, breach check, password rules, redirect allow-list. */}
        <section className="space-y-3">
          <SectionHeader
            title="Security policy"
            description="Account-protection rules enforced server-side on every end-user, and what this application asserts about them to anyone else."
          />
          <Card className="space-y-5">
            <ToggleRow
              padded={false}
              name="passwordBreachCheckEnabled"
              label="Breached-password check (HIBP)"
              defaultChecked={breachCheckEnabled}
              hint={
                <>
                  Rejects passwords that have appeared in known data breaches, checked whenever a
                  user sets or changes one. Recommended on: passwords themselves never leave your
                  server — only an anonymous partial hash is compared against the public breach
                  database. Turn off only if this deployment can&apos;t reach the internet.
                </>
              }
            />

            <ToggleRow
              padded={false}
              name="requireEmailVerification"
              label="Require a verified email"
              defaultChecked={requireEmailVerification}
              hint={
                <>
                  No session until the user clicks their verification link — sign-up, sign-in and
                  refresh all answer <code className="text-xs">EMAIL_NOT_VERIFIED</code> (403)
                  instead, so your app can say why. Sign-up still creates the account and always
                  sends the link.{' '}
                  <strong>Applies to existing accounts the moment you save</strong> — anyone who
                  never confirmed their address is signed out within 15 minutes and stays out until
                  they do, so make sure the verification email above is going out first. Give your
                  sign-in screen a &ldquo;send it again&rdquo; button on{' '}
                  <code className="text-xs">EMAIL_NOT_VERIFIED</code>, wired to{' '}
                  <code className="text-xs">POST /api/v1/auth/resend-verification</code> — it takes
                  no session, which is the point. Magic-link sign-in passes the gate rather than
                  skipping it — clicking the link proves the address, and it is recorded.{' '}
                  <strong>OAuth does not verify an address by itself</strong>: the account is
                  marked verified only when the provider asserts it (Google&apos;s{' '}
                  <code className="text-xs">email_verified</code>, GitHub&apos;s verified-emails
                  list, Discord&apos;s <code className="text-xs">verified</code>). A provider that
                  asserts nothing — some generic OIDC servers, Microsoft consumer accounts — leaves
                  the account unverified, and that user hits this gate like any other. Trusting the
                  provider&apos;s claim and nothing more is deliberate: an address a provider will
                  not vouch for is one anybody could have registered.{' '}
                  <strong>Required for the OpenID Connect `email` scope</strong> — while this is
                  off, an Application acting as an identity provider will not assert an address it
                  has no proof of, and omits <code className="text-xs">email</code> from its
                  discovery document.
                </>
              }
            />

            <ToggleRow
              padded={false}
              name="oidcEnabled"
              label="Act as an OpenID Connect provider"
              defaultChecked={oidcEnabled}
              hint={
                <>
                  Turns this application into a public <strong>identity provider</strong>: other
                  products can offer &ldquo;Sign in with {app.name}&rdquo; and your end-users&apos;
                  accounts here become their accounts there. Switching it on publishes an
                  unauthenticated
                  discovery document at{' '}
                  <code className="text-xs">/.well-known/openid-configuration</code>, starts issuing{' '}
                  <code className="text-xs">id_token</code>s for the{' '}
                  <code className="text-xs">openid</code> scope, and exposes{' '}
                  <code className="text-xs">/oauth/userinfo</code>. Relying parties self-register
                  themselves by default, so anyone who finds the issuer can put a password prompt
                  on it — leave this off unless you actually want to be an identity provider.
                  Once your relying parties are registered, close registration on the{' '}
                  <strong>OAuth clients</strong> tab, where you can also see and revoke whatever
                  has registered. Independent of the MCP server switch on the
                  MCP tab; either one mounts the shared OAuth endpoints. The{' '}
                  <code className="text-xs">email</code> claim additionally needs{' '}
                  <strong>Require a verified email</strong> above.
                </>
              }
            />

            <Field
              label="End-user token signing"
              hint={
                <>
                  <strong>HS256</strong> signs end-user access tokens with this deployment&apos;s
                  shared secret — fine when only your own backend verifies them, because verifying
                  requires the secret. <strong>RS256</strong> signs with a keypair and publishes the
                  public half at <code className="text-xs">/.well-known/jwks.json</code>, so a third
                  party can verify a token without being able to mint one. This governs the
                  access tokens your own backend checks. It does not affect OpenID Connect:
                  id_tokens are always RS256 and always verifiable from the published JWKS,
                  because a relying party only ever sees that. Changing this invalidates access
                  tokens signed with the old algorithm, so expect a round of sign-ins.
                </>
              }
            >
              <select
                name="tokenAlg"
                defaultValue={tokenAlg}
                className="w-full max-w-xs rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              >
                <option value="HS256">HS256 — shared secret (default)</option>
                <option value="RS256">RS256 — public keypair, third parties can verify</option>
              </select>
            </Field>

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
                  enforces it for everyone — users who haven&apos;t set it up are asked to at their
                  next sign-in (your app sees{' '}
                  <code className="text-xs">mfaEnrollmentRequired</code> and routes them to setup).
                </>
              }
            >
              <select name="mfa" defaultValue={mfaPolicy} className={`${inputCls} w-full sm:w-72`}>
                <option value="off">Off — end-users cannot enable 2FA</option>
                <option value="optional">Optional — end-users may enable 2FA</option>
                <option value="required">Required — force enrollment at sign-in</option>
              </select>
            </Field>

            <Field
              label="Redirect URLs"
              hint={
                <>
                  Where users can be sent back to after signing in — one URL per line, e.g.{' '}
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

        {/* This page is 14 controls over ~1970px. A Save that only exists at
            the very bottom is a Save most of the page cannot see, and until now
            navigating away threw the edits out without a word. */}
        <StickyFormFooter hint="Changes apply to new sign-ins immediately." />
      </form>
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
