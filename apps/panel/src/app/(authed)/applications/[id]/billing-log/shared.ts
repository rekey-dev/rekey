/**
 * Reads for the billing log views and the trails embedded on other pages.
 *
 * Each returns null when the request failed for a reason other than the API
 * being busy, so a page says "could not be read" and never shows a failed
 * request as an empty log.
 */

import type { PriceFallbackSummary, ReconciliationReport } from '@rekey.dev/shared-types';
import { apiGet, PanelApiError, unlessBusy } from '@/lib/api';
import { LOG_INCLUDE, logQuery, readLogPage, type LogFilters, type LogPage } from '@/lib/billing-log';

function appPath(applicationId: string): string {
  return `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}`;
}

type RawPage = { items?: unknown; nextCursor?: unknown; actors?: unknown };

export const LOG_PAGE_SIZE = 50;
export const TRAIL_PAGE_SIZE = 20;

export async function getBillingLog(applicationId: string, filters: LogFilters): Promise<LogPage | null> {
  const raw = await apiGet<RawPage>(
    `${appPath(applicationId)}/billing/events?${logQuery(filters, LOG_PAGE_SIZE).toString()}`,
    { interruptOnAccessError: false },
  ).catch(unlessBusy(() => null));
  return raw === null ? null : readLogPage(raw);
}

/**
 * Whether the log has any entry at all: the newest one, unfiltered. Null when
 * the read failed, so a page claims nothing about the rest of the log.
 */
export async function billingLogHasEntries(applicationId: string): Promise<boolean | null> {
  const raw = await apiGet<RawPage>(`${appPath(applicationId)}/billing/events?limit=1`, {
    interruptOnAccessError: false,
  }).catch(() => null);
  if (raw === null) return null;
  return Array.isArray(raw.items) && raw.items.length > 0;
}

export type TrailOf = { paymentId: string } | { subscriptionId: string } | { endUserId: string };

function trailPath(applicationId: string, of: TrailOf): string {
  const base = appPath(applicationId);
  if ('paymentId' in of) return `${base}/billing/payments/${encodeURIComponent(of.paymentId)}/events`;
  if ('subscriptionId' in of) return `${base}/billing/subscriptions/${encodeURIComponent(of.subscriptionId)}/events`;
  return `${base}/end-users/${encodeURIComponent(of.endUserId)}/billing-events`;
}

/** The newest entries that name one payment, subscription or end user. */
export async function getBillingTrail(applicationId: string, of: TrailOf, limit = TRAIL_PAGE_SIZE): Promise<LogPage | null> {
  const raw = await apiGet<RawPage>(`${trailPath(applicationId, of)}?limit=${limit}&include=${LOG_INCLUDE}`, {
    interruptOnAccessError: false,
  }).catch(unlessBusy(() => null));
  return raw === null ? null : readLogPage(raw);
}

/** A read that either answers or says why not, so a refusal's own message and fix reach the page. */
export type Answer<T> = { ok: true; data: T } | { ok: false; code: string; message: string; fix: string | undefined };

async function answer<T>(path: string): Promise<Answer<T>> {
  try {
    return { ok: true, data: await apiGet<T>(path, { interruptOnAccessError: false }) };
  } catch (err) {
    if (err instanceof PanelApiError) {
      const refusal: Answer<T> = { ok: false, code: err.code, message: err.message, fix: err.fix };
      // A comparison that ran out of time is answered with a 503, and its fix
      // (a shorter period) is what the operator needs, not a retry notice.
      if (err.code === 'ANALYTICS_TIMEOUT') return refusal;
      return unlessBusy<Answer<T>>(() => ({ ok: false, code: err.code, message: err.message, fix: err.fix }))(err);
    }
    throw err;
  }
}

export function getPriceFallbacks(applicationId: string, periodQuery: string): Promise<Answer<PriceFallbackSummary>> {
  return answer<PriceFallbackSummary>(`${appPath(applicationId)}/billing/price-fallbacks?${periodQuery}`);
}

export function getReconciliation(applicationId: string, periodQuery: string): Promise<Answer<ReconciliationReport>> {
  return answer<ReconciliationReport>(`${appPath(applicationId)}/billing/reconciliation?${periodQuery}`);
}
