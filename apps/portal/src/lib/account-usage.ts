/**
 * What the customer's plans give them, read with their own token: features
 * and limits, metered usage, credits, licenses and trial eligibility. Each
 * read answers null when the API cannot, so one failure hides one card.
 */

import 'server-only';
import type {
  EndUserLicenseDto,
  ResolvedEntitlementsDto,
  TrialEligibilityItemDto,
  UsageRemainingDto,
} from '@rekey.dev/shared-types';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';

export type CreditLedgerEntry = {
  id: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
};

/** How many ledger entries the dashboard shows. */
const RECENT_LEDGER = 5;

async function read<T>(config: PortalConfig, accessToken: string, path: string): Promise<T | null> {
  if (!config.billingEnabled) return null;
  const result = await customerCall<T>(config, accessToken, 'GET', path);
  return result.ok ? result.data : null;
}

export function entitlements(config: PortalConfig, accessToken: string): Promise<ResolvedEntitlementsDto | null> {
  return read(config, accessToken, '/api/v1/billing/entitlements');
}

export function usageRemaining(config: PortalConfig, accessToken: string): Promise<UsageRemainingDto | null> {
  return read(config, accessToken, '/api/v1/usage/remaining');
}

export async function recentCredits(config: PortalConfig, accessToken: string): Promise<CreditLedgerEntry[] | null> {
  const page = await read<{ items: CreditLedgerEntry[] }>(
    config,
    accessToken,
    `/api/v1/credits/me/ledger?limit=${RECENT_LEDGER}`,
  );
  return page?.items ?? null;
}

export async function licenses(config: PortalConfig, accessToken: string, limit = 100): Promise<EndUserLicenseDto[] | null> {
  const page = await read<{ items: EndUserLicenseDto[] }>(config, accessToken, `/api/v1/users/me/licenses?limit=${limit}`);
  return page?.items ?? null;
}

/**
 * Per plan slug, the API's answer on whether this buyer may start its trial.
 * An org-billed application answers for the organization checkout would bill.
 */
export async function trialEligibility(
  config: PortalConfig,
  accessToken: string,
  organizationId: string | null,
): Promise<Map<string, TrialEligibilityItemDto>> {
  const query = organizationId ? `&organizationId=${encodeURIComponent(organizationId)}` : '';
  const page = await read<{ items: TrialEligibilityItemDto[] }>(
    config,
    accessToken,
    `/api/v1/billing/trial-eligibility?limit=100${query}`,
  );
  return new Map((page?.items ?? []).map((item) => [item.planSlug, item]));
}
