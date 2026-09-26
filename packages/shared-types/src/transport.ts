/**
 * Socket error codes that mean no connection was ever made: DNS found no
 * address (`ENOTFOUND`, `EAI_AGAIN`), the port refused it (`ECONNREFUSED`), or
 * the connect itself timed out (`UND_ERR_CONNECT_TIMEOUT`). No byte of the
 * request left this process.
 */
export const NEVER_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const MAX_CAUSE_DEPTH = 5;

/**
 * True when a failed request provably never reached the server, so a
 * single-use token it carried is still unspent.
 *
 * Pass what `fetch` threw (a `TypeError: fetch failed`), or the `cause` of a
 * `NETWORK_ERROR` from a Rekey SDK. Walks `cause` down to the socket error.
 * Node reports a refused `localhost` as an AggregateError over both address
 * families, so every one of those must be a never-connected error too.
 *
 * A request deadline (an `AbortSignal.timeout`) is NOT this: it cannot tell a
 * slow connect from a slow answer, so the request may have been processed.
 *
 * @example
 * ```ts
 * try {
 *   await fetch(url, init);
 * } catch (err) {
 *   if (neverConnected(err)) keepTheCookies();
 * }
 * ```
 */
export function neverConnected(cause: unknown, depth = 0): boolean {
  if (!cause || typeof cause !== 'object' || depth > MAX_CAUSE_DEPTH) return false;
  const c = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (Array.isArray(c.errors) && c.errors.length > 0) {
    return c.errors.every((e) => neverConnected(e, depth + 1));
  }
  if (typeof c.code === 'string') return NEVER_CONNECTED_CODES.has(c.code);
  return neverConnected(c.cause, depth + 1);
}
