import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { signInAction } from '@/lib/actions';
import { Banner } from '@/components/banner';
import { MagicLinkForm } from '@/components/magic-link-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  if (await getSession()) redirect('/dashboard');
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;
  const reset = params.reset === '1';
  const reason = typeof params.reason === 'string' ? params.reason : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="font-bold text-relipay-700 dark:text-relipay-500">
            ReliPay SaaS
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Sign in</h1>
        </div>

        <Banner error={error} status={reset ? 'Password updated — sign in with your new password.' : reason === 'signed-out-everywhere' ? 'Signed out of all devices.' : undefined} />

        <form action={signInAction} className="card space-y-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoFocus autoComplete="email" placeholder="you@example.com" className="field" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="current-password" placeholder="Your password" className="field" />
          </div>
          <button type="submit" className="btn w-full">Sign in</button>
        </form>

        <MagicLinkForm />

        <p className="text-center text-sm text-neutral-500">
          <Link href="/signup" className="underline">Create account</Link>
          {' · '}
          <Link href="/forgot-password" className="underline">Forgot password?</Link>
        </p>
      </div>
    </main>
  );
}
