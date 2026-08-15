/**
 * The caller's IP, taken from the end of `X-Forwarded-For` rather than the
 * front.
 *
 * This read `xff.split(',')[0]`, which is the LEFTMOST entry, and that is the
 * one value in the header a client controls. Proxies APPEND, so for a request
 * that arrived as
 *
 *   X-Forwarded-For: 203.0.113.9
 *
 * with the attacker having sent that header themselves, our edge appends the
 * real address and the API receives
 *
 *   X-Forwarded-For: 203.0.113.9, <real client>
 *
 * Taking `[0]` hands back `203.0.113.9`, whatever the attacker typed. That is
 * then forwarded to the API as an `x-forwarded-for` we assert, one layer above
 * the API's own `TRUSTED_PROXIES` handling, so it lands in audit-log entries,
 * decides rate-limit buckets (rotate the value, get a fresh budget), and is
 * checked against `ADMIN_IP_ALLOWLIST`.
 *
 * The rightmost entry is the one our own edge wrote and is the only one not
 * forgeable from outside. It is what we forward.
 *
 * `X-Real-IP` stays as the fallback: it is a single value set by the proxy,
 * with no list for a client to prepend to.
 */
export function clientIpFrom(headerValue: string | null, realIp?: string | null): string | null {
  const parts = (headerValue ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const rightmost = parts.length > 0 ? parts[parts.length - 1]! : '';
  const ip = rightmost || (realIp ?? '').trim();
  return ip || null;
}
