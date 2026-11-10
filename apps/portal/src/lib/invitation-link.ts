/**
 * An organization invitation token, moved out of the link's URL into an
 * httpOnly cookie scoped to `/<slug>`, like the sign-in link's. It outlives
 * a sign-in or sign-up, so the invitee can accept once signed in.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { cookieSecure } from './cookie-secure';
import { portalCustomHost } from './public-base';

export const INVITATION_LINK = 'rekey_portal_invitation';
/** Long enough to sign up and come back; the API's own expiry still decides. */
const INVITATION_LINK_MAX_AGE = 24 * 60 * 60;
export const MAX_INVITATION_TOKEN_LENGTH = 512;

interface CookieSink {
  set(name: string, value: string, options: { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number }): unknown;
}

async function options(slug: string, maxAge: number) {
  return { httpOnly: true as const, sameSite: 'lax' as const, secure: await cookieSecure(), path: (await portalCustomHost()) ? '/' : `/${slug}`, maxAge };
}

export function invitationPath(slug: string): string {
  return `/${slug}/invitation`;
}

export async function writeInvitationLink(sink: CookieSink, slug: string, token: string): Promise<void> {
  sink.set(INVITATION_LINK, token, await options(slug, INVITATION_LINK_MAX_AGE));
}

export async function getInvitationLink(): Promise<string | null> {
  return (await cookies()).get(INVITATION_LINK)?.value || null;
}

export async function clearInvitationLink(slug: string): Promise<void> {
  (await cookies()).set(INVITATION_LINK, '', await options(slug, 0));
}
