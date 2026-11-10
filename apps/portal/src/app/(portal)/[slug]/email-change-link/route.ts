/**
 * GET /<slug>/email-change-link?token=<token>
 *
 * Where the link confirming a new email address lands. Like the sign-in link,
 * it spends nothing: mail scanners fetch links before the customer clicks.
 * The token moves into a short-lived httpOnly cookie and the browser goes on
 * to a token-free page whose button spends it.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { writeEmailChangeLink } from '@/lib/session';
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
      Location: `/${slug}/profile/email`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (token && token.length <= MAX_TOKEN_LENGTH) await writeEmailChangeLink(res.cookies, slug, token);
  return res;
}
