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

/**
 * How long an issued checkout session is treated as still completable.
 *
 * There is no exact answer available locally: the processor owns the clock and
 * does not tell us when it stops. A Stripe Checkout Session is completable for
 * about 24 hours, which is also the window the coupon reservation minted
 * alongside it holds (`RESERVATION_TTL_MS` in coupons.service.ts), so the two
 * expire together rather than leaving a checkout that can still be paid
 * carrying a discount that can no longer be honoured.
 *
 * Read by the provider-binding guard in billing.service.ts, which counts a
 * PENDING row as a live billing relationship only while it is inside this
 * window.
 */
export const CHECKOUT_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

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

/** How many refused second completions a row remembers. */
const UNAPPLIED_COMPLETION_HISTORY = 10;

/** Shape of the subscription metadata this module owns. */
interface CheckoutMetadata extends Record<string, unknown> {
  checkoutSessionId: string;
  checkoutSessionIds: string[];
  couponBySession: Record<string, SessionCoupon>;
  providerBySession: Record<string, string>;
}

/** A completion that arrived for a row another completion had already settled. */
export interface UnappliedCompletion {
  /** The session that completed and was NOT applied. */
  checkoutSessionId: string;
  /** The provider-side subscription it created, which nothing local now points at. */
  providerSubId: string;
  /** The processor that session was opened at, when the row recorded it. */
  provider: string | null;
  at: string;
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
  /**
   * The processor this session was opened at. Recorded per session for the
   * same reason the coupon is: the row's `provider` column is whichever
   * checkout ran most recently, written before anybody has paid. A buyer who
   * opens Stripe, goes back and opens PayPal, then returns to the first tab
   * and pays leaves the row naming PayPal and carrying a Stripe subscription
   * id — and `cancelCurrentSubscription` reads `provider` to decide who to
   * dial. The completion applier stamps the column from the session that
   * actually completed.
   */
  provider: string;
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

  // Same pruning rule as the coupon map, for the same reason: keyed by the
  // session list, it must not outgrow it.
  const providerBySession: Record<string, string> = {};
  for (const [id, value] of Object.entries(asRecord(previous.providerBySession))) {
    if (!ids.includes(id) || typeof value !== 'string') continue;
    providerBySession[id] = value;
  }
  providerBySession[input.sessionId] = input.provider;

  const metadata: CheckoutMetadata = {
    ...previous,
    checkoutSessionId: input.sessionId,
    checkoutSessionIds: ids,
    couponBySession,
    providerBySession,
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

/**
 * The processor a specific session was opened at, read off a subscription's
 * metadata, or null when the row predates `providerBySession`.
 *
 * There is deliberately no fallback to the row's `provider` column. That column
 * is the newest checkout's processor, not the completing session's, and reading
 * it here would reintroduce exactly the mismatch this map exists to fix. A null
 * means "unknown", and the caller leaves the column alone.
 */
export function providerForSession(metadata: unknown, sessionId: string): string | null {
  const value = asRecord(asRecord(metadata).providerBySession)[sessionId];
  return typeof value === 'string' ? value : null;
}

/**
 * Record a completion that arrived for a subscription another completion had
 * already settled, so the provider-side subscription it created is findable.
 *
 * The applier refuses those writes (see `applyCheckoutCompleted`), which keeps
 * the local row pointing at the FIRST relationship instead of silently
 * stranding it. But refusing does not make the second one stop existing: the
 * buyer was charged at a processor nothing local now names, and a log line is
 * not something an operator can query three weeks later. This is.
 *
 * Bounded like the session history, and for the same reason.
 */
export function recordUnappliedCompletion(
  metadata: unknown,
  entry: UnappliedCompletion,
): Record<string, unknown> {
  const previous = asRecord(metadata);
  const existing = Array.isArray(previous.unappliedCompletions)
    ? previous.unappliedCompletions.filter(
        (v): v is UnappliedCompletion =>
          typeof asRecord(v).providerSubId === 'string' &&
          typeof asRecord(v).checkoutSessionId === 'string',
      )
    : [];
  // Idempotent: a re-delivered second completion must not lengthen the list.
  if (existing.some((v) => v.providerSubId === entry.providerSubId)) return previous;
  return {
    ...previous,
    unappliedCompletions: [...existing, entry].slice(-UNAPPLIED_COMPLETION_HISTORY),
  };
}

// There was a `newestCheckoutSessionId(metadata)` helper here, and it is gone
// on purpose. Its one caller was the payment applier, which used it to pick the
// coupon a payment redeemed — and "the row's newest session" is not "the
// session this payment settled". Opening a new discounted checkout and then
// letting the existing subscription renew redeemed the new coupon off the
// renewal invoice, for free, every period. Appliers key off the session the
// EVENT names; nothing should reach for the newest again.
