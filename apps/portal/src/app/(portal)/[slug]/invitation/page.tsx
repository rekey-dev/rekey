import * as React from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getPortalUser } from '@/lib/session';
import { getInvitationLink } from '@/lib/invitation-link';
import { invitationErrorCopy, maskedEmail, roleLabel } from '@/lib/organization-copy';
import { previewInvitation } from '@/lib/organizations';
import { checkoutLocale } from '@/lib/checkout-format';
import { PORTAL_TIME_ZONE, formatDate } from '@/lib/format';
import { acceptInvitationAction } from '@/lib/organization-actions';
import { signOutAndReturnAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { SubmitButton } from '@/components/submit-button';

export const dynamic = 'force-dynamic';

const mutedCls = 'text-sm text-[var(--color-muted-fg)]';
const linkCls = 'underline hover:text-[var(--color-fg)]';

export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const sp = await searchParams;
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const appName = config.branding.displayName || config.name;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const [token, session] = await Promise.all([getInvitationLink(), getPortalUser(slug)]);
  const preview = token ? await previewInvitation(slug, token) : null;
  const offer = preview && preview !== 'unavailable' ? preview : null;
  const locale = checkoutLocale((await headers()).get('accept-language'));
  const sentTo = offer ? offer.invitedEmail : 'the email address the invitation was sent to';
  const intro = offer ? (
    <p className="text-sm text-[var(--color-fg)]">
      {offer.invitedBy ?? 'Someone'} invited you to join <strong>{offer.organizationName}</strong> on{' '}
      {offer.applicationName} as {roleLabel(offer.role)}. The invitation was sent to {offer.invitedEmail} and expires on{' '}
      {formatDate(offer.expiresAt, locale, PORTAL_TIME_ZONE)}.
    </p>
  ) : (
    <p className={mutedCls}>You were invited to join an organization on {appName}.</p>
  );
  const wrongAccount = error === 'ORGANIZATION_INVITATION_EMAIL_MISMATCH' && offer && session;
  // The invited address arrives masked, so the signed-in one is compared masked
  // too. Equal masks are not proof, which is why accepting is still checked.
  const looksLikeTheInvitee =
    offer !== null && session !== null && maskedEmail(session.user.email).toLowerCase() === offer.invitedEmail.toLowerCase();

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Join an organization</h1>
      {wrongAccount ? (
        <Banner tone="error">
          This invitation was sent to {offer.invitedEmail}, and you are signed in as {session.user.email}. Sign out,
          then sign in with {offer.invitedEmail}.
        </Banner>
      ) : (
        error && <Banner tone="error">{invitationErrorCopy(error)}</Banner>
      )}
      {!token ? (
        !error && (
          <Banner tone="error">
            This page needs the invitation link you were sent. Open the link again, or ask for a new one.
          </Banner>
        )
      ) : preview === 'unavailable' ? (
        !error && (
          <Banner tone="error">
            This invitation is no longer valid. Ask the person who invited you to send a new one.
          </Banner>
        )
      ) : !session ? (
        <>
          {intro}
          <p className={mutedCls}>
            Sign in with {sentTo}, and you will come back here to accept it.
          </p>
          <a
            href={`/${slug}/login?return=invitation`}
            className="block w-full rounded-md bg-[var(--color-primary)] px-4 py-2.5 text-center text-sm font-medium text-[var(--color-primary-fg)]"
          >
            Sign in to accept
          </a>
          {config.auth.signup && config.auth.magicLink && (
            <p className={mutedCls}>New here? Ask for a sign-in link on the next page: it creates your account.</p>
          )}
        </>
      ) : (
        <>
          {intro}
          <p className={mutedCls}>
            You are signed in as <span className="break-all text-[var(--color-fg)]">{session.user.email}</span>
            {looksLikeTheInvitee
              ? '.'
              : `, which must be ${offer ? `the address it was sent to, ${offer.invitedEmail}` : 'the address the invitation was sent to'}.`}
          </p>
          <form action={acceptInvitationAction.bind(null, slug)}>
            <SubmitButton pendingLabel="Joining…" className="w-full">
              Accept invitation
            </SubmitButton>
          </form>
          <form action={signOutAndReturnAction.bind(null, slug, 'invitation')}>
            <p className={mutedCls}>
              Not you?{' '}
              <button type="submit" className={`min-h-11 ${linkCls}`}>
                Sign out and use another account
              </button>
            </p>
          </form>
        </>
      )}
    </div>
  );
}
