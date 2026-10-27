'use server';

import { redirect } from 'next/navigation';
import { api, PanelApiError } from '@/lib/api';
import { keepQuery } from '@/lib/keep-query';
import type { Page } from '@/lib/paginate';
import { RETRY_ALL_CAP } from './retry-all-cap';

const VIEW_RULES = { status: /^(FAILED|PENDING|SUCCEEDED)$/, offset: /^\d{1,7}$/, ps: /^(10|25|100)$/ };

function endpointPath(applicationId: string, endpointId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/webhooks/${encodeURIComponent(endpointId)}`;
}

function landing(applicationId: string, endpointId: string, view: string, flags: Record<string, string>): string {
  const query = keepQuery(view, VIEW_RULES);
  for (const [key, value] of Object.entries(flags)) query.set(key, value);
  return `/applications/${applicationId}/webhooks/${endpointId}?${query.toString()}`;
}

/** Ids of the endpoint's newest FAILED deliveries, at most `RETRY_ALL_CAP`. */
async function failedDeliveryIds(
  applicationId: string,
  endpointId: string,
): Promise<{ ids: string[]; capped: boolean }> {
  const { items, page } = await api<Page<{ id: string }>>({
    method: 'GET',
    path: `${endpointPath(applicationId, endpointId)}/deliveries?status=FAILED&limit=${RETRY_ALL_CAP}`,
  });
  return { ids: items.map((d) => d.id), capped: page.hasMore };
}

export async function retryDelivery(
  applicationId: string,
  endpointId: string,
  deliveryId: string,
  view: string,
): Promise<void> {
  await api({
    method: 'POST',
    path: `${endpointPath(applicationId, endpointId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
  });
  redirect(landing(applicationId, endpointId, view, { retried: '1' }));
}

/**
 * Requeue the newest FAILED deliveries on this endpoint, up to `RETRY_ALL_CAP`.
 *
 * The ids are all collected before any retry: a retry moves its row to PENDING,
 * so paging the FAILED filter while retrying would skip rows. A retry the API
 * refuses (already retried, raced) is skipped. A rate limit stops the batch,
 * since every later retry would be refused too.
 */
export async function retryAllFailed(applicationId: string, endpointId: string, view: string): Promise<void> {
  const { ids, capped } = await failedDeliveryIds(applicationId, endpointId);
  let queued = 0;
  let paused = false;
  for (const id of ids) {
    try {
      await api({
        method: 'POST',
        path: `${endpointPath(applicationId, endpointId)}/deliveries/${encodeURIComponent(id)}/retry`,
      });
      queued += 1;
    } catch (err) {
      if (!(err instanceof PanelApiError)) throw err;
      if (err.statusCode === 429) {
        paused = true;
        break;
      }
    }
  }
  redirect(
    landing(applicationId, endpointId, view, {
      retriedAll: String(queued),
      of: String(ids.length),
      ...(capped ? { capped: '1' } : {}),
      ...(paused ? { paused: '1' } : {}),
    }),
  );
}
