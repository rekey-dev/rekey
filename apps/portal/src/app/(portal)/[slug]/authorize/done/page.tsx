import * as React from 'react';
import { notFound } from 'next/navigation';
import { getPortalConfig } from '@/lib/config';
import { getAuthorizeDone } from '@/lib/authorize-request';
import { forgetAuthorizeDoneAction } from '@/lib/authorize-actions';
import { AuthorizeDoneView } from '@/components/authorize-done-view';

export const dynamic = 'force-dynamic';

/**
 * After Allow or Cancel for an app on this computer or behind its own scheme.
 * The target, code included, comes from a one-minute httpOnly cookie, never
 * this page's URL, and the page clears it once it has it.
 */
export default async function AuthorizeDonePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  if (!(await getPortalConfig(slug))) notFound();
  return <AuthorizeDoneView done={await getAuthorizeDone()} forget={forgetAuthorizeDoneAction.bind(null, slug)} />;
}
