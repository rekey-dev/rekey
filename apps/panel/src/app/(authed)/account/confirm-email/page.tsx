import * as React from 'react';
import type { Metadata } from 'next';
import Link from '@/components/Link';
import { getMe } from '@/lib/api';
import { Banner } from '@/components/Banner';
import { PageHeader } from '@/components/PageHeader';
import { CONFIRM_SEND_ERRORS } from '@/lib/confirm-email-errors';

export const metadata: Metadata = { title: 'Confirm your email · Rekey' };

/** Where "Send confirmation email" lands: what was sent, to where, and what to do next. */
export default async function ConfirmEmailSentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? CONFIRM_SEND_ERRORS[params.error] : undefined;
  const me = await getMe();
  return (
    <section className="mx-auto max-w-3xl space-y-6 px-6 py-8 lg:px-8">
      <PageHeader title="Confirm your email" description="Confirming your address unlocks the rest of your account." />
      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : me.user.emailVerified ? (
        <Banner tone="success">{me.user.email} is confirmed. Nothing else to do.</Banner>
      ) : (
        <Banner tone="success">
          We sent a confirmation email to {me.user.email}. Open the link in it in this browser, while signed in, and
          press &quot;Confirm email&quot;. It works for 24 hours, replaces any earlier confirmation email, and keeps
          your password and everything else as it is.
        </Banner>
      )}
      <p className="text-sm">
        <Link href="/applications" className="underline">
          Back to Applications
        </Link>
      </p>
    </section>
  );
}
