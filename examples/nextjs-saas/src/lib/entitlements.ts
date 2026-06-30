/**
 * Entitlements resolution — ALWAYS server-side, from ReliPay, never from local
 * state. Feature gating in this app reads `billing.getEntitlements()`:
 *
 *   - max QR codes  → features.max_qr_codes  (INT; Free default when absent)
 *   - analytics     → features.analytics === true  (Pro feature flag)
 *   - credit balance→ entitlements.creditBalance
 *
 * The subject is the active org's shared pool when the session is inside a
 * team (org-billing), else the personal end-user.
 */

import 'server-only';
import { relipay } from './relipay';
import { FEAT_ANALYTICS, FEAT_MAX_QRS, FREE_MAX_QRS } from './constants';

export interface ResolvedEntitlements {
  /** Effective max QR codes for the tier. */
  maxQrs: number;
  /** Whether the analytics (Pro) feature is unlocked. */
  analytics: boolean;
  /** Live credit balance for the resolved subject. */
  creditBalance: number;
  /** True when the subject has a Pro-level (analytics) entitlement. */
  isPro: boolean;
  /** Raw feature map, for display/debugging. */
  features: Record<string, boolean | number | string>;
}

/**
 * Resolve a subject's entitlements. Pass the access token and the active org
 * id (or null for personal). Falls back to Free defaults when there's no
 * active subscription.
 */
export async function resolveEntitlements(
  accessToken: string,
  organizationId: string | null,
): Promise<ResolvedEntitlements> {
  const ent = await relipay.billing.getEntitlements(
    accessToken,
    organizationId ? { organizationId } : undefined,
  );
  const features = ent.features;
  const maxFromPlan =
    typeof features[FEAT_MAX_QRS] === 'number' ? (features[FEAT_MAX_QRS] as number) : null;
  const analytics = features[FEAT_ANALYTICS] === true;
  return {
    maxQrs: maxFromPlan ?? FREE_MAX_QRS,
    analytics,
    creditBalance: ent.creditBalance,
    isPro: analytics,
    features,
  };
}
