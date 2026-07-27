/**
 * POST /api/auth/magic-link — request a magic-link sign-in email.
 *
 * Enumeration-safe: same response whether or not the email exists. When the
 * Application has email transport configured, Rekey sends the link and
 * `magicLinkToken` is null. Without transport (e.g. the demo), the raw token
 * is returned so the UI can show the sign-in link directly. The link lands on
 * GET /api/auth/magic-link/verify which consumes it and sets the session.
 */

import { NextResponse } from 'next/server';
import { rekey, RekeyError, RELIPAY_URL } from '@/lib/relipay';

function appBaseUrl(req: Request): string {
  return process.env.APP_BASE_URL ?? new URL(req.url).origin;
}

export async function POST(req: Request): Promise<NextResponse> {
  void RELIPAY_URL; // imported to assert env is configured
  let email = '';
  try {
    const body = (await req.json().catch(() => ({}))) as { email?: string };
    email = (body.email ?? '').trim();
    if (!email) {
      return NextResponse.json({ error: { code: 'missing', message: 'Email is required.' } }, { status: 400 });
    }
    const result = await rekey.auth.requestMagicLink({
      email,
      // {token} is substituted by Rekey when it builds the email link.
      signInUrl: `${appBaseUrl(req)}/api/auth/magic-link/verify?token={token}`,
    });
    return NextResponse.json({
      // Enumeration-safe "we handled it" signal — true for unknown emails too.
      delivered: result.delivered,
      emailSent: result.emailSent,
      // Only present when no transport is configured.
      magicLinkToken: result.magicLinkToken,
    });
  } catch (err) {
    if (err instanceof RekeyError) {
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.statusCode ?? 400 });
    }
    throw err;
  }
}
