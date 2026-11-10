/**
 * GET /<slug>/reset-password-link?token=<token>
 *
 * Where an emailed password reset link lands, handled like the sign-in link:
 * the token moves into a short-lived httpOnly cookie and the browser goes on to
 * the token-free reset form, whose submit spends it. No HTML is served at the
 * tokened URL, so the token never sits in a rendered page's address, history
 * or Referer.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { writeResetPasswordLink } from '@/lib/session';
import { isPlainSlug } from '@/lib/local-path';

const MAX_TOKEN_LENGTH = 512;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  if (!isPlainSlug(slug)) return new NextResponse('Not found', { status: 404 });
  const res = new NextResponse(null, {
    status: 303,
    headers: {
      Location: `/${slug}/reset-password`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (token && token.length <= MAX_TOKEN_LENGTH) await writeResetPasswordLink(res.cookies, slug, token);
  return res;
}
