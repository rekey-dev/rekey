'use server';

/**
 * Server Actions — every mutating Rekey call lives here, behind the
 * `'use server'` boundary, so the secret key never reaches the browser.
 *
 * Auth lifecycle uses the @rekey.dev/nextjs/server helpers (cookie session);
 * everything else (billing, credits, orgs, sessions, password) uses the
 * @rekey.dev/node client from ./rekey.
 *
 * Form-driven actions follow the App Router convention: they read FormData,
 * do the work, then `redirect(...)` with a `?status=` / `?error=` query the
 * page renders. RekeyError codes are surfaced verbatim so the user sees the
 * real reason (INVALID_CREDENTIALS, BILLING_ORGANIZATION_REQUIRED, …).
 */

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import {
  signIn as nextSignIn,
  signUp as nextSignUp,
  signOut as nextSignOut,
} from '@rekey.dev/nextjs/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_COOKIE_OPTS, REFRESH_COOKIE_OPTS } from '@rekey.dev/nextjs';
import { rekey, RekeyError } from './relipay';
import { requireSession, getActiveOrgId } from './session';
import { PLAN_CREDITS } from './constants';

/** Base URL the app is reachable at — used to build checkout return URLs. */
function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:3040';
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `team-${Date.now()}`
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signInAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) redirect('/login?error=missing');
  try {
    const outcome = await nextSignIn({ email, password });
    if (outcome.kind === 'mfa_required') {
      // This boilerplate doesn't implement the TOTP second factor.
      redirect('/login?error=MFA_REQUIRED');
    }
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/login?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/dashboard');
}

export async function signUpAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) redirect('/signup?error=missing');
  try {
    await nextSignUp({ email, password });
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/signup?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/dashboard');
}

export async function signOutAction(): Promise<void> {
  await nextSignOut('/login');
}

/** Forgot password — request a reset token. Rekey does NOT send email, so in
 *  a no-transport setup the raw token comes back and we surface a reset link. */
export async function requestPasswordResetAction(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/forgot-password?error=missing');
  let token: string | null = null;
  try {
    const res = await rekey.auth.requestPasswordReset({ email });
    token = res.resetToken ?? null;
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/forgot-password?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  // Enumeration-safe: always report "sent". If transport isn't configured the
  // token is returned so the demo can show the link.
  if (token) redirect(`/forgot-password?sent=1&token=${encodeURIComponent(token)}`);
  redirect('/forgot-password?sent=1');
}

/** Consume a reset token + set a new password. */
export async function resetPasswordAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!token || !password) redirect('/reset-password?error=missing');
  try {
    await rekey.auth.resetPassword({ token, newPassword: password });
  } catch (err) {
    if (err instanceof RekeyError) {
      redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  redirect('/login?reset=1');
}

// ---------------------------------------------------------------------------
// Account — sessions
// ---------------------------------------------------------------------------

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const sessionId = String(formData.get('sessionId') ?? '');
  const session = await requireSession();
  if (sessionId) await rekey.auth.revokeSession(session.accessToken, sessionId);
  revalidatePath('/account');
}

export async function signOutEverywhereAction(): Promise<void> {
  const session = await requireSession();
  await rekey.auth.signOutEverywhere(session.accessToken);
  await nextSignOut('/login?reason=signed-out-everywhere');
}

// ---------------------------------------------------------------------------
// Billing — checkout / credits
// ---------------------------------------------------------------------------

/**
 * Start a hosted checkout for a plan. When the app bills per-org and the
 * session is inside a team, the org id is attached so the subscription is
 * org-scoped. Without an org on an org-billing app, Rekey returns
 * BILLING_ORGANIZATION_REQUIRED — we surface it.
 */
export async function checkoutAction(formData: FormData): Promise<void> {
  const planSlug = String(formData.get('planSlug') ?? '');
  if (!planSlug) redirect('/billing?error=missing-plan');
  const session = await requireSession();
  const orgId = await getActiveOrgId(session.accessToken);
  try {
    const result = await rekey.billing.createCheckout(session.accessToken, {
      planSlug,
      successUrl: `${appBaseUrl()}/billing?upgraded=1`,
      cancelUrl: `${appBaseUrl()}/billing?upgrade=cancel`,
      ...(orgId ? { organizationId: orgId } : {}),
    });
    if (result.url) redirect(result.url);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/billing?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/billing?error=NO_CHECKOUT_URL');
}

/** Buy a prepaid credit pack (CREDIT-kind plan grants credits on payment). */
export async function buyCreditsAction(): Promise<void> {
  const session = await requireSession();
  const orgId = await getActiveOrgId(session.accessToken);
  try {
    const result = await rekey.billing.createCheckout(session.accessToken, {
      planSlug: PLAN_CREDITS,
      successUrl: `${appBaseUrl()}/billing?bought=credits`,
      cancelUrl: `${appBaseUrl()}/billing?buy=cancel`,
      ...(orgId ? { organizationId: orgId } : {}),
    });
    if (result.url) redirect(result.url);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/billing?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/billing?error=NO_CHECKOUT_URL');
}

// ---------------------------------------------------------------------------
// Organizations (teams)
// ---------------------------------------------------------------------------

/** Replace the session cookies with a freshly-minted token pair (from
 *  switch / clear-active), so later reads adopt the new active-org view. */
async function adoptTokens(accessToken: string, refreshToken: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACCESS_COOKIE, accessToken, ACCESS_COOKIE_OPTS);
  jar.set(REFRESH_COOKIE, refreshToken, REFRESH_COOKIE_OPTS);
}

export async function createOrgAction(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) redirect('/team?error=missing-name');
  const session = await requireSession();
  try {
    const { organization } = await rekey.organizations.create(session.accessToken, {
      name,
      slug: slugify(name),
    });
    // On an org-billing app, immediately switch into the new team so billing +
    // feature usage work — mirrors the gated flow in examples/qr-saas.
    const switched = await rekey.organizations.switch(session.accessToken, organization.id);
    await adoptTokens(switched.accessToken, switched.refreshToken);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/team?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/team?created=1');
}

export async function switchOrgAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  const session = await requireSession();
  try {
    if (orgId) {
      const switched = await rekey.organizations.switch(session.accessToken, orgId);
      await adoptTokens(switched.accessToken, switched.refreshToken);
    } else {
      const cleared = await rekey.organizations.clearActive(session.accessToken);
      await adoptTokens(cleared.accessToken, cleared.refreshToken);
    }
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/team?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
  redirect('/team?switched=1');
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get('orgId') ?? '');
  const email = String(formData.get('email') ?? '').trim();
  const role = (String(formData.get('role') ?? 'MEMBER') as 'OWNER' | 'ADMIN' | 'MEMBER');
  if (!orgId || !email) redirect('/team?error=missing-invite');
  const session = await requireSession();
  try {
    const { token } = await rekey.organizations.invite(session.accessToken, orgId, { email, role });
    // Rekey returns the raw invite token ONCE — a real app emails it; we
    // surface it so the demo user can copy the accept link.
    redirect(`/team?invited=1&token=${encodeURIComponent(token)}`);
  } catch (err) {
    if (err instanceof RekeyError) redirect(`/team?error=${encodeURIComponent(err.code)}`);
    throw err;
  }
}
