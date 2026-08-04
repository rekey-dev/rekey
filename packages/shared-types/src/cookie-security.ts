/**
 * Whether a session cookie written on this request must carry `Secure`.
 *
 * Every cookie in this monorepo used to decide that with
 * `process.env.NODE_ENV === 'production'`. That is a BUILD-time answer to a
 * REQUEST-time question, and it fails in the direction that costs you the
 * session: a deployment behind TLS whose `NODE_ENV` is unset, or set to
 * `staging`, or set to anything the Next build did not inline as
 * `"production"`, emits its operator and end-user session cookies without
 * `Secure` — so a browser will happily replay them over plain HTTP to any
 * attacker who can force one downgraded request. Nothing about that is visible
 * in the UI; the deployment looks entirely healthy.
 *
 * So key off what the request actually was:
 *
 *   1. An explicit `REKEY_COOKIE_SECURE` wins outright. This is the ONLY way to
 *      end up with an insecure session cookie on a non-loopback host — an
 *      operator terminating TLS somewhere this code cannot observe has to say
 *      so, rather than falling into it by forgetting an env var.
 *   2. `X-Forwarded-Proto` (first hop) decides when a proxy set it. The API
 *      already has `TRUSTED_PROXIES` for exactly this class of header; the web
 *      apps sit behind the same proxy and read the same hop.
 *   3. With no forwarded proto, fall back on the host: loopback is a developer
 *      on `http://localhost`, anything else is treated as internet-facing and
 *      gets `Secure`.
 *
 * Rule 3 is deliberately fail-secure. Getting it wrong on a loopback host would
 * break `pnpm dev` for everyone, so loopback is enumerated rather than guessed;
 * getting it wrong on a real host merely means the cookie is refused over plain
 * HTTP, which is a loud, immediate, one-env-var-to-fix failure — as opposed to
 * a silent cleartext session credential, which is the failure we are here to
 * remove. A wrong guess should cost a login, not a session.
 *
 * Pure and dependency-free: callers pass the two header values they read. That
 * keeps this testable without a request, and usable from Edge middleware,
 * Node route handlers and server actions alike.
 */

/** Hosts a browser already treats as a secure context over plain HTTP. */
function isLoopbackHost(host: string): boolean {
  // Strip the port. IPv6 literals arrive bracketed (`[::1]:3000`).
  const bare = host.startsWith('[')
    ? (host.slice(1, host.indexOf(']')) ?? '')
    : (host.split(':')[0] ?? '');
  const h = bare.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    // `*.localhost` is reserved (RFC 6761) and resolves to loopback; Next
    // multi-tenant dev setups use it.
    h.endsWith('.localhost')
  );
}

export interface CookieSecurityInput {
  /** `X-Forwarded-Proto`, verbatim. May be a comma-separated hop list. */
  forwardedProto?: string | null | undefined;
  /** `X-Forwarded-Host`, else `Host`, verbatim. May include a port. */
  host?: string | null | undefined;
  /** `REKEY_COOKIE_SECURE`, verbatim. `"true"` / `"false"`; anything else is ignored. */
  override?: string | null | undefined;
}

/**
 * Decide the `Secure` attribute for a cookie written on this request.
 *
 * @returns `true` when the cookie must be marked `Secure`.
 */
export function cookieSecureFor(input: CookieSecurityInput): boolean {
  const override = (input.override ?? '').trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;

  // First hop is the client→edge protocol; later entries are proxy-to-proxy and
  // say nothing about what the browser used.
  const proto = (input.forwardedProto ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  if (proto === 'https') return true;
  if (proto === 'http') {
    // A proxy explicitly reporting plain HTTP. Trust it only to the extent of
    // letting loopback development through; a real host on plain HTTP still
    // gets `Secure`, because "my proxy speaks HTTP to the world" is a
    // deployment mistake we should surface rather than quietly accommodate.
    return !isLoopbackHost(input.host ?? '');
  }

  // No forwarded proto at all: direct connection, or a proxy that does not set
  // the header. Host is all we have.
  return !isLoopbackHost(input.host ?? '');
}
