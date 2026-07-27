import * as React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { signUpAction } from '@/lib/actions';
import { Banner } from '@/components/banner';

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  if (await getSession()) redirect('/dashboard');
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : undefined;

  return (
    <main className="min-h-screen grid place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-5">
        <div className="text-center">
          <Link href="/" className="font-bold text-rekey-700 dark:text-rekey-500">
            Rekey SaaS
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">Create your account</h1>
          <p className="mt-1 text-sm text-neutral-500">It&apos;s free to start.</p>
        </div>

        <Banner error={error} />

        <form action={signUpAction} className="card space-y-3">
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" required autoFocus autoComplete="email" placeholder="you@example.com" className="field" />
          </div>
          <div>
            <label className="label" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" required autoComplete="new-password" placeholder="Choose a strong password" className="field" />
            <p className="mt-1 text-xs text-neutral-400">
              This application checks passwords against known breaches — pick something unique.
            </p>
          </div>
          <button type="submit" className="btn w-full">Create account</button>
        </form>

        <p className="text-center text-sm text-neutral-500">
          Already have an account?{' '}
          <Link href="/login" className="underline">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
