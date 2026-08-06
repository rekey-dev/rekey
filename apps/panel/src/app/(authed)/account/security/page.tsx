/**
 * Account → Security: MFA enrollment + change password.
 *
 * MFA flow is presented as numbered steps so the operator can follow
 * along: scan QR → save backup codes → confirm with current 6-digit code.
 *
 * Backup codes are surfaced via a query string for one-time display, then
 * downloadable as a plain text file. (We considered persisting them on
 * the server-rendered page state, but that requires a client store; the
 * QS approach keeps everything server-rendered and stateless.)
 */

import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { errorQuery, readErrorFlash, api, PanelApiError, type OperatorSessionRow, getMe } from '@/lib/api';
import { describeUserAgent } from '@/lib/format';
import { QrCode } from '@/components/QrCode';
import { ApiErrorText } from '@/components/api-error';
import { CopyButton } from '@/components/CopyButton';
import { DownloadButton } from '@/components/DownloadButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { SubmitButton } from '@/components/SubmitButton';
import { formatDateTime } from '@/lib/date';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Badge } from '@/components/Badge';
import { Banner } from '@/components/Banner';
import { cookieSecure } from '@/lib/cookie-secure';
import type { Page } from '@/lib/paginate';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

/**
 * The MFA setup secret + backup codes are sensitive one-time-reveal data:
 * the TOTP seed is essentially a long-lived shared key, and backup codes
 * are themselves single-use passwords. Previously this page redirected
 * with `?otpauth=…&backups=…` in the URL — that data ended up in browser
 * history, referer headers, and panel access logs. AUDIT-3 (2026-05-19):
 * we now stash them in a short-lived, HttpOnly, SameSite=strict cookie
 * (`rekey_mfa_setup`) scoped to /account/security, read once by the
 * page, then cleared after a successful confirm/disable.
 */
const MFA_SETUP_COOKIE = 'rekey_mfa_setup';
const MFA_SETUP_COOKIE_MAX_AGE = 60 * 5; // 5 minutes — long enough to scan, short enough to limit blast radius.

interface MfaStatus {
  enabled: boolean;
  remainingBackupCodes: number | null;
}
interface MfaSetupResp {
  otpauthUrl: string;
  backupCodes: string[];
}

async function setupMfa(): Promise<void> {
  'use server';
  const result = await api<MfaSetupResp>({
    method: 'POST',
    path: '/api/v1/tenant/auth/mfa/setup',
  });
  // Stash the secret + backup codes in a short-lived HttpOnly cookie so
  // they don't end up in the URL bar / browser history / referer headers.
  // Path is locked to /account/security so the cookie isn't sent on
  // unrelated panel requests.
  const jar = await cookies();
  jar.set(MFA_SETUP_COOKIE, JSON.stringify(result), {
    httpOnly: true,
    sameSite: 'strict',
    secure: await cookieSecure(),
    path: '/account/security',
    maxAge: MFA_SETUP_COOKIE_MAX_AGE,
  });
  redirect('/account/security');
}

async function confirmMfa(formData: FormData): Promise<void> {
  'use server';
  const code = String(formData.get('code') ?? '').trim();
  try {
    await api({
      method: 'POST',
      path: '/api/v1/tenant/auth/mfa/setup-confirm',
      body: { code },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/security?${await errorQuery(err)}`);
    }
    throw err;
  }
  // Successful confirm — clear the one-time-reveal cookie. Operators who
  // need the backup codes again must mint fresh ones via Disable + Setup.
  const jar = await cookies();
  jar.delete(MFA_SETUP_COOKIE);
  redirect('/account/security?confirmed=1');
}

async function disableMfa(): Promise<void> {
  'use server';
  await api({ method: 'POST', path: '/api/v1/tenant/auth/mfa/disable' });
  const jar = await cookies();
  jar.delete(MFA_SETUP_COOKIE);
  redirect('/account/security?disabled=1');
}

async function changePassword(formData: FormData): Promise<void> {
  'use server';
  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  try {
    await api({
      method: 'POST',
      path: '/api/v1/tenant/auth/change-password',
      body: { currentPassword, newPassword },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/security?pwerror=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/account/security?pwchanged=1');
}

async function revokeSession(formData: FormData): Promise<void> {
  'use server';
  const sessionId = String(formData.get('sessionId') ?? '');
  await api({
    method: 'DELETE',
    path: `/api/v1/tenant/auth/sessions/${encodeURIComponent(sessionId)}`,
  });
  redirect('/account/security?session_revoked=1');
}

async function signOutEverywhere(): Promise<void> {
  'use server';
  await api({ method: 'POST', path: '/api/v1/tenant/auth/sign-out-everywhere' });
  redirect('/account/security?signed_out_all=1');
}

const ERR: Record<string, string> = {
  MFA_CODE_INVALID: 'That code did not verify. Make sure your authenticator clock is in sync, then enter the current 6-digit code.',
  MFA_NOT_INITIATED: 'Click "Set up MFA" first.',
  INVALID_CREDENTIALS: 'Current password is incorrect.',
  PASSWORD_TOO_SHORT: 'New password must be at least 8 characters.',
};

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  // The API's own message and fix for this failure, left by `errorQuery`
  // in a short-lived httpOnly cookie. Not in the URL: a query parameter is
  // written by whoever composes the link, and this text renders inside the
  // panel's own error banner.
  const { detail: errorDetail, fix: errorFix } = await readErrorFlash(error);
  const pwerror = typeof sp.pwerror === 'string' ? sp.pwerror : undefined;
  // The MFA setup payload lives in a one-time-reveal cookie (set by
  // `setupMfa`, deleted by `confirmMfa`/`disableMfa`). Reading from a
  // server component is read-only; we never write the cookie here.
  const jar = await cookies();
  const setupCookie = jar.get(MFA_SETUP_COOKIE)?.value;
  let otpauth: string | undefined;
  let backups: string[] | null = null;
  if (setupCookie) {
    try {
      const parsed = JSON.parse(setupCookie) as MfaSetupResp;
      otpauth = parsed.otpauthUrl;
      backups = parsed.backupCodes;
    } catch {
      // Stale / corrupted cookie — ignore, the operator can re-run setup.
    }
  }
  const confirmed = sp.confirmed === '1';
  const disabled = sp.disabled === '1';
  const pwchanged = sp.pwchanged === '1';

  const status = await api<MfaStatus>({
    method: 'GET',
    path: '/api/v1/tenant/auth/mfa/status',
  });
  const { items: sessions } = await api<Page<OperatorSessionRow>>({
    method: 'GET',
    path: '/api/v1/tenant/auth/sessions',
  });
  // Operator email for the change-password form's hidden username field —
  // best-effort: the form works without it.
  const operatorEmail = await getMe()
    .then((me) => me.user.email)
    .catch(() => null);
  const sessionRevoked = sp.session_revoked === '1';
  const signedOutAll = sp.signed_out_all === '1';

  const setupInProgress = !status.enabled && Boolean(otpauth);

  return (
    <section className="mx-auto max-w-7xl space-y-10 px-6 py-8 lg:px-8">
      <PageHeader
        title="Account security"
        description="Two-factor authentication and password management for your operator account."
      />

      {/* ─── MFA ─────────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Two-factor authentication"
          description="TOTP via any standard authenticator (1Password, Authy, Google Authenticator, …) plus backup codes for lost devices."
          action={<StatusPill enabled={status.enabled} setupInProgress={setupInProgress} />}
        />

        {/* CASE 1: Already enabled */}
        {status.enabled && (
          <Card className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>MFA is enabled.</span>
              <span className="text-[var(--color-muted-fg)]">
                · {status.remainingBackupCodes ?? 0} backup codes remaining
              </span>
            </div>
            {status.remainingBackupCodes !== null && status.remainingBackupCodes <= 3 && (
              <p className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                Few backup codes remaining. Consider re-running setup to mint a fresh batch.
              </p>
            )}
            <form action={disableMfa} className="border-t border-[var(--color-border)] pt-2">
              <TypedConfirmButton
                expected="disable mfa"
                title="Disable two-factor authentication?"
                description="Your operator account will be protected by password only until you re-enroll. Backup codes are invalidated immediately."
                triggerLabel="Disable MFA"
                confirmLabel="Disable MFA"
              />
            </form>
            {disabled && (
              <p className="text-xs text-[var(--color-muted-fg)]">MFA disabled.</p>
            )}
          </Card>
        )}

        {/* CASE 2: Setup in progress (have otpauth but not yet confirmed) */}
        {setupInProgress && (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
            {/* Step 1 — Scan */}
            <div className="p-5 border-b border-[var(--color-border)]">
              <StepHeader n={1} title="Scan with your authenticator app" />
              <div className="mt-4 grid sm:grid-cols-[auto_1fr] gap-5 items-start">
                <QrCode value={otpauth!} size={180} />
                <div className="space-y-3 text-sm">
                  <p className="text-[var(--color-muted-fg)]">
                    Open 1Password / Authy / Google Authenticator and scan this QR code.
                  </p>
                  <details className="text-xs text-[var(--color-muted-fg)]">
                    <summary className="cursor-pointer hover:text-[var(--color-fg)]">
                      Can&apos;t scan? Enter the secret manually.
                    </summary>
                    <div className="mt-2 space-y-1.5">
                      <code className="block break-all rounded bg-[var(--color-surface-muted)] px-2 py-1.5 font-mono text-[11px]">
                        {extractSecret(otpauth!)}
                      </code>
                      <CopyButton value={extractSecret(otpauth!)} label="Copy secret" />
                    </div>
                  </details>
                </div>
              </div>
            </div>

            {/* Step 2 — Backup codes */}
            <div className="p-5 border-b border-[var(--color-border)] bg-amber-50/40 dark:bg-amber-950/20">
              <StepHeader n={2} title="Save your backup codes" />
              <p className="text-xs text-amber-900 dark:text-amber-200 mt-1">
                These are shown <strong>once</strong>. Each works one time if you lose your authenticator. Only SHA-256 hashes are kept on the server.
              </p>
              {backups && backups.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="grid grid-cols-2 gap-1.5 font-mono text-xs">
                    {backups.map((c) => (
                      <code
                        key={c}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-center tracking-wide"
                      >
                        {c}
                      </code>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <DownloadButton
                      filename="rekey-backup-codes.txt"
                      content={`Rekey backup codes\nGenerated: ${new Date().toISOString()}\n\n${backups.join('\n')}\n\nEach code can be used ONCE if you lose access to your authenticator.\n`}
                      label="Download .txt"
                    />
                    <CopyButton value={backups.join('\n')} label="Copy all" />
                  </div>
                </div>
              )}
            </div>

            {/* Step 3 — Confirm */}
            <div className="p-5">
              <StepHeader n={3} title="Confirm with the current 6-digit code" />
              <form action={confirmMfa} className="mt-3 space-y-2">
                {error && (
                  <Banner tone="error">
                    <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback="Something went wrong. Please try again." />
                  </Banner>
                )}
                <div className="flex items-end gap-2">
                  <label className="block space-y-1">
                    <span className="text-xs font-medium text-[var(--color-fg)]">Current code</span>
                    <input
                      type="text"
                      name="code"
                      required
                      pattern="\d{6}"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      placeholder="000000"
                      maxLength={6}
                      className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-center text-base font-mono tracking-widest text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
                    />
                  </label>
                  <SubmitButton pendingLabel="Verifying…">Enable MFA</SubmitButton>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* CASE 3: Not enabled, no setup in progress */}
        {!status.enabled && !setupInProgress && (
          <Card className="space-y-3">
            {confirmed && (
              <Banner tone="success">
                MFA enabled successfully.
              </Banner>
            )}
            <p className="text-sm text-[var(--color-muted-fg)]">
              MFA is currently <strong>not enabled</strong>. We strongly recommend enabling it for any operator with workspace owner or admin permissions.
            </p>
            <form action={setupMfa}>
              <SubmitButton pendingLabel="Starting setup…">Set up MFA</SubmitButton>
            </form>
          </Card>
        )}
      </section>

      {/* ─── Passkeys ─────────────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Passkeys"
          description="Sign in with Touch ID, Windows Hello, or a hardware key. Phishing-resistant and stronger than TOTP."
        />
        <Card>
          <Link
            href="/account/passkeys"
            className="rounded text-sm font-medium text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            Manage passkeys →
          </Link>
        </Card>
      </section>

      {/* ─── Active sessions ──────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Active sessions"
          description="Devices with a live refresh token for your operator account. Revoke any you don't recognize."
          action={
            sessions.length > 0 ? (
              <form action={signOutEverywhere} className="shrink-0">
                <ConfirmButton confirm="Sign out of every device, including this one?">
                  Sign out everywhere
                </ConfirmButton>
              </form>
            ) : undefined
          }
        />

        {(sessionRevoked || signedOutAll) && (
          <Banner tone="success">
            {signedOutAll ? 'Signed out of all devices.' : 'Session revoked.'}
          </Banner>
        )}

        <Card padded={false} className="divide-y divide-[var(--color-border)]">
          {sessions.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-[var(--color-muted-fg)]">
              No active sessions.
            </div>
          ) : (
            sessions.map((s) => {
              const device = describeUserAgent(s.userAgent);
              return (
              <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-sm text-[var(--color-fg)]" title={s.userAgent ?? undefined}>
                    {device.label}
                  </div>
                  <div className="text-xs text-[var(--color-muted-fg)]">
                    {s.ip ?? 'unknown IP'} · started {formatDateTime(s.createdAt)}
                  </div>
                  {device.note && (
                    <div className="mt-0.5 text-xs text-[var(--color-faint-fg)]">{device.note}</div>
                  )}
                </div>
                <form action={revokeSession} className="shrink-0">
                  <input type="hidden" name="sessionId" value={s.id} />
                  <ConfirmButton confirm="Revoke this session? That device is signed out immediately and has to log in again.">Revoke</ConfirmButton>
                </form>
              </div>
              );
            })
          )}
        </Card>
      </section>

      {/* ─── Change password ─────────────────────────────── */}
      <section className="space-y-4">
        <SectionHeader
          title="Change password"
          description="Other sessions on other devices are signed out on success."
        />

        <form
          action={changePassword}
          className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        >
          {pwerror && (
            <Banner tone="error">
              {ERR[pwerror] ?? pwerror}
            </Banner>
          )}
          {pwchanged && (
            <Banner tone="success">
              Password changed.
            </Banner>
          )}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--color-fg)]">Current password</span>
            <input
              type="password"
              name="currentPassword"
              required
              autoComplete="current-password"
              className={inputCls}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium text-[var(--color-fg)]">New password</span>
            <input
              type="password"
              name="newPassword"
              required
              autoComplete="new-password"
              minLength={8}
              className={inputCls}
            />
            <span className="text-xs text-[var(--color-muted-fg)]">At least 8 characters.</span>
          </label>
          <SubmitButton pendingLabel="Changing password…" className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60">Change password</SubmitButton>
          {/* Visually hidden (not display:none, which many password managers
              skip) so managers associate the new credential with the operator
              email. Placed last so Tailwind's space-y rhythm is unaffected. */}
          {operatorEmail && (
            <input
              type="email"
              name="username"
              value={operatorEmail}
              readOnly
              autoComplete="username"
              tabIndex={-1}
              aria-hidden="true"
              className="sr-only"
            />
          )}
        </form>
      </section>

      <p className="border-t border-[var(--color-border)] pt-4 text-center text-xs text-[var(--color-muted-fg)]">
        <Link href="/team" className="rounded hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]">
          Looking for team management? →
        </Link>
      </p>
    </section>
  );
}

function StatusPill({
  enabled,
  setupInProgress,
}: {
  enabled: boolean;
  setupInProgress: boolean;
}): React.JSX.Element {
  if (enabled) {
    return (
      <Badge tone="success" dot>
        Enabled
      </Badge>
    );
  }
  if (setupInProgress) {
    return (
      <Badge tone="warning" dot>
        Setup in progress
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" dot>
      Not enabled
    </Badge>
  );
}

function StepHeader({ n, title }: { n: number; title: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-primary)] text-xs font-semibold text-[var(--color-primary-fg)]">
        {n}
      </span>
      <h3 className="text-sm font-medium text-[var(--color-fg)]">{title}</h3>
    </div>
  );
}

/** Pull the `secret` query param out of an otpauth URL for the manual-entry fallback. */
function extractSecret(otpauthUrl: string): string {
  const match = /[?&]secret=([^&]+)/i.exec(otpauthUrl);
  return match ? decodeURIComponent(match[1]!) : '';
}
