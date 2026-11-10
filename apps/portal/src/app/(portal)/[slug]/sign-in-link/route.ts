/**
 * GET /<slug>/sign-in-link?token=<token>
 *
 * Where an emailed sign-in link lands. It spends nothing: mail scanners fetch
 * links before the customer clicks, and the API's verify is single-use. The
 * token moves into a short-lived httpOnly cookie and the browser goes on to a
 * token-free sign-in page, whose "Sign in" button spends it through a Server
 * Action. No HTML is served at the tokened URL, so no page with the token in
 * its address renders or loads an operator's resources.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { writeSignInLink } from '@/lib/session';
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
      Location: `/${slug}/login?step=link`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (token && token.length <= MAX_TOKEN_LENGTH) await writeSignInLink(res.cookies, slug, token);
  return res;
}
