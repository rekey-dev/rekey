/** Shared product constants — the ReliPay meter / plan / feature slugs. */

export const APP_SLUG = 'qr-saas';

/** Usage meter: one event per public scan. Gated by the per-tier monthly cap. */
export const METER_QR_SCANS = 'qr_scans';

/** Plans modeled in ReliPay. */
export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro_monthly';
export const PLAN_QR_PACK = 'qr_bulk_pack'; // CREDIT pack for bulk QR generation

/** Feature-flag entitlement keys. */
export const FEAT_ANALYTICS = 'analytics';
export const FEAT_CUSTOM_DOMAIN = 'custom_domain';
/** INT feature: the max number of dynamic QRs the tier allows. */
export const FEAT_MAX_QRS = 'max_qr_codes';

/** Free-tier defaults (also encoded as ReliPay entitlements on the Free plan).
 *
 * NOTE: a real Free tier would be ~100 scans/mo. We model it as a small number
 * here purely so the demo can demonstrate the USAGE hard cap (402) in a handful
 * of `usage.record` calls — ReliPay's global 100 req/min rate limiter (no env
 * override, no per-route exemption — see issues filed) makes recording ~100
 * events in a loop impractical from a local script. Override with
 * QR_FREE_SCANS env for experimentation. */
export const FREE_MAX_QRS = 3;
export const FREE_SCANS_PER_MONTH = Number(process.env.QR_FREE_SCANS ?? 8);

/** Pro-tier values. */
export const PRO_MAX_QRS = 1000; // "effectively unlimited" for the demo
export const PRO_SCANS_PER_MONTH = 10_000;
