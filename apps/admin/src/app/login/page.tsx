import * as React from 'react';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/cookies';
import {
  checkAndCountLoginAttempt,
  clearLoginRateLimit,
  createSession,
  verifyKey,
  isAdminKeyConfigured,
} from '@/lib/auth';

const ERROR_MESSAGES: Record<string, string> = {
  missing: 'Paste the SUPER_ADMIN_KEY to sign in.',
  invalid: 'That key does not match. Verify and try again.',
  not_configured:
    'This admin deployment has no SUPER_ADMIN_KEY set, so no key can sign in. Set it on the admin container and restart — nothing you paste here will work until then.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  expired: 'Session expired. Sign in again.',
  signed_out: 'You have been signed out.',
};

async function clientIp(): Promise<string> {
  const h = await headers();
  const xff = h.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || h.get('x-real-ip') || 'unknown';
}

async function signIn(formData: FormData): Promise<void> {
  'use server';
  const presented = String(formData.get('key') ?? '').trim();
  if (!presented) redirect('/login?error=missing');

  // Check the deployment before blaming the operator. Without this, `verifyKey`
  // throws on a missing key and Next renders a generic 500 — so a self-hoster who
  // forgot the env var gets a crash page instead of the one sentence that fixes it.
  if (!isAdminKeyConfigured()) {
    console.error('[admin] login attempted but SUPER_ADMIN_KEY is not configured on this container');
    redirect('/login?error=not_configured');
  }

  const ip = await clientIp();
  const rate = checkAndCountLoginAttempt(ip);
  if (!rate.allowed) {
    // Log the throttled attempt to stderr so it shows in the container log.
    // No body: the IP + error code are what an oncall person needs.
    console.warn(`[admin] login rate-limited ip=${ip} retryAfter=${rate.retryAfterSeconds}s`);
    redirect('/login?error=rate_limited');
  }

  if (!verifyKey(presented)) {
    console.warn(`[admin] login failed ip=${ip}`);
    redirect('/login?error=invalid');
  }

  clearLoginRateLimit(ip);
  const id = createSession();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Match the in-memory TTL (12h). Sliding-renewed on every authed request.
    maxAge: 12 * 60 * 60,
  });
  console.info(`[admin] login ok ip=${ip}`);
  redirect('/');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;

  const inputCls =
    'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

  return (
    <main className="min-h-screen grid place-items-center px-6 bg-gradient-to-br from-[var(--color-bg)] to-[var(--color-surface-muted)]">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-mark.png" alt="" className="h-8 w-auto" />
          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--color-faint-fg)]">Rekey</p>
            <h1 className="text-lg font-semibold leading-none">Super Admin</h1>
          </div>
        </div>

        <p className="text-sm text-[var(--color-muted-fg)]">
          Read-only operator dashboard. Sign in with the deployment&apos;s{' '}
          <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 font-mono text-xs">SUPER_ADMIN_KEY</code>.
        </p>

        {error && (
          <p
            role="alert"
            className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-3 py-2 text-sm text-[var(--color-danger)]"
          >
            {ERROR_MESSAGES[error] ?? 'Sign-in failed.'}
          </p>
        )}

        <form action={signIn} className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Admin key</span>
            <input
              type="password"
              name="key"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="64-char hex token"
              className={inputCls}
            />
          </label>
          <button
            type="submit"
            className="w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            Sign in
          </button>
        </form>

        <p className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs leading-relaxed text-[var(--color-muted-fg)]">
          Sessions are 12-hour sliding; brute-force is throttled to 5 attempts per 5 minutes per IP. The dashboard is read-only apart from operator-invite key management.
        </p>
      </div>
    </main>
  );
}
