/**
 * Keeps credentials that legitimately travel in a URL (an invitation token on
 * `/tenant/invitations/preview?token=`, an OAuth `code`) out of the access log.
 * Fastify's default request serializer logs `req.url` verbatim, so anyone who
 * can read the logs could redeem a live invitation.
 */

import type { FastifyRequest } from 'fastify';

/** Replaces a secret query value. */
export const REDACTED = '[REDACTED]';

const CHECKOUT_TOKEN_IN_PATH = /chk_(test|live)_[A-Za-z0-9_-]+/g;

/** Names that are a credential only when they are the whole parameter name. */
const SECRET_PARAM_NAMES: ReadonlySet<string> = new Set(['code', 'key', 'invite']);

/**
 * Endings that mark a credential whatever comes before them, so
 * `mfaChallengeToken`, `api_key` and `client_secret` are caught without being
 * listed, while `countryCode` and `keyId` are not.
 */
const SECRET_PARAM_SUFFIXES = [
  'token',
  'secret',
  'api_key',
  'apikey',
  'password',
  'signature',
  'ticket',
  'challenge',
] as const;

function isSecretParam(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    // Malformed escapes: match on the raw name instead.
  }
  const lower = name.toLowerCase();
  return SECRET_PARAM_NAMES.has(lower) || SECRET_PARAM_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * The URL with every secret-looking query value replaced by `[REDACTED]`.
 * Path and non-secret parameters are left exactly as sent, so logs stay useful.
 *
 * @example
 * redactUrlSecrets('/api/v1/tenant/invitations/preview?token=abc&limit=5');
 * // => '/api/v1/tenant/invitations/preview?token=[REDACTED]&limit=5'
 */
export function redactUrlSecrets(rawUrl: string): string {
  // Checkout page tokens travel in the PATH, so the query-only rule below
  // would log them whole. The mode prefix is kept because it is not secret.
  const url = rawUrl.replace(CHECKOUT_TOKEN_IN_PATH, `chk_$1_${REDACTED}`);
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const pairs = url
    .slice(queryStart + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      return isSecretParam(name) ? `${name}=${REDACTED}` : pair;
    });
  return `${url.slice(0, queryStart)}?${pairs.join('&')}`;
}

/**
 * Fastify's default `req` serializer with the URL passed through
 * `redactUrlSecrets`. Same fields, so log consumers see no shape change.
 */
export function serializeRequest(req: FastifyRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: redactUrlSecrets(req.url),
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Pino options for the API's own logger. Exported so a test can build the app
 * with this exact config and a capturing stream.
 *
 * @example
 * Fastify({ logger: apiLoggerOptions('info') });
 */
export function apiLoggerOptions(level: string): Record<string, unknown> {
  return {
    level,
    redact: {
      paths: [
        'headers.authorization',
        'req.headers.authorization',
        'body.rawKey',
        'body.password',
        '*.rawKey',
      ],
      censor: REDACTED,
    },
    serializers: { req: serializeRequest },
  };
}
