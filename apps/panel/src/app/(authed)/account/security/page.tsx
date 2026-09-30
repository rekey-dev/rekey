/**
 * Account → Security: two-factor, a passkey summary, live sessions and the
 * password.
 *
 * Two-factor setup is three numbered steps: scan the QR code, save the backup
 * codes, confirm with the current 6-digit code. The seed and backup codes
 * travel in a short-lived cookie, never the URL (see MFA_SETUP_COOKIE).
 */

import * as React from 'react';
import Link from '@/components/Link';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { errorMessage } from '@/lib/error-message';
import { errorQuery, readErrorFlash, api, PanelApiError, type OperatorSessionRow, getMe, unlessBusy, apiGet } from '@/lib/api';
import { describeUserAgent } from '@/lib/format';
import { QrCode } from '@/components/QrCode';
import { ApiErrorText } from '@/components/api-error';
import { CopyButton } from '@/components/CopyButton';
import { DownloadButton } from '@/components/DownloadButton';
import { ConfirmButton } from '@/components/ConfirmButton';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { ActionForm } from '@/components/ActionForm';
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
 * with `?otpauth=…&backups=…` in the URL, that data ended up in browser
 * history, referer headers, and panel access logs. AUDIT-3 (2026-05-19):
 * we now stash them in a short-lived, HttpOnly, SameSite=strict cookie
 * (`rekey_mfa_setup`) scoped to /account/security, read once by the
 * page, then cleared after a successful confirm/disable.
 */
const MFA_SETUP_COOKIE = 'rekey_mfa_setup';
const MFA_SETUP_COOKIE_MAX_AGE = 60 * 5; // 5 minutes, long enough to scan, short enough to limit blast radius.

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
  // Successful confirm, clear the one-time-reveal cookie. Operators who
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
  // The change revoked every session, this one included: the API refuses the
  // access token on its next use and the refresh is gone. Sign out cleanly
  // rather than letting the next page load discover it as "expired".
  redirect('/sign-out?reason=password_changed');
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
  MFA_CODE_REUSED: 'That code was already used. Wait for your authenticator to show the next code, then enter it.',
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
      // Stale / corrupted cookie, ignore, the operator can re-run setup.
    }
  }
  const confirmed = sp.confirmed === '1';
  const disabled = sp.disabled === '1';

  const [status, { items: sessions }, operatorEmail, passkeyCount] = await Promise.all([
    api<MfaStatus>({ method: 'GET', path: '/api/v1/tenant/auth/mfa/status' }),
    api<Page<OperatorSessionRow>>({ method: 'GET', path: '/api/v1/tenant/auth/sessions' }),
    // For the change-password form's hidden username field, best-effort: the
    // form works without it.
    getMe()
      .then((me) => me.user.email)
      .catch(() => null),
    // Only the count is shown here; the list and its controls live on the
    // Passkeys page. Null on failure, so a failed read never reads as "none".
    apiGet<{ passkeys: unknown[] }>('/api/v1/tenant/auth/passkeys', { interruptOnAccessError: false })
      .then((r) => r.passkeys.length)
      .catch(unlessBusy(() => null)),
  ]);
  const sessionRevoked = sp.session_revoked === '1';
  const signedOutAll = sp.signed_out_all === '1';

  const setupInProgress = !status.enabled && Boolean(otpauth);

  return (
    <section className="mx-auto max-w-7xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader
        title="Account security"
        description="How you sign in to the panel, and where you are signed in right now."
      />

      {/* Outcome banners sit at the top because the card that triggered them
          has usually changed state by the time the page renders: after a
          confirm the setup steps are gone, after a disable the enabled card is. */}
      {confirmed && <Banner tone="success">Two-factor authentication is on.</Banner>}
      {disabled && <Banner tone="success">Two-factor authentication is off.</Banner>}
      {(sessionRevoked || signedOutAll) && (
        <Banner tone="success">{signedOutAll ? 'Signed out of all devices.' : 'Session revoked.'}</Banner>
      )}

      <nav aria-label="Security summary" className="grid gap-3 sm:grid-cols-3">
        <SummaryTile
          href="#two-factor"
          label="Two-factor"
          value={status.enabled ? 'On' : setupInProgress ? 'Setting up' : 'Off'}
          tone={status.enabled ? 'ok' : 'warn'}
          note={
            status.enabled
              ? `${status.remainingBackupCodes ?? 0} backup codes left`
              : 'Recommended for owners and admins'
          }
        />
        <SummaryTile
          href="#passkeys"
          label="Passkeys"
          value={passkeyCount === null ? "Couldn't load" : String(passkeyCount)}
          tone={passkeyCount !== null && passkeyCount > 0 ? 'ok' : 'idle'}
          note={
            passkeyCount === null
              ? 'Open Passkeys below to see them'
              : passkeyCount === 0
                ? 'None registered'
                : 'Registered on this account'
          }
        />
        <SummaryTile
          href="#sessions"
          label="Active sessions"
          value={String(sessions.length)}
          tone="idle"
          note="Devices signed in to the panel"
        />
      </nav>

      {/* ─── MFA ─────────────────────────────────────────── */}
      <section id="two-factor" className="scroll-mt-6">
        {status.enabled && (
          <Card className="space-y-4">
            <CardHeading
              title="Two-factor authentication"
              badge={<StatusPill enabled setupInProgress={false} />}
              description={`A code from your authenticator app is asked for at every sign-in. ${status.remainingBackupCodes ?? 0} backup codes left for a lost device.`}
            />
            {status.remainingBackupCodes !== null && status.remainingBackupCodes <= 3 && (
              <Banner tone="warning">
                Only a few backup codes are left. Turn two-factor off and set it up again to get a
                fresh set.
              </Banner>
            )}
            <ActionForm action={disableMfa} className="border-t border-[var(--color-border)] pt-4">
              <TypedConfirmButton
                expected="disable mfa"
                title="Disable two-factor authentication?"
                description="Your operator account will be protected by password only until you re-enroll. Backup codes are invalidated immediately."
                triggerLabel="Disable MFA"
                confirmLabel="Disable MFA"
              />
            </ActionForm>
          </Card>
        )}

        {/* Setup in progress: have otpauth but not yet confirmed */}
        {setupInProgress && (
          <Card padded={false} className="overflow-hidden">
            <div className="border-b border-[var(--color-border)] p-5">
              <CardHeading
                title="Two-factor authentication"
                badge={<StatusPill enabled={false} setupInProgress />}
                description="Three steps. The code and backup codes below are shown only on this screen."
              />
            </div>
            {/* Step 1, Scan */}
            <div className="border-b border-[var(--color-border)] p-5">
              <StepHeader n={1} title="Scan with your authenticator app" />
              <div className="mt-4 grid items-start gap-5 sm:grid-cols-[auto_1fr]">
                <QrCode value={otpauth!} size={180} />
                <div className="space-y-3 text-sm">
                  <p className="text-[var(--color-muted-fg)]">
                    Open 1Password, Authy or Google Authenticator and scan this QR code.
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

            {/* Step 2, Backup codes */}
            <div className="border-b border-[var(--color-border)] bg-amber-50/40 p-5 dark:bg-amber-950/20">
              <StepHeader n={2} title="Save your backup codes" />
              <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">
                These are shown <strong>once</strong>. Each works one time if you lose your authenticator. Rekey keeps only a one-way fingerprint of each.
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

            {/* Step 3, Confirm */}
            <div className="p-5">
              <StepHeader n={3} title="Confirm with the current 6-digit code" />
              <ActionForm action={confirmMfa} className="mt-3 space-y-2">
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
                      className="w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-center font-mono text-base tracking-widest text-[var(--color-fg)] focus:border-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)]"
                    />
                  </label>
                  <SubmitButton pendingLabel="Verifying…">Enable MFA</SubmitButton>
                </div>
              </ActionForm>
            </div>
          </Card>
        )}

        {/* Not enabled, no setup in progress */}
        {!status.enabled && !setupInProgress && (
          <Card className="space-y-4">
            <CardHeading
              title="Two-factor authentication"
              badge={<StatusPill enabled={false} setupInProgress={false} />}
              description="Ask for a code from an authenticator app (1Password, Authy, Google Authenticator) at every sign-in, with backup codes for a lost device. Turn it on if you are a workspace owner or admin."
            />
            <ActionForm action={setupMfa}>
              <SubmitButton pendingLabel="Starting setup…">Set up MFA</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </section>

      {/* ─── Passkeys ─────────────────────────────────────── */}
      <section id="passkeys" className="scroll-mt-6">
      <Card className="space-y-4">
        <CardHeading
          title="Passkeys"
          badge={
            passkeyCount !== null ? (
              <Badge tone={passkeyCount > 0 ? 'success' : 'neutral'} dot>
                {passkeyCount} registered
              </Badge>
            ) : undefined
          }
          description="Sign in with Touch ID, Windows Hello or a hardware key instead of a password and code. A passkey cannot be phished."
          action={
            <Link
              href="/account/passkeys"
              className="inline-flex rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              Manage passkeys
            </Link>
          }
        />
      </Card>
      </section>

      {/* ─── Active sessions ──────────────────────────────── */}
      <section id="sessions" className="scroll-mt-6 space-y-3" aria-labelledby="sessions-heading">
        <SectionHeader
          title={<span id="sessions-heading">Active sessions</span>}
          count={`(${sessions.length})`}
          description="Devices signed in to your operator account. Revoke any you don't recognize."
          action={
            sessions.length > 0 ? (
              <ActionForm action={signOutEverywhere} className="shrink-0">
                <ConfirmButton confirm="Sign out of every device, including this one?">
                  Sign out everywhere
                </ConfirmButton>
              </ActionForm>
            ) : undefined
          }
        />

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
                  <ActionForm action={revokeSession} className="shrink-0">
                    <input type="hidden" name="sessionId" value={s.id} />
                    <ConfirmButton confirm="Revoke this session? That device is signed out immediately and has to log in again.">Revoke</ConfirmButton>
                  </ActionForm>
                </div>
              );
            })
          )}
        </Card>
      </section>

      {/* ─── Change password ─────────────────────────────── */}
      <Card as="section" className="space-y-4">
        <CardHeading
          title="Change password"
          description="Every session is signed out when the password changes, this one included, so you sign in again with the new one."
        />
        <ActionForm action={changePassword} className="max-w-md space-y-3">
          {pwerror && <Banner tone="error">{errorMessage(ERR, pwerror)}</Banner>}
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
        </ActionForm>
      </Card>
    </section>
  );
}

/** A card's own title row: heading, status badge, one line of prose, and an optional action. */
function CardHeading({
  title,
  badge,
  description,
  action,
}: {
  title: string;
  badge?: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
          {badge}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-muted-fg)]">{description}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const TILE_DOT: Record<'ok' | 'warn' | 'idle', string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  idle: 'bg-neutral-400',
};

function SummaryTile({
  href,
  label,
  value,
  note,
  tone,
}: {
  href: string;
  label: string;
  value: string;
  note: string;
  tone: 'ok' | 'warn' | 'idle';
}): React.JSX.Element {
  return (
    <a
      href={href}
      className="group flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 transition-colors hover:border-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] dark:hover:border-neutral-600"
    >
      <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted-fg)]">
        <span className={`h-1.5 w-1.5 rounded-full ${TILE_DOT[tone]}`} aria-hidden />
        {label}
      </span>
      <span className="text-2xl font-semibold tabular-nums text-[var(--color-fg)]">{value}</span>
      <span className="text-xs leading-snug text-[var(--color-muted-fg)]">{note}</span>
    </a>
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
        on
      </Badge>
    );
  }
  if (setupInProgress) {
    return (
      <Badge tone="warning" dot>
        setting up
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" dot>
      off
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
