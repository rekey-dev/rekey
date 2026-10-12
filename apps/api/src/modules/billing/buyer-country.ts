/**
 * Which country a buyer is in, and how far that answer can be believed.
 *
 * Provider routing reads this on every checkout. The source matters because a
 * secret-key call arrives from the operator's server: nothing about that
 * connection describes the buyer, so only what the operator declares counts.
 */

import type { FastifyRequest } from 'fastify';
import { RekeyError } from '../../lib/error.js';

/**
 * - `declared`: a secret-key caller said so. The operator knows its buyer.
 * - `vouched`: a trusted proxy or the portal forwarded the visitor's country.
 * - `hint`: a browser-side caller said so, an unverified CDN header did, or an
 *   SDK passed on the platform header it found on the operator's own request.
 */
export type BuyerCountrySource = 'declared' | 'vouched' | 'hint';

export interface BuyerCountry {
  country: string;
  source: BuyerCountrySource;
}

/**
 * What a route accepts as a country: two characters, so a caller can forward
 * its CDN's header as it is. Cloudflare sends `T1` for Tor and `XX` for
 * unknown, and refusing a checkout over those would turn a routing hint into
 * an outage. `resolveBuyerCountry` decides what is actually a country.
 */
export const COUNTRY_INPUT = /^[A-Za-z][A-Za-z0-9]$/;

const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
/**
 * Where a secret-key SDK client puts the country the operator's platform
 * reported for the visitor (`cf-ipcountry`, `x-vercel-ip-country`). Read from a
 * secret-key caller only, and only as a hint: a buyer who reaches the
 * operator's origin directly writes that platform header, so it chooses a local
 * price only when the Application sets `billingConfig.localPrices` to `any`.
 */
export const VISITOR_COUNTRY_HINT_HEADER = 'x-rekey-visitor-country-hint';

/** Cloudflare's codes for "unknown" and for Tor. */
const NOT_A_COUNTRY = new Set(['XX', 'T1']);

function countryCode(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !COUNTRY_PATTERN.test(raw)) return undefined;
  const upper = raw.toUpperCase();
  return NOT_A_COUNTRY.has(upper) ? undefined : upper;
}

/**
 * Resolve the buyer's country for a billing request.
 *
 * `declared` is the route's own `country` field (body or query). A secret-key
 * caller that declared none falls back to the SDK's
 * `x-rekey-visitor-country-hint`, as a hint.
 *
 * The `x-country` header is gone. A request that still sends it is refused
 * with `BILLING_FIELD_REMOVED`: an old client would otherwise be priced as if
 * it had named no country, and nobody would see why.
 *
 * @example
 * const buyer = resolveBuyerCountry(req, body.country);
 * await pickProvider({ application, ...(buyer && { country: buyer.country }) });
 */
export function resolveBuyerCountry(req: FastifyRequest, declared?: string): BuyerCountry | null {
  if (req.headers['x-country'] !== undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_FIELD_REMOVED',
      message: 'The `x-country` header is no longer read.',
      fix: 'Send the buyer\'s country as `country` in the request body (POST) or as `?country=` (GET), and remove the `x-country` header. @rekey.dev/node and @rekey.dev/react from 2.2.0-rc.7 do this already.',
    });
  }
  const said = countryCode(declared);
  if (req.authKind === 'secret') {
    if (said) return { country: said, source: 'declared' };
    const forwarded = countryCode(req.headers[VISITOR_COUNTRY_HINT_HEADER]);
    return forwarded ? { country: forwarded, source: 'hint' } : null;
  }
  if (req.visitorCountry) return { country: req.visitorCountry, source: 'vouched' };
  // Our own portal's connection carries the portal host's country, never the
  // visitor's, so its CDN headers say nothing about the buyer.
  const cdn = req.internalCaller
    ? undefined
    : (countryCode(req.headers['cf-ipcountry']) ?? countryCode(req.headers['x-vercel-ip-country']));
  // The CDN's header before the caller's own word: a browser cannot set the
  // first when the API sits behind that CDN, and can always set the second.
  const country = cdn ?? said;
  return country ? { country, source: 'hint' } : null;
}
