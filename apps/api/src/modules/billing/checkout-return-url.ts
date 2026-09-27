/**
 * Where a checkout may send the buyer once they have paid or given up.
 *
 * An unchecked return URL makes the processor's payment page an open redirect.
 * The allowlist is the one emailed token links use (`registeredOrigins`: App
 * URL plus redirect URLs, by origin) plus the hosted portal's origins for this
 * Application, which Rekey chose rather than the caller.
 *
 * Warn mode for now: an unregistered origin still works and comes back as a
 * `CHECKOUT_RETURN_URL_UNREGISTERED` warning. The next minor release refuses
 * it (hosted checkout spec, #641 §9.4). A non-http(s) scheme is never a
 * real return page, so that is refused already.
 */

import type { Application } from '@prisma/client';
import type { CheckoutReturnUrlWarning } from '@rekey.dev/shared-types';
import { registeredOrigins } from '../../lib/app-url.js';
import { portalOriginsForApp } from '../../lib/portal-origins.js';
import { RekeyError } from '../../lib/error.js';

type ReturnUrlField = CheckoutReturnUrlWarning['field'];

type AppForReturnUrls = Pick<
  Application,
  'authConfig' | 'hostedPortalEnabled' | 'portalDomain' | 'portalDomainVerifiedAt'
>;

/**
 * Parse a return URL and refuse any scheme but http(s).
 *
 * The check runs on the PARSED url, so whitespace, case and encoding tricks
 * (`JaVaScRiPt:`, a leading tab) are judged after the URL parser has
 * normalised them, the same form a browser would act on.
 */
function parseReturnUrl(value: string, field: ReturnUrlField): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RekeyError({
      statusCode: 400,
      code: 'CHECKOUT_RETURN_URL_INVALID',
      message: `\`${field}\` is not a valid absolute URL.`,
      fix: 'Pass an absolute https URL on an origin this Application has registered.',
    });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new RekeyError({
      statusCode: 400,
      code: 'CHECKOUT_RETURN_URL_INVALID',
      message: `\`${field}\` must be an http(s) URL, not ${parsed.protocol}.`,
      fix: 'Pass an absolute https URL on an origin this Application has registered.',
    });
  }
  return parsed;
}

/**
 * Validate a checkout's return URLs. Throws `CHECKOUT_RETURN_URL_INVALID` for
 * a non-http(s) URL; returns one warning per URL on an unregistered origin.
 *
 * @example
 * const warnings = checkReturnUrls(app, {
 *   successUrl: 'https://app.acme.com/billing?ok=1',
 *   cancelUrl: 'https://elsewhere.example/',
 * });
 * // [{ code: 'CHECKOUT_RETURN_URL_UNREGISTERED', field: 'cancelUrl', origin: 'https://elsewhere.example', … }]
 */
export function checkReturnUrls(
  app: AppForReturnUrls,
  urls: Record<ReturnUrlField, string>,
): CheckoutReturnUrlWarning[] {
  const parsed = {
    successUrl: parseReturnUrl(urls.successUrl, 'successUrl'),
    cancelUrl: parseReturnUrl(urls.cancelUrl, 'cancelUrl'),
  };

  const registered = registeredOrigins(app);
  const allowed = new Set([...registered, ...portalOriginsForApp(app)]);
  const noneRegistered = registered.size === 0;

  const warnings: CheckoutReturnUrlWarning[] = [];
  for (const field of ['successUrl', 'cancelUrl'] as const) {
    const origin = parsed[field].origin;
    if (allowed.has(origin)) continue;
    warnings.push({
      code: 'CHECKOUT_RETURN_URL_UNREGISTERED',
      field,
      origin,
      message: noneRegistered
        ? `This Application has no registered origin, so every return URL is unregistered, ` +
          `including \`${field}\` on ${origin}. The buyer is still sent there for now; the next ` +
          'minor release refuses this checkout.'
        : `\`${field}\` points at ${origin}, which this Application has not registered. The ` +
          'buyer is still sent there for now; the next minor release refuses this checkout.',
      fix: noneRegistered
        ? "Set the Application URL (Panel → Application → Auth → Application URL) to your app's " +
          'origin, or add the origin to its redirect URLs.'
        : `Add ${origin} to the Application's redirect URLs (Panel → Application → Auth), or set ` +
          'it as the Application URL.',
    });
  }
  return warnings;
}
