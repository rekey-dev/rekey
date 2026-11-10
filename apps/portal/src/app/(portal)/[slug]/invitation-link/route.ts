/**
 * GET /<slug>/invitation-link?token=<token>
 *
 * Where an organization invitation link lands. It spends nothing and renders
 * nothing: the token moves into an httpOnly cookie and the browser goes on to
 * the token-free invitation page, whose button accepts it.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { MAX_INVITATION_TOKEN_LENGTH, invitationPath, writeInvitationLink } from '@/lib/invitation-link';
import { isPlainSlug } from '@/lib/local-path';

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  if (!isPlainSlug(slug)) return new NextResponse('Not found', { status: 404 });
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: invitationPath(slug), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
  const token = req.nextUrl.searchParams.get('token') ?? '';
  if (token && token.length <= MAX_INVITATION_TOKEN_LENGTH) await writeInvitationLink(res.cookies, slug, token);
  return res;
}
