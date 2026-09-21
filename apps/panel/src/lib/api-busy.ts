/**
 * "The API is busy" as a first-class answer, distinct from "the panel broke".
 *
 * A 429 (rate limited) or 503 (a dependency is down) says nothing about the
 * operator's request or session: the same request will work in a few seconds.
 * The panel used to treat both like any other failure, so a 429 rendered the
 * generic "Something went wrong" boundary, a 429 on a secondary read rendered
 * an empty section that looked like real data, and a 429 on the token refresh
 * signed the operator out.
 *
 * This module is imported by the error boundaries, which are client
 * components, so it must stay free of server-only imports. `lib/api.ts` owns
 * the server half (turning a response into the error).
 *
 * ## Why the digest
 *
 * In a production build Next strips a Server Component error down to its
 * `digest` before it reaches the client boundary: no message, no status, no
 * custom fields. An error that already carries a `digest` keeps it
 * (`createErrorHandler` in `next/dist/server/app-render/create-error-handler.js`
 * respects an existing one), so the status and the Retry-After travel there.
 * `test/api-busy.test.ts` pins that behaviour against the installed Next.
 */

export const API_BUSY_DIGEST_PREFIX = 'PANEL_API_BUSY';

/** The statuses that mean "try again shortly", not "this failed". */
export function isApiBusyStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Never tell an operator to wait longer than this, whatever the header says. */
export const MAX_RETRY_AFTER_SECONDS = 120;
/** What to assume when neither the header nor the body says. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Seconds to wait, from a `Retry-After` header (delta-seconds or an HTTP date)
 * or the API envelope's `retryAfterSeconds`, clamped to [1, MAX].
 */
export function parseRetryAfter(
  header: string | null | undefined,
  bodySeconds?: unknown,
  now: number = Date.now(),
): number {
  let seconds: number | null = null;
  if (header) {
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      seconds = Number(trimmed);
    } else {
      const at = Date.parse(trimmed);
      if (!Number.isNaN(at)) seconds = Math.ceil((at - now) / 1000);
    }
  }
  if (seconds === null && typeof bodySeconds === 'number' && Number.isFinite(bodySeconds)) {
    seconds = Math.ceil(bodySeconds);
  }
  if (seconds === null) seconds = DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds));
}

export function busyDigest(status: number, retryAfterSeconds: number): string {
  return `${API_BUSY_DIGEST_PREFIX};${status};${retryAfterSeconds}`;
}

export interface ApiBusyInfo {
  status: number;
  retryAfterSeconds: number;
}

/** The busy details from an error boundary's `error.digest`, or null for any other error. */
export function parseBusyDigest(digest: string | undefined | null): ApiBusyInfo | null {
  if (!digest || !digest.startsWith(`${API_BUSY_DIGEST_PREFIX};`)) return null;
  const [, status, seconds] = digest.split(';');
  const s = Number(status);
  const r = Number(seconds);
  if (!isApiBusyStatus(s) || !Number.isFinite(r)) return null;
  return { status: s, retryAfterSeconds: Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(r))) };
}

/**
 * How long the error boundary waits before its next automatic retry, or null
 * when it should stop retrying on its own and leave it to the operator.
 *
 * Never sooner than the API asked (Retry-After is when the limiter's window
 * resets, so retrying then is exactly right, and retrying earlier is a
 * guaranteed second 429). When the API asks for very little, a floor that
 * doubles per attempt (2s, 4s, 8s) stops a limiter that keeps saying "1s"
 * from being polled once a second. Three automatic attempts, then a button.
 */
export const MAX_AUTO_RETRIES = 3;

export function autoRetryDelaySeconds(attempt: number, retryAfterSeconds: number): number | null {
  if (attempt >= MAX_AUTO_RETRIES) return null;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(retryAfterSeconds, 2 ** (attempt + 1)));
}

/**
 * The automatic-retry budget for one browser tab.
 *
 * A retry that fails again remounts the error boundary, so the count cannot
 * live in component state or every remount would start a fresh three. It lives
 * here, at module scope (one per tab), and resets after two quiet minutes or
 * when the operator presses "Retry now".
 */
export const RETRY_QUIET_RESET_MS = 2 * 60_000;

export interface RetryBudget {
  /** Seconds until the next automatic retry, or null when the budget is spent. */
  nextDelay(retryAfterSeconds: number): number | null;
  /** Call when an automatic retry actually fires. */
  recordAttempt(): void;
  /** The operator asked for a retry by hand: start counting again. */
  reset(): void;
}

export function createRetryBudget(now: () => number = Date.now): RetryBudget {
  let attempts = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  return {
    nextDelay(retryAfterSeconds) {
      if (now() - lastAttemptAt > RETRY_QUIET_RESET_MS) attempts = 0;
      return autoRetryDelaySeconds(attempts, retryAfterSeconds);
    },
    recordAttempt() {
      attempts += 1;
      lastAttemptAt = now();
    },
    reset() {
      attempts = 0;
    },
  };
}

/** The one budget the error boundaries in this tab share. */
export const tabRetryBudget = createRetryBudget();
