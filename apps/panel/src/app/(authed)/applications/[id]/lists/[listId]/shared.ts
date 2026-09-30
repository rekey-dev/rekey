/**
 * The list the detail layout and its tabs all read. `apiGet` is cached per
 * request, so the header and the tab share one round trip.
 */

import type { ContactListConsentVersionDto, ContactListDto } from '@rekey.dev/shared-types';
import { apiGet } from '@/lib/api';

export type ListDetail = ContactListDto & { consentVersions: ContactListConsentVersionDto[] };

export function getList(id: string, listId: string): Promise<ListDetail> {
  return apiGet<ListDetail>(
    `/api/v1/tenant/applications/${encodeURIComponent(id)}/lists/${encodeURIComponent(listId)}`,
  );
}
