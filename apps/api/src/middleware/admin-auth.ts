/**
 * Bootstrap admin auth.
 *
 * Routes under `/api/v1/admin/*` require the `SUPER_ADMIN_KEY` env value
 * presented as a Bearer token. This is the credential Rekey operators use
 * to bootstrap the first Tenant + Application (and to manage them via CLI
 * before the panel ships).
 *
 * It is *not* the credential a customer's application uses — those are
 * Application-scoped API keys minted via this admin surface.
 *
 * Comparison is constant-time to avoid token-leak via timing side channel.
 *
 * An optional network gate sits in front of the key check: when
 * ADMIN_IP_ALLOWLIST is set, a request from outside it is refused without the
 * key being examined at all. SUPER_ADMIN_KEY is one shared secret covering the
 * entire deployment — every tenant, every application — so a leak is total.
 * Pinning the admin surface to known addresses means a leaked key is not by
 * itself sufficient. It is defence in depth, not a substitute for the key.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { RekeyError } from '../lib/error.js';
import { ipMatchesAllowlist } from '../lib/ip-allowlist.js';

/**
 * Read live from `process.env` rather than captured at module load, matching
 * `operator-signup-policy`. Capturing it made the gate untestable in-process
 * (the module is imported before a test can set the variable) — and the first
 * version of this file did exactly that, which produced a test that passed
 * while the gate never fired. Parsing is a split of a short string; the boot
 * value in `env` is still what validation runs against, so a typo cannot be
 * introduced at runtime without having already failed the boot.
 */
function adminIpAllowlist(): readonly string[] {
  return (process.env.ADMIN_IP_ALLOWLIST ?? env.ADMIN_IP_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Boot-time validation. Called from app construction so a typo fails the
 * deployment loudly instead of quietly producing a gate that matches nothing.
 * (`ipMatchesAllowlist` treats an unparseable entry as a non-match, which is
 * the safe behaviour at request time but would be a silent misconfiguration
 * here — an operator who fat-fingers their only CIDR would lock themselves out
 * with no explanation, or worse, believe they are protected when the list is
 * empty because every entry was dropped.)
 */
export function assertAdminIpAllowlistValid(): void {
  const list = adminIpAllowlist();
  if (list.length === 0) return;
  // A well-formed entry matches itself; an unparseable one matches nothing.
  const invalid = list.filter((entry) => {
    const bare = entry.split('/')[0] ?? '';
    return !ipMatchesAllowlist(bare, [entry]);
  });
  if (invalid.length > 0) {
    throw new Error(
      `[CONFIG] ADMIN_IP_ALLOWLIST contains entries that are not a valid IP or CIDR: ` +
        `${invalid.join(', ')}. Use a comma-separated list like ` +
        `"203.0.113.4, 10.0.0.0/8, 2001:db8::/32", or leave it unset to disable the gate.`,
    );
  }
}

export async function requireSuperAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  // Network gate first: refuse before the key is read, so a caller outside the
  // allowlist learns nothing about whether their key was right. `request.ip`
  // honours Fastify's trustProxy, itself derived from TRUSTED_PROXIES — behind
  // Cloudflare -> Traefik that resolves to the real client, not the proxy.
  const allowlist = adminIpAllowlist();
  if (allowlist.length > 0 && !ipMatchesAllowlist(request.ip, allowlist)) {
    throw new RekeyError({
      statusCode: 403,
      code: 'ADMIN_IP_NOT_ALLOWED',
      message: 'Admin endpoints are not available from this address.',
      fix:
        'This deployment restricts /api/v1/admin/* to ADMIN_IP_ALLOWLIST. Call from an ' +
        'allowed address, or add yours to that list and restart the API.',
    });
  }

  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!presented) {
    throw new RekeyError({
      statusCode: 401,
      code: 'ADMIN_AUTH_MISSING',
      message: 'Admin endpoints require an Authorization: Bearer <SUPER_ADMIN_KEY> header.',
      fix: 'Set SUPER_ADMIN_KEY in your .env, then send `Authorization: Bearer <that value>`.',
    });
  }

  const expected = Buffer.from(env.SUPER_ADMIN_KEY, 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  // Length pre-check is safe — leaking that the wrong-length key was wrong is
  // not material (an attacker already knows their guess length).
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new RekeyError({
      statusCode: 401,
      code: 'ADMIN_AUTH_INVALID',
      message: 'The presented admin key does not match SUPER_ADMIN_KEY.',
      fix: 'Verify the value of SUPER_ADMIN_KEY in your .env matches the one you are sending.',
    });
  }
}
