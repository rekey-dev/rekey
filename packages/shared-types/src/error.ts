/**
 * `@rekey.dev/shared-types/error` — the canonical SDK error, and NOTHING else.
 *
 * ── Why this is its own module ──
 *
 * `RekeyError` is the one **value** the browser SDK needs from shared-types;
 * everything else it imports is a type, erased at compile time. But the barrel
 * (`./index.js`) evaluates ~60 `z.object(...)` calls at module scope, so a
 * bundler that pulls `RekeyError` in from there has to keep zod and every
 * schema expression alive. Measured: importing `useUser` alone from
 * `@rekey.dev/react` shipped 74,556 bytes minified, ~80% of it zod.
 *
 * `"sideEffects": false` does NOT fix that (measured: 0 bytes changed). It lets
 * a bundler drop an *unused module*; it does not let it drop individual call
 * expressions inside a module it is already keeping for one live export.
 *
 * So the error class lives here, with zero imports, and the SDKs import it from
 * `@rekey.dev/shared-types/error`. `./index.js` re-exports it, so the class
 * identity is one and the same and `instanceof RekeyError` holds across every
 * package and both import paths.
 */

/**
 * The error envelope shape (just the data fields) every Rekey API response uses
 * on failure. `index.js` exports `RekeyErrorSchema`, the zod schema this
 * interface mirrors — the two are asserted structurally identical at compile
 * time over there.
 *
 * @example
 * ```ts
 * { code: 'PLAN_NOT_FOUND', message: 'Plan "pro" not found.', fix: 'Run `rekey plans list`.' }
 * ```
 */
export interface RekeyErrorShape {
  code: string;
  message: string;
  /** Concrete remediation a human or AI agent can act on. */
  fix?: string | undefined;
  /** Documentation URL for this error code. */
  docs?: string | undefined;
  /**
   * How long to wait before retrying, in seconds. Sent by the API on
   * `RATE_LIMITED` (and mirrored in the `Retry-After` header) and on the
   * idempotency in-flight conflict. Absent on errors that retrying will not fix.
   */
  retryAfterSeconds?: number | undefined;
}

/**
 * The canonical SDK error. Both @rekey.dev/node and @rekey.dev/react re-export
 * this class, so `instanceof RekeyError` is consistent across packages.
 * Always carries a stable `code` and, when the server provided one, a concrete
 * `fix` — read `error.fix` first when debugging.
 *
 * Transport failures are RekeyErrors too: a connection refused / DNS failure
 * arrives as `NETWORK_ERROR`, a client-side deadline as `REQUEST_TIMEOUT`, and
 * a caller-initiated `AbortSignal` as `REQUEST_ABORTED`. So the documented
 * `catch (e) { if (e instanceof RekeyError) … }` pattern covers every failure
 * mode of an SDK call, not just the ones the server got far enough to name.
 */
export class RekeyError extends Error implements RekeyErrorShape {
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly docs: string | undefined;
  /** HTTP status, when the error came from an API response. */
  public readonly statusCode: number | undefined;
  /** Server-assigned request id — share with support to find the log entry. */
  public readonly requestId: string | undefined;
  /** Seconds to wait before retrying, when the server said so (see the shape docs). */
  public readonly retryAfterSeconds: number | undefined;

  constructor(
    error: RekeyErrorShape & {
      statusCode?: number | undefined;
      requestId?: string | undefined;
      /** Underlying transport error, for `NETWORK_ERROR` / `REQUEST_TIMEOUT`. */
      cause?: unknown;
    },
  ) {
    super(error.message, ...(error.cause !== undefined ? [{ cause: error.cause }] : []));
    this.name = 'RekeyError';
    this.code = error.code;
    this.fix = error.fix;
    this.docs = error.docs;
    this.statusCode = error.statusCode;
    this.requestId = error.requestId;
    this.retryAfterSeconds = error.retryAfterSeconds;
  }
}
