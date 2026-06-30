import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, PanelApiError, type ApplicationRow } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { SubmitButton } from '@/components/SubmitButton';
import { SavedBanner } from '@/components/SavedBanner';

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
  const redirectUrls = String(formData.get('redirectUrls') ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

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
        redirectUrls,
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/auth?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  revalidatePath(`/applications/${applicationId}/auth`);
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

  const app = await api<ApplicationRow>({
    method: 'GET',
    path: `/api/v1/tenant/applications/${encodeURIComponent(id)}`,
  });
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
  const redirectUrls = app.authConfig.redirectUrls ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
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
                    Applies to <code className="text-xs">auth.signUp(...)</code>, magic-link, and
                    OAuth-first sign-in. <strong>Secret-key only</strong> lets your server create
                    users with a secret key (<code className="text-xs">rp_live_…</code>) while the
                    publishable key is refused with{' '}
                    <code className="text-xs">SIGNUP_REQUIRES_SECRET_KEY</code> — the publishable
                    key can still sign existing users in. <strong>Invite only</strong> rejects all
                    sign-up with <code className="text-xs">SIGNUP_DISABLED</code>. Existing users
                    can always sign in.
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
              name="organizationsEnabled"
              label="Organizations (teams)"
              defaultChecked={organizationsEnabled}
              hint={
                <>
                  Let end-users create multi-user organizations and invite teammates via{' '}
                  <code className="text-xs">relipay.organizations.*</code>. Off = the SDK org
                  endpoints reject with <code className="text-xs">ORGANIZATIONS_NOT_ENABLED</code>.
                  View existing orgs on the Organizations tab.
                </>
              }
            />
          </Card>
        </section>

        {/* 3 — Security policy: MFA, breach check, password rules, redirect allow-list. */}
        <section className="space-y-3">
          <SectionHeader
            title="Security policy"
            description="Account-protection rules enforced server-side on every end-user."
          />
          <Card className="space-y-5">
            <ToggleRow
              padded={false}
              name="passwordBreachCheckEnabled"
              label="Breached-password check (HIBP)"
              defaultChecked={breachCheckEnabled}
              hint={
                <>
                  On (default) = reject known-breached passwords at sign-up / reset / change via the
                  HaveIBeenPwned k-anonymity API (only a hash prefix leaves the server). Turn off for
                  offline or restricted-egress deployments.
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
                  <strong>optional</strong> = users may enable it; <strong>required</strong> =
                  enforced for everyone. End-users enroll via{' '}
                  <code className="text-xs">auth.mfa.setup()</code> (TOTP + backup codes).{' '}
                  <strong>Required</strong> returns{' '}
                  <code className="text-xs">mfaEnrollmentRequired</code> at sign-in for users who
                  haven&apos;t enrolled, so your app can route them to setup.
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
                  URLs your app returns to after sign-in, one per line, e.g.{' '}
                  <code className="text-xs">https://yourapp.com/callback</code>. Acts as the
                  allow-list for OAuth / hosted sign-in flows; invalid URLs are rejected on save.
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

        <div className="flex items-center justify-end">
          <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        </div>
      </form>
    </div>
  );
}

const inputCls =
  'rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

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
