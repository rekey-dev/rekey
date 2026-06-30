/**
 * Product constants — the ReliPay meter / plan / feature slugs this app gates
 * on. These MUST match what's provisioned on the ReliPay Application you point
 * at. The deployed demo app "qr" is provisioned (see examples/qr-saas) with
 * exactly these slugs, so this boilerplate works against it unchanged.
 */

/** Usage meter: one event per public scan. Monthly hard cap per tier. */
export const METER_QR_SCANS = 'qr_scans';

/** Plan slugs modeled in ReliPay. */
export const PLAN_FREE = 'free';
export const PLAN_PRO = 'pro_monthly';
export const PLAN_CREDITS = 'qr_bulk_pack'; // CREDIT pack (500 credits / $19)

/** Feature-flag entitlement keys. */
export const FEAT_ANALYTICS = 'analytics';
export const FEAT_CUSTOM_DOMAIN = 'custom_domain';
/** INT feature: the max number of dynamic QRs the tier allows. */
export const FEAT_MAX_QRS = 'max_qr_codes';

/**
 * Free-tier default for the QR cap, used when the subject has no active
 * subscription (so no entitlement row). Mirrors the Free plan's provisioned
 * value in examples/qr-saas.
 */
export const FREE_MAX_QRS = 3;
