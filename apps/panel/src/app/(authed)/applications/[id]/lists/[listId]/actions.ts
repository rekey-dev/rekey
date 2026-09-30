'use server';

import { redirect } from 'next/navigation';
import { api, errorQuery, PanelApiError } from '@/lib/api';

/**
 * Archive or restore a list. Used by the button in the list header and by the
 * Settings tab, and lands on Members either way: the header's archived state
 * is the confirmation on every tab.
 */
export async function setListArchived(applicationId: string, listId: string, archived: boolean): Promise<void> {
  const base = `/applications/${applicationId}/lists/${listId}`;
  try {
    await api({
      method: archived ? 'POST' : 'DELETE',
      path: `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/lists/${encodeURIComponent(listId)}/archive`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) redirect(`${base}?${await errorQuery(err)}`);
    throw err;
  }
  redirect(`${base}?done=${archived ? 'archived' : 'restored'}`);
}
