import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { rekey } from '@/lib/relipay';

async function requestReset(formData: FormData): Promise<void> {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  if (!email) redirect('/forgot-password?error=missing');

  const result = await rekey.auth.requestPasswordReset({ email });

  // In a real app this is where you'd email `result.resetToken` to the user
  // via SendGrid / Resend / SES / your provider of choice. Rekey
  // deliberately does NOT send email — the customer's app owns delivery.
  //
  // For the demo we just print the reset link to the dev console + carry it
  // back to the page so you can click through. NEVER do this in production.
  if (result.resetToken) {
    // eslint-disable-next-line no-console
    console.log(`[demo] reset link for ${email}: /reset-password?token=${result.resetToken}`);
  }
  redirect(
    `/forgot-password?sent=1${
      result.resetToken ? `&demoToken=${encodeURIComponent(result.resetToken)}` : ''
    }`,
  );
}

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const sent = params.sent === '1';
  const demoToken = typeof params.demoToken === 'string' ? params.demoToken : null;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6">
      <form action={requestReset} className="w-full max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">Reset password</h1>

        {error === 'missing' && (
          <p role="alert" className="rounded border border-red-300 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            Email is required.
          </p>
        )}
        {sent && (
          <div className="rounded border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 px-3 py-2 text-sm space-y-2">
            <p className="text-emerald-800 dark:text-emerald-300">
              If that email is registered, a reset link has been sent.
            </p>
            {demoToken && (
              <p className="text-xs">
                <span className="font-medium">Demo only — </span>
                Rekey does not send email; in production your server emails the link.
                Click here:{' '}
                <Link
                  href={`/reset-password?token=${encodeURIComponent(demoToken)}`}
                  className="underline"
                >
                  /reset-password
                </Link>
              </p>
            )}
          </div>
        )}

        <input
          type="email"
          name="email"
          aria-label="Email"
          required
          autoFocus
          autoComplete="email"
          placeholder="you@example.com"
          className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="w-full rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Send reset link
        </button>

        <p className="text-sm text-neutral-500">
          <Link href="/sign-in" className="underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
