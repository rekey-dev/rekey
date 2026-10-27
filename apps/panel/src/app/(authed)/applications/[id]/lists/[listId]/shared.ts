/**
 * The list the detail layout and its tabs all read. `apiGet` is cached per
 * request, so the header and the tab share one round trip.
 */

import type { ContactListConsentVersionDto, ContactListDto } from '@rekey.dev/shared-types';
import { apiGet } from '@/lib/api';
import { keepQuery } from '@/lib/keep-query';

export type ListDetail = ContactListDto & { consentVersions: ContactListConsentVersionDto[] };

/**
 * The Members tab URL with the filter, search and page from `view` kept, plus `flag`.
 *
 * @example
 * membersHref('app_1', 'lst_1', 'status=subscribed&offset=25', 'unsubscribed=1');
 * // '/applications/app_1/lists/lst_1?status=subscribed&offset=25&unsubscribed=1'
 */
export function membersHref(applicationId: string, listId: string, view: string, flag: string): string {
  const kept = keepQuery(view, {
    status: /^(subscribed|unsubscribed)$/,
    search: /^[\s\S]{1,200}$/,
    offset: /^\d{1,7}$/,
    ps: /^(10|25|100)$/,
  }).toString();
  return `/applications/${applicationId}/lists/${listId}?${kept ? `${kept}&` : ''}${flag}`;
}

export function getList(id: string, listId: string): Promise<ListDetail> {
  return apiGet<ListDetail>(
    `/api/v1/tenant/applications/${encodeURIComponent(id)}/lists/${encodeURIComponent(listId)}`,
  );
}
