import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@/lib/api';

export default async function RootPage(): Promise<never> {
  const jar = await cookies();
  if (!jar.get(ACCESS_COOKIE)?.value) redirect('/login');
  redirect('/applications');
}
