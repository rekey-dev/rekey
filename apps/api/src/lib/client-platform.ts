import type { FastifyRequest } from 'fastify';
import { describeClientUserAgent, type ClientHint, type ClientPlatform } from '@rekey.dev/shared-types';

/**
 * The visitor's User-Agent, sent by a customer backend that signs users in
 * server-side (a Next server action, an Astro endpoint). Without it every such
 * session would record the backend's own `node` User-Agent.
 */
export const CLIENT_USER_AGENT_HEADER = 'x-rekey-client-user-agent';

const MAX_USER_AGENT = 512;

/** What a session records about the client that started it. */
export interface ClientContext {
  /** The User-Agent the session is attributed to: the forwarded one for a secret key that sent it, else the request's. */
  userAgent: string | null;
  platform: ClientPlatform;
  os: string | null;
  browser: string | null;
  appVersion: string | null;
  /** ISO 3166 alpha-2, from `CF-IPCountry` only, and never for a secret-key call. */
  country: string | null;
}

function header(req: FastifyRequest, name: string): string | null {
  const value = req.headers[name];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_USER_AGENT);
}

/**
 * The User-Agent to attribute a session to. `X-Rekey-Client-User-Agent` is
 * believed from a secret-key caller, the same trust `X-Rekey-Client-Ip` gets
 * (that caller already controls every request its Application sees, so naming
 * the visitor gives it nothing new), and from our own portal or panel proven
 * by INTERNAL_CALLER_SECRET, whose own User-Agent is `node`. Anyone else is
 * the visitor, so their own User-Agent is the answer and the header is ignored.
 */
function attributedUserAgent(req: FastifyRequest): string | null {
  if (req.authKind === 'secret' || req.internalCaller) {
    return header(req, CLIENT_USER_AGENT_HEADER) ?? header(req, 'user-agent');
  }
  return header(req, 'user-agent');
}

/**
 * The country the client-address resolver believed (`req.visitorCountry`:
 * TRUST_CF_IPCOUNTRY on, and a proven proxy or internal caller). Never for a
 * secret-key call: there the connection, and so the country, is the
 * customer's server, not the visitor.
 */
function attributedCountry(req: FastifyRequest): string | null {
  return req.authKind === 'secret' ? null : req.visitorCountry;
}

/**
 * Everything a new session records about its client: the attributed
 * User-Agent read into platform, OS and browser, the body's `client` hint
 * (which wins on platform, since a native app's User-Agent rarely says what it
 * is), and the country.
 *
 * @example
 *   const client = requestClient(req, body.client);
 *   // { userAgent: 'Mozilla/5.0 ...', platform: 'web', os: 'macOS', browser: 'Chrome', appVersion: null, country: 'DE' }
 */
export function requestClient(req: FastifyRequest, hint?: ClientHint): ClientContext {
  const userAgent = attributedUserAgent(req);
  const described = describeClientUserAgent(userAgent);
  return {
    userAgent,
    platform: hint?.platform ?? described.platform,
    os: described.os,
    browser: described.browser,
    appVersion: hint?.appVersion ?? null,
    country: attributedCountry(req),
  };
}
