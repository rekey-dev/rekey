'use server';

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';

export async function saveOidcProvider(applicationId: string, formData: FormData): Promise<void> {
  // Empty clears the stored URL; the API treats '' and null the same.
  const hostedAuthorizeUrl = String(formData.get('hostedAuthorizeUrl') ?? '').trim();
  try {
    await api({
      method: 'PATCH',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/auth-config`,
      body: { oidcEnabled: formData.get('oidcEnabled') === 'on', hostedAuthorizeUrl },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/applications/${applicationId}/oauth-clients?${await errorQuery(err)}`);
    }
    throw err;
  }
  redirect(`/applications/${applicationId}/oauth-clients?e=oidc_saved`);
}
