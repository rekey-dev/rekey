import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getPortalUser } from '@/lib/session';
import { getPortalConfig } from '@/lib/config';
import { redirectWhileTwoFactorOutstanding } from '@/lib/two-factor';
import { profileQuestions } from '@/lib/profile-completion';
import { draftOf, outstandingProfileFields } from '@/lib/profile-form';
import { saveProfileAction } from '@/lib/profile-completion-actions';
import { PROFILE_COMPLETE_INTRO } from '@/lib/profile-completion-copy';
import { afterSignInPath, signInReturnPage } from '@/lib/sign-in-return';
import { ProfileQuestionsForm } from '@/components/profile-questions-form';

export const dynamic = 'force-dynamic';

export default async function CompleteProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  const returnTo = signInReturnPage((await searchParams).return);
  const session = await getPortalUser(slug);
  if (!session) redirect(`/${slug}/login`);
  await redirectWhileTwoFactorOutstanding(slug, session.accessToken);
  const config = await getPortalConfig(slug);
  if (!config) notFound();
  const fields = await profileQuestions(config.publishableKey);
  const profile = session.user.profile ?? {};
  if (!fields || outstandingProfileFields(fields, profile).length === 0) redirect(afterSignInPath(slug, returnTo));

  const asked = fields.filter((f) => f.writableBy === 'user');

  return (
    <div className="mx-auto max-w-sm space-y-5 pt-10">
      <h1 className="text-lg font-semibold text-[var(--color-fg)]">Finish setting up your account</h1>
      <p className="text-sm text-[var(--color-muted-fg)]">{PROFILE_COMPLETE_INTRO}</p>
      <ProfileQuestionsForm
        fields={asked}
        initialValues={draftOf(asked, profile)}
        action={saveProfileAction.bind(null, slug, returnTo)}
      />
    </div>
  );
}
