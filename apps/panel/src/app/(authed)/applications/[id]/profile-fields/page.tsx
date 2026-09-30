import { redirect } from 'next/navigation';

/** Profile fields moved into the Onboarding section; old links and bookmarks land there. */
export default async function ProfileFieldsMoved({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const { id } = await params;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') qs.set(k, v);
  }
  const query = qs.toString();
  redirect(`/applications/${id}/onboarding${query ? `?${query}` : ''}`);
}
