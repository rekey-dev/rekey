/**
 * GET /<slug>/oauth/callback?code=<code>&state=<state>
 *
 * Where a social provider sends the browser back. The code is spent here, on
 * the portal server, at the API's callback; the session comes back in that
 * response's body and goes into the usual httpOnly cookies. No page renders at
 * this address: every outcome is a redirect.
 */

import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';
import type { RekeyBrowserClient } from '@rekey.dev/react';
import { isPlainSlug } from '@/lib/local-path';
import { completeSignIn } from '@/lib/complete-sign-in';
import { publishableKeyPost, socialSignInReturnUrl, takeSocialSignIn } from '@/lib/social-sign-in';
import { socialSignInFailurePath } from '@/lib/social-sign-in-failure';

const MAX_CODE_LENGTH = 4096;

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  if (!isPlainSlug(slug)) return new Response('Not found', { status: 404 });
  const query = req.nextUrl.searchParams;
  const started = await takeSocialSignIn(slug, query.get('state'));
  if (!started) redirect(socialSignInFailurePath(slug, 'OAUTH_STATE_MISMATCH', ''));
  const { provider } = started;
  const code = query.get('code') ?? '';
  // The provider sends `error` instead of a code when the customer declined.
  if (!code || code.length > MAX_CODE_LENGTH) {
    redirect(socialSignInFailurePath(slug, 'OAUTH_CANCELED', provider));
  }
  const result = await publishableKeyPost<Awaited<ReturnType<RekeyBrowserClient['signIn']>>>(
    slug,
    `/api/v1/auth/oauth/${encodeURIComponent(provider)}/callback`,
    { code, redirectUri: await socialSignInReturnUrl(slug) },
  );
  if (!result.ok) redirect(socialSignInFailurePath(slug, result.code, provider, result.retryAfterSeconds));
  return completeSignIn(slug, result.data);
}
