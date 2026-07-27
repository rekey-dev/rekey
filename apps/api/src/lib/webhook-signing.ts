/**
 * HMAC-SHA256 signing for outbound webhooks. Consumers verify with the
 * shared secret stored on `WebhookEndpoint.secret`.
 *
 * Header format mirrors Stripe / GitHub / Resend:
 *
 *   X-Rekey-Signature: t=<unix-ts>,v1=<hex>
 *
 * The signature input is `${t}.${rawBody}` so a replayed-with-different-
 * timestamp delivery doesn't verify. Consumers should reject deliveries
 * older than ~5 minutes by checking `t`, in addition to verifying `v1`.
 *
 * NEVER skip the constant-time comparison on the consumer side.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * SSRF guard for customer-supplied webhook URLs.
 *
 * Reject:
 *   - non-HTTP(S) schemes (file://, gopher://, …)
 *   - hostnames that resolve to private/loopback/link-local/CGNAT IPs
 *   - bare IPs in private ranges (we don't deep-resolve here — DNS rebind
 *     is mitigated by the fact that we connect-then-validate via the
 *     receiver's response; but a stricter outbound proxy is a future
 *     hardening)
 *
 * We intentionally allow public-DNS hostnames without resolving — at
 * delivery time `fetch` follows DNS, and if a malicious domain returns
 * a private IP the worst case is a one-shot SSRF that hits a localhost
 * service. The mitigation for that lives in the deployment (egress proxy
 * with IP allowlist); we provide the URL-level filter as defense-in-depth.
 *
 * **Self-hosters running Rekey alongside their own internal services
 * must use an egress proxy or run Rekey in an isolated network.** The
 * URL-level filter only catches the obvious cases.
 */
const PRIVATE_IPV4_RE =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.|22[4-9]\.|2[3-5]\d\.)/;

export interface WebhookUrlSafetyOptions {
  /**
   * Opt-in escape hatch for operators on private networks who legitimately
   * want webhooks to hit internal services. Set
   * `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` to skip the private-IP filter.
   * Tests pass `true` here so the in-process HTTP listener works.
   */
  allowPrivate?: boolean;
}

export function isWebhookUrlSafe(
  url: string,
  options: WebhookUrlSafetyOptions = {},
): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'URL is not parseable.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `Scheme "${parsed.protocol}" is not allowed; use http(s).` };
  }
  if (options.allowPrivate) return { ok: true };
  // WHATWG URL preserves the surrounding brackets on IPv6 hostnames; strip
  // them so the `isIP` + range checks see the bare address.
  const rawHost = parsed.hostname.toLowerCase();
  const host =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return { ok: false, reason: 'Loopback hostnames are not allowed.' };
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    if (PRIVATE_IPV4_RE.test(host + '.')) {
      return { ok: false, reason: 'Private / loopback / link-local IPv4 addresses are not allowed.' };
    }
  } else if (ipVersion === 6) {
    // Block ::1 and unique-local fc00::/7 + link-local fe80::/10.
    if (
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    ) {
      return {
        ok: false,
        reason: 'Private / loopback / link-local IPv6 addresses are not allowed.',
      };
    }
  }
  return { ok: true };
}

const SIGNATURE_VERSION = 'v1';

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface SignaturePayload {
  /** Raw serialised JSON the receiver will hash. */
  body: string;
  secret: string;
  /** Override for tests; default Date.now()/1000. */
  timestamp?: number;
}

export function signWebhook(input: SignaturePayload): {
  signatureHeader: string;
  timestamp: number;
} {
  const t = input.timestamp ?? Math.floor(Date.now() / 1000);
  const signed = `${t}.${input.body}`;
  const sig = createHmac('sha256', input.secret).update(signed).digest('hex');
  return {
    signatureHeader: `t=${t},${SIGNATURE_VERSION}=${sig}`,
    timestamp: t,
  };
}

/**
 * Verify a signature header. Returns true iff the timestamp + secret +
 * body combine to the same signature, AND the timestamp is within
 * `toleranceSeconds` of now (default 5 minutes). Constant-time on the
 * hash comparison.
 *
 * Not used by Rekey's own infrastructure — provided for tests and as
 * the canonical implementation customers can crib from.
 */
export function verifyWebhookSignature(args: {
  body: string;
  secret: string;
  header: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const tolerance = args.toleranceSeconds ?? 300;
  const now = args.now ?? Math.floor(Date.now() / 1000);

  // Parse `t=...,v1=...`
  const parts = args.header.split(',').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    return acc;
  }, {});
  const t = Number.parseInt(parts['t'] ?? '', 10);
  const presented = parts[SIGNATURE_VERSION] ?? '';
  if (!Number.isFinite(t) || !presented) return false;
  if (Math.abs(now - t) > tolerance) return false;

  const expected = createHmac('sha256', args.secret)
    .update(`${t}.${args.body}`)
    .digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
