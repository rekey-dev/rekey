/**
 * What the two plan write routes (tenant and super-admin) share about a
 * request body: the shape of `price`, and the refusal of the fields the money
 * model removed.
 */

import { z } from 'zod';
import { RekeyError } from '../../lib/error.js';
import { MONEY_MAX, positiveMoneyAmount } from '../../lib/bounded-int.js';

/**
 * A plan's default price as a request states it. Closed, so a typo inside it
 * is refused instead of being dropped.
 *
 * @example
 * PlanPriceBody.parse({ currency: 'USD', amount: 1900 });
 */
export const PlanPriceBody = z.object({ currency: z.string().length(3), amount: positiveMoneyAmount() }).strict();

/** The JSON schema of {@link PlanPriceBody}, for a route's OpenAPI body. */
export const PLAN_PRICE_JSON_SCHEMA = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: {
    currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217, such as USD.' },
    amount: {
      type: 'integer',
      minimum: 1,
      maximum: MONEY_MAX,
      description: 'Integer, in the minor unit of `currency` (cents for USD, whole yen for JPY).',
    },
  },
} as const;

const PRICE_ON_CREATE =
  'Send the default price as `price`: { "currency": "USD", "amount": 1900 }, with `amount` in the minor unit of the currency. Leave `price` out for a free plan.';
const PRICE_ON_UPDATE =
  'Send the default price as `price`: { "currency": "USD", "amount": 1900 }, with `amount` in the minor unit of the currency. Send `"price": null` to make the plan free. Either is accepted only while no provider has registered the plan.';
const PER_UNIT =
  'Nothing ever charged a per-unit price, so nothing replaces it: remove the field. A USAGE plan takes `meterSlug`, and use beyond the included quantity is charged in credits by `creditsPerUnit` on the plan\'s USAGE entitlement.';

const REMOVED_FIELDS = {
  create: { amount: PRICE_ON_CREATE, currency: PRICE_ON_CREATE, pricePerUnitCents: PER_UNIT },
  update: { amount: PRICE_ON_UPDATE, currency: PRICE_ON_UPDATE, pricePerUnitCents: PER_UNIT },
} as const;

/**
 * Refuse a plan body that still sends a field the money model removed, so an
 * older client fails loudly instead of creating a plan with no price.
 *
 * @example
 * assertNoRemovedPlanFields(req.body, 'create'); // throws BILLING_FIELD_REMOVED for { amount: 1900 }
 */
export function assertNoRemovedPlanFields(body: unknown, operation: 'create' | 'update'): void {
  if (typeof body !== 'object' || body === null) return;
  for (const [field, fix] of Object.entries(REMOVED_FIELDS[operation])) {
    if (!(field in body)) continue;
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_FIELD_REMOVED',
      message: `A plan no longer takes \`${field}\` at the top level.`,
      fix,
    });
  }
}
