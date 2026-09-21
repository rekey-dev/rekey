/**
 * Reading a failed sign-in, for the three refusals a device-bound or
 * loaded deployment actually produces.
 *
 * ── Why this module exists ──
 *
 * `RekeyError` already carries everything needed: `code`, `details` (the
 * devices filling the cap, on `DEVICE_LIMIT_REACHED`) and `retryAfterSeconds`
 * (on the 503 / 429 codes). Nothing in the framework SDKs read either field,
 * so the documented "offer the user a device to release" path and the
 * documented "honour Retry-After" path both existed on the wire and nowhere
 * else, and every app that caught a sign-in failure fell back to the one
 * sentence everybody writes: "Email or password is incorrect."
 *
 * That sentence is the failure mode this module exists to prevent. A
 * `PASSWORD_VERIFY_BUSY` is the server declining to check the password at
 * all: it counted nothing toward lockout, and the credentials may well be
 * right. Telling the user they mistyped it is both false and unactionable,
 * and it sends them to the password-reset flow to fix a problem that is not
 * theirs.
 *
 * ── Why this is duck-typed rather than `instanceof` ──
 *
 * Two reasons, and neither is style. A server action may hand the failure to a
 * client component, which means it can arrive as a plain object that survived
 * serialization and has no prototype left. And two installed copies of
 * `@rekey.dev/shared-types` give two classes, so `instanceof` answers false for
 * an error that is a `RekeyError` in every way that matters. A `code` string is
 * the contract the API actually promises; this reads that.
 */

/**
 * One device the user could release to get under the cap, as
 * `DEVICE_LIMIT_REACHED` reports it. Every field beyond `id` is nullable
 * because it is read back out of an untyped `details` bag: a device the user
 * never labelled has no label, and a future API version that stops sending a
 * timestamp must not crash a sign-in page.
 */
export interface DeviceChoice {
  id: string;
  label: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/**
 * What went wrong, in the terms a sign-in page has to render. `code` is carried
 * on every arm so a caller can log or branch on the exact API code without
 * unwrapping the original error.
 */
export type SignInFailure =
  /** The one code that means the password was checked and was wrong. */
  | { kind: 'invalid_credentials'; code: string }
  /** `deviceBinding: 'required'` and the call carried no `device`. */
  | { kind: 'device_required'; code: string }
  /**
   * The account is at its `max_devices` entitlement. `devices` are the ACTIVE
   * devices filling the cap. Render them and let the user pick one to release.
   * No token was issued, so releasing needs your backend or an operator (or a
   * session signed in without `device`, where the policy allows it).
   */
  | { kind: 'device_limit'; code: string; limit: number | null; devices: DeviceChoice[] }
  /** An operator blocked this fingerprint. Only an operator can lift it. */
  | { kind: 'device_blocked'; code: string }
  /**
   * The request was not a verdict on the credentials: the server was busy, or
   * it is throttling. **Never show this as a wrong password.** Wait
   * `retryAfterSeconds` (null when the server sent none) and try again.
   */
  | { kind: 'retry_later'; code: string; retryAfterSeconds: number | null }
  /** A Rekey error this helper has no opinion about. Read `code`. */
  | { kind: 'other'; code: string };

/** The fields this module reads off a thrown value. */
interface ErrorLike {
  code: string;
  retryAfterSeconds?: unknown;
  details?: unknown;
}

function isErrorLike(err: unknown): err is ErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

/**
 * Codes where retrying the same request later is the correct response, as
 * opposed to changing something. Matched literally rather than by status,
 * because the caller sees a code and not a status.
 *
 * `TOO_MANY_FAILED_ATTEMPTS` is here deliberately even though it follows real
 * wrong passwords: by the time it is returned the API is refusing to check the
 * credentials at all, so "your password is wrong" is no longer what happened,
 * and the user needs to be told to wait rather than to try harder.
 */
const RETRYABLE = new Set([
  'PASSWORD_VERIFY_BUSY',
  'DEPENDENCY_UNAVAILABLE',
  'RATE_LIMITED',
  'TOO_MANY_FAILED_ATTEMPTS',
  'MFA_TOO_MANY_ATTEMPTS',
]);

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Read `details.devices` defensively: an untyped bag from another process. */
function readDevices(details: unknown): DeviceChoice[] {
  if (typeof details !== 'object' || details === null) return [];
  const raw = (details as { devices?: unknown }).devices;
  if (!Array.isArray(raw)) return [];
  const out: DeviceChoice[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const id = str(row['id']);
    // A row with no id cannot be released, so it is not a choice to offer.
    if (id === null) continue;
    out.push({
      id,
      label: str(row['label']),
      firstSeenAt: str(row['firstSeenAt']),
      lastSeenAt: str(row['lastSeenAt']),
    });
  }
  return out;
}

/**
 * Classify a thrown sign-in failure.
 *
 * Returns `null` when the value is not a Rekey error at all: a bug in your
 * own action, a `TypeError`, anything with no `code`. **Rethrow on null.**
 * Swallowing it is how a real crash becomes a login form that silently does
 * nothing.
 *
 * Works on `signIn`, `signUp` and `mfaVerify` alike; the device refusals are
 * raised by all three.
 *
 * @example
 * ```ts
 * try {
 *   await signIn({ email, password, device: { fingerprint } });
 * } catch (err) {
 *   const failure = classifySignInError(err);
 *   if (!failure) throw err;
 *   switch (failure.kind) {
 *     case 'invalid_credentials': return { error: 'Email or password is incorrect.' };
 *     case 'device_limit':        return { devices: failure.devices, limit: failure.limit };
 *     case 'retry_later':         return { error: `Busy. Try again in ${failure.retryAfterSeconds ?? 5}s.` };
 *     default:                    return { error: failure.code };
 *   }
 * }
 * ```
 */
export function classifySignInError(err: unknown): SignInFailure | null {
  if (!isErrorLike(err)) return null;
  const code = err.code;

  if (code === 'INVALID_CREDENTIALS') return { kind: 'invalid_credentials', code };
  if (code === 'DEVICE_FINGERPRINT_REQUIRED') return { kind: 'device_required', code };
  if (code === 'DEVICE_BLOCKED') return { kind: 'device_blocked', code };
  if (code === 'DEVICE_LIMIT_REACHED') {
    const details = err.details;
    const limit =
      typeof details === 'object' && details !== null
        ? num((details as { limit?: unknown }).limit)
        : null;
    return { kind: 'device_limit', code, limit, devices: readDevices(details) };
  }
  if (RETRYABLE.has(code)) {
    return { kind: 'retry_later', code, retryAfterSeconds: num(err.retryAfterSeconds) };
  }
  return { kind: 'other', code };
}
