/**
 * The bookkeeping that links a provider checkout session back to the local
 * `Subscription` row — and, critically, keeps linking the OLDER ones.
 *
 * ## Why a list and not a field
 *
 * `createCheckoutSession` upserts ONE row per (application, end-user, plan), so
 * a buyer who opens checkout twice reuses the same row and the second session
 * id overwrites the first. The provider does not care: a Stripe Checkout
 * Session stays completable for about 24 hours, and so does the ad-hoc coupon
 * minted alongside it. Completing the FIRST one then matched no local row at
 * all — the webhook answered 200, the subscription stayed PENDING, no payment
 * was recorded and no coupon was redeemed. The buyer had paid.
 *
 * So the row remembers every session it has issued that could still be
 * completed, newest last, and every lookup matches any of them. The newest id
 * also stays at `metadata.checkoutSessionId` because that is what the rest of
 * the system (and every row written before this) reads.
 *
 * ## Why the coupon is per session, not per row
 *
 * `metadata.couponId` used to be the coupon of whichever checkout ran most
 * recently, which is the wrong answer twice over: completing an older session
 * would redeem a coupon that session never carried, and a second checkout
 * without a coupon left the previous one's id in place. Each session carries
 * its own, so completing session N redeems session N's coupon or none.
 *
 * The history is bounded — an unbounded array on a JSON column that every
 * webhook reads is a slow leak, and a buyer with more live sessions than this
 * is not a case worth carrying.
 */

/** How many issued-but-not-yet-completed sessions a row remembers. */
export const CHECKOUT_SESSION_HISTORY = 10;

/** The coupon a single checkout session carried, if any. */
export interface SessionCoupon {
  couponId: string;
  /** Discount in the smallest currency unit, as resolved at checkout time. */
  discountAmount: number;
  /**
   * The `maxRedemptions` reservation this checkout took, when the coupon has a
   * global limit (see the RESERVED rows in coupons.service.ts). Carried on the session rather than
   * the row because the hold belongs to ONE checkout: completing session N must
   * release session N's slot and nobody else's. Absent for unlimited coupons
   * and for sessions written before holds existed — releasing is a no-op then,
   * and the hold expires on its own TTL either way.
   */
  holdId?: string;
}

/** Shape of the subscription metadata this module owns. */
interface CheckoutMetadata extends Record<string, unknown> {
  checkoutSessionId: string;
  checkoutSessionIds: string[];
  couponBySession: Record<string, SessionCoupon>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The metadata to write for a newly created checkout session, merged over
 * whatever the row already carried.
 *
 * Keys that other code reads are preserved verbatim: `checkoutSessionId` is
 * the newest session, and `couponId` / `discountAmount` mirror the newest
 * session's coupon (or are dropped when this checkout carries none — leaving a
 * previous checkout's coupon on the row is how a code got redeemed against a
 * purchase that never used it).
 */
export function buildCheckoutSessionMetadata(input: {
  previous: unknown;
  sessionId: string;
  isOneTime: boolean;
  coupon: SessionCoupon | null;
}): Record<string, unknown> {
  const previous = asRecord(input.previous);
  const previousIds = stringArray(previous.checkoutSessionIds);
  // The pre-existing single-field spelling still counts as history: a row
  // written before this module existed has one live session and it is there.
  const legacyId =
    typeof previous.checkoutSessionId === 'string' ? previous.checkoutSessionId : null;
  const ids = [...new Set([...previousIds, ...(legacyId ? [legacyId] : []), input.sessionId])]
    .slice(-CHECKOUT_SESSION_HISTORY);

  const couponBySession: Record<string, SessionCoupon> = {};
  for (const [id, value] of Object.entries(asRecord(previous.couponBySession))) {
    // Only carry entries for sessions still in the window, so the map cannot
    // outgrow the list it is keyed by.
    const entry = asRecord(value);
    if (!ids.includes(id) || typeof entry.couponId !== 'string') continue;
    couponBySession[id] = {
      couponId: entry.couponId,
      discountAmount: typeof entry.discountAmount === 'number' ? entry.discountAmount : 0,
      ...(typeof entry.holdId === 'string' && { holdId: entry.holdId }),
    };
  }
  if (input.coupon) couponBySession[input.sessionId] = input.coupon;

  const metadata: CheckoutMetadata = {
    ...previous,
    checkoutSessionId: input.sessionId,
    checkoutSessionIds: ids,
    couponBySession,
  };
  if (input.isOneTime) metadata.oneTime = true;
  if (input.coupon) {
    metadata.couponId = input.coupon.couponId;
    metadata.discountAmount = input.coupon.discountAmount;
  } else {
    delete metadata.couponId;
    delete metadata.discountAmount;
  }
  return metadata;
}

/**
 * Prisma `where` fragment matching the subscription that issued `sessionId` —
 * whether it is the row's newest session or one it issued earlier.
 *
 * Both branches are kept rather than only the array one: rows written before
 * this module have no `checkoutSessionIds`, and their single field is the only
 * thing that identifies them.
 */
export function checkoutSessionWhere(
  applicationId: string,
  sessionId: string,
): { applicationId: string; OR: object[] } {
  return { applicationId, OR: checkoutSessionMatchers(sessionId) };
}

/** The two `OR` branches of `checkoutSessionWhere`, for composing into a wider query. */
export function checkoutSessionMatchers(sessionId: string): object[] {
  return [
    { metadata: { path: ['checkoutSessionId'], equals: sessionId } },
    // Postgres form: the needle is passed as a one-element array.
    { metadata: { path: ['checkoutSessionIds'], array_contains: [sessionId] } },
  ];
}

/**
 * The coupon a specific session carried, read off a subscription's metadata.
 *
 * Falls back to the row-level `couponId` only when the row predates
 * `couponBySession` AND the session asked about is the row's newest — never
 * for an older session, which by definition was not the one that stamped it.
 */
export function couponForSession(metadata: unknown, sessionId: string): SessionCoupon | null {
  const meta = asRecord(metadata);
  const perSession = asRecord(asRecord(meta.couponBySession)[sessionId]);
  if (typeof perSession.couponId === 'string') {
    return {
      couponId: perSession.couponId,
      discountAmount:
        typeof perSession.discountAmount === 'number' ? perSession.discountAmount : 0,
      ...(typeof perSession.holdId === 'string' && { holdId: perSession.holdId }),
    };
  }
  if (meta.checkoutSessionId === sessionId && typeof meta.couponId === 'string') {
    return {
      couponId: meta.couponId,
      discountAmount: typeof meta.discountAmount === 'number' ? meta.discountAmount : 0,
    };
  }
  return null;
}

// There was a `newestCheckoutSessionId(metadata)` helper here, and it is gone
// on purpose. Its one caller was the payment applier, which used it to pick the
// coupon a payment redeemed — and "the row's newest session" is not "the
// session this payment settled". Opening a new discounted checkout and then
// letting the existing subscription renew redeemed the new coupon off the
// renewal invoice, for free, every period. Appliers key off the session the
// EVENT names; nothing should reach for the newest again.
