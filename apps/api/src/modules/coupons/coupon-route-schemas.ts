/**
 * What the operator routes (tenant session, super-admin key) share: the
 * request bodies, their OpenAPI form, and the errors a coupon write answers.
 */

import { CreateCouponRequestSchema, UpdateCouponRequestSchema } from '@rekey.dev/shared-types';
import { assertMetadataWithinLimit } from '../../lib/metadata-limit.js';
import { assertNoRemovedCouponFields } from './coupon-terms.js';
import type { CouponActor } from './coupon-events.js';
import type { CreateCouponInput, UpdateCouponInput } from './coupons.service.js';

const AMOUNTS_JSON_SCHEMA = {
  type: 'array',
  maxItems: 200,
  description:
    'AMOUNT only. What the coupon takes off in each currency it works in, one entry per currency. ' +
    'The coupon is refused at checkout in a currency with no entry: an amount is never converted.',
  items: {
    type: 'object',
    required: ['currency', 'amountOff'],
    properties: {
      currency: { type: 'string', minLength: 3, maxLength: 3, description: 'ISO 4217, a currency a price can be in.' },
      amountOff: {
        type: 'integer',
        description: 'Above 0, in the smallest unit of `currency`. HUF, TWD and MGA are whole units written in hundredths.',
      },
    },
  },
} as const;

const TERMS_JSON_PROPERTIES = {
  basisPoints: {
    type: 'integer',
    description: 'PERCENT only. Hundredths of a percent, 1 to 10000: 1500 is 15%. Rounded toward the buyer in the currency charged.',
  },
  amounts: AMOUNTS_JSON_SCHEMA,
  currencies: {
    type: 'array',
    maxItems: 200,
    items: { type: 'string', minLength: 3, maxLength: 3 },
    description: 'PERCENT only. Limit the coupon to prices in these ISO 4217 currencies. Empty or left out: any currency.',
  },
  planSlugs: { type: 'array', items: { type: 'string' }, description: 'Limit the coupon to these plans. Empty or left out: any plan.' },
} as const;

export const CREATE_COUPON_BODY_JSON_SCHEMA = {
  type: 'object',
  required: ['code', 'discountType'],
  properties: {
    code: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      description: 'Letters, digits, underscores and hyphens. Stored lowercase, so `LAUNCH` and `launch` are one coupon.',
    },
    discountType: {
      type: 'string',
      enum: ['PERCENT', 'AMOUNT'],
      description: 'PERCENT takes `basisPoints`. AMOUNT takes `amounts`. It cannot be changed later.',
    },
    ...TERMS_JSON_PROPERTIES,
    startsAt: { type: 'string', format: 'date-time', description: 'The coupon is refused before this instant.' },
    endsAt: { type: 'string', format: 'date-time', description: 'The coupon is refused after this instant.' },
    maxRedemptions: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      description: 'How many times the coupon may be redeemed in all, across every buyer and currency.',
    },
    maxRedemptionsPerUser: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      description: 'How many times one buyer may redeem it.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Free-form operator notes, at most 16KB. Never shown to a buyer.',
    },
  },
} as const;

export const UPDATE_COUPON_BODY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    active: { type: 'boolean', description: '`false` stops the coupon being accepted. Reversible.' },
    ...TERMS_JSON_PROPERTIES,
    amounts: { ...AMOUNTS_JSON_SCHEMA, description: `${AMOUNTS_JSON_SCHEMA.description} Replaces the whole set.` },
    endsAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'The coupon is refused after this instant. `null` removes the end.',
    },
    maxRedemptions: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      nullable: true,
      description:
        'How many times the coupon may be redeemed in all, across every buyer and currency. `null` removes the cap. ' +
        'Refused below the redemptions already held: settled ones plus checkouts still open.',
    },
    maxRedemptionsPerUser: {
      type: 'integer',
      minimum: 1,
      maximum: 2147483647,
      nullable: true,
      description:
        'How many times one buyer may redeem it. `null` removes the cap. Refused when any one buyer already holds more.',
    },
  },
} as const;

export const CREATE_COUPON_DESCRIPTION =
  'A PERCENT coupon takes `basisPoints` (1500 is 15%) and works in any currency unless `currencies` limits it. ' +
  'An AMOUNT coupon takes `amounts`, one amount per currency, and works only in those currencies. ' +
  'Codes are stored lowercase. `amountOff` and `currency` at the top level were removed and are refused.';

export const UPDATE_COUPON_DESCRIPTION =
  'Send at least one field. `amounts` replaces the whole set, so send every currency the coupon should keep. ' +
  'A checkout already open keeps the discount it was opened with. `discountType` cannot be changed. ' +
  '`endsAt`, `maxRedemptions` and `maxRedemptionsPerUser` each take a value or `null`, which removes the end date or the cap. ' +
  'Every change is written to the billing log as `coupon.changed`, with the terms before and after.';

export const UPDATE_COUPON_409 =
  'COUPON_LIMIT_BELOW_REDEEMED: `maxRedemptions` is below the redemptions the coupon already holds, or ' +
  '`maxRedemptionsPerUser` is below what one buyer already holds. Settled redemptions and checkouts still open both count. ' +
  '`details.redeemed` is the count.';

const TERMS_ERRORS =
  'COUPON_AMOUNT_INVALID: `basisPoints` is missing or outside 1 to 10000 on a PERCENT coupon, or an amount is not ' +
  'a chargeable amount in its currency, or `amounts` names a currency twice; or COUPON_AMOUNTS_REQUIRED: an AMOUNT ' +
  'coupon has no amounts; or COUPON_CURRENCY_INVALID: a currency is not one a price can be in; or ' +
  'COUPON_DISCOUNT_SHAPE_INVALID: a field that belongs to the other discount type was sent; or ' +
  'BILLING_FIELD_REMOVED: the body sends `amountOff` or `currency`, which were replaced by `basisPoints` and `amounts`';

export const CREATE_COUPON_400 =
  `VALIDATION_ERROR: a field failed schema validation; or COUPON_CODE_INVALID: the code is not 1-40 alphanumerics, underscores or hyphens; or ${TERMS_ERRORS}.`;

export const UPDATE_COUPON_400 = `VALIDATION_ERROR: a field failed schema validation, or the body is empty; or ${TERMS_ERRORS}.`;

/**
 * Parse a create body into the service's input.
 *
 * @example
 * await couponsService.create(createCouponInput(id, req.body, { operatorId }));
 */
export function createCouponInput(applicationId: string, rawBody: unknown, actor: CouponActor): CreateCouponInput {
  assertNoRemovedCouponFields(rawBody);
  const body = CreateCouponRequestSchema.parse(rawBody);
  if (body.metadata !== undefined) assertMetadataWithinLimit(body.metadata);
  return {
    applicationId,
    code: body.code,
    discountType: body.discountType,
    basisPoints: body.basisPoints,
    amounts: body.amounts,
    currencies: body.currencies,
    ...(body.planSlugs !== undefined && { planSlugs: body.planSlugs }),
    ...(body.startsAt !== undefined && { startsAt: new Date(body.startsAt) }),
    ...(body.endsAt !== undefined && { endsAt: new Date(body.endsAt) }),
    ...(body.maxRedemptions !== undefined && { maxRedemptions: body.maxRedemptions }),
    ...(body.maxRedemptionsPerUser !== undefined && { maxRedemptionsPerUser: body.maxRedemptionsPerUser }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    actor,
  };
}

/**
 * Parse an update body into the service's input.
 *
 * @example
 * await couponsService.update(updateCouponInput(id, code, req.body, { operatorId }));
 */
export function updateCouponInput(applicationId: string, code: string, rawBody: unknown, actor: CouponActor): UpdateCouponInput {
  assertNoRemovedCouponFields(rawBody);
  const { endsAt, ...body } = UpdateCouponRequestSchema.parse(rawBody);
  return {
    applicationId,
    code,
    ...body,
    ...(endsAt !== undefined && { endsAt: endsAt === null ? null : new Date(endsAt) }),
    actor,
  };
}
