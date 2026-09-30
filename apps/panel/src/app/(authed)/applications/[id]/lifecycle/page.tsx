import { redirect } from 'next/navigation';

/** Lifecycle became the Application's Settings tab. Old links land there with their query. */
export default async function LifecycleRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const { id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      query.append(key, v);
    }
  }
  const qs = query.toString();
  redirect(`/applications/${encodeURIComponent(id)}/settings${qs ? `?${qs}` : ''}`);
}
