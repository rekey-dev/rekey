import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

/** Root — straight to the subscription overview (or login). */
export default async function Home(): Promise<never> {
  const session = await getSession();
  redirect(session ? '/subscription' : '/login');
}
