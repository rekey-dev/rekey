import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getPortalUser, getSignInReturn } from '@/lib/session';
import { afterSignInPath } from '@/lib/sign-in-return';
import { getPortalConfig } from '@/lib/config';
import { twoFactorSetUpOutstanding } from '@/lib/two-factor';
import { confirmTwoFactorSetUpAction, startTwoFactorSetUpAction } from '@/lib/two-factor-actions';
import { TwoFactorSetUpSteps } from '@/components/two-factor-set-up-steps';

export const dynamic = 'force-dynamic';

export default async function TwoFactorSetUpPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const continueHref = afterSignInPath(slug, await getSignInReturn());
  if (!(await twoFactorSetUpOutstanding(config, session.accessToken))) redirect(continueHref);
  const appName = config.branding.displayName || config.name;

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Set up two-factor authentication</h1>
      <p className="text-sm text-[var(--color-muted-fg)]">
        {appName} asks for a code from an authenticator app each time you sign in, to keep your account safe. Set it
        up now to continue to your account. You need an authenticator app on your phone or computer.
      </p>
      <TwoFactorSetUpSteps
        start={startTwoFactorSetUpAction.bind(null, slug)}
        confirm={confirmTwoFactorSetUpAction.bind(null, slug)}
        continueHref={continueHref}
      />
    </div>
  );
}
