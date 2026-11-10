/**
 * GET /<slug>/authorize?request=<id>
 *
 * Where the API's authorization endpoint sends the browser. It remembers the
 * request as the page sign-in returns to, before anything else can happen, so
 * that signing in, required two-factor setup and email confirmation all come
 * back to it, then goes on to the consent page. Only an id of the exact shape
 * the API issues is kept.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { writeSignInReturn } from '@/lib/session';
import { isPlainSlug } from '@/lib/local-path';
import { authorizeConsentPath, authorizeRequestId } from '@/lib/authorize-paths';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  if (!isPlainSlug(slug)) return new NextResponse('Not found', { status: 404 });
  const id = authorizeRequestId(req.nextUrl.searchParams.get('request'));
  const res = new NextResponse(null, {
    status: 303,
    headers: {
      Location: authorizeConsentPath(slug, id),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  if (id) await writeSignInReturn(res.cookies, slug, `authorize:${id}`);
  return res;
}
