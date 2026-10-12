/**
 * Operator MCP tools for coupons: list, create and change.
 *
 * The write tools hand their arguments to `createCouponInput` and
 * `updateCouponInput`, the parsers the REST routes use, and then to
 * `couponsService`. So a coupon is held to the same rules on either surface
 * and the billing log gets the same `coupon.created` and `coupon.changed`.
 */

import { z } from 'zod';
import { serializeCoupon, serializeCouponWithStats } from '../coupons/coupon-dto.js';
import { createCouponInput, updateCouponInput } from '../coupons/coupon-route-schemas.js';
import { assertNoRemovedCouponFields } from '../coupons/coupon-terms.js';
import { couponsService } from '../coupons/coupons.service.js';
import type { OperatorTool } from './operator-tools.js';
import { auditOperatorWrite, loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, MINOR_UNITS, MetadataArg, defineTool } from './tool-definition.js';

const INT_MAX = 2_147_483_647;
const LIST_MAX = 100;

const COUPON_SHAPE =
  'A coupon is PERCENT or AMOUNT. PERCENT carries `basisPoints` (1500 is 15%) and works in any currency unless ' +
  '`currencies` limits it. AMOUNT carries `amounts`, one `{ currency, amountOff }` per currency with `amountOff` ' +
  `an ${MINOR_UNITS}, and works only in those currencies. \`coveredCurrencies\` is where the coupon works: null ` +
  'means any currency. An amount is never converted: a coupon is refused at checkout in a currency it does not cover.';

const CodeArg = z.string().min(1).max(40).describe('The coupon code. Letters, digits, underscores and hyphens; stored lowercase.');

const CouponCurrencyArg = z.string().length(3).describe('ISO 4217 code of a currency a price can be in, such as USD or INR.');

const terms = {
  // Ranges and currencies are judged by the service, which answers them with a code and a fix.
  basisPoints: z
    .number()
    .int()
    .optional()
    .describe('PERCENT only. Hundredths of a percent, 1 to 10000: 1500 is 15%. Rounded toward the buyer in the currency charged.'),
  amounts: z
    .array(
      z
        .object({
          currency: CouponCurrencyArg,
          amountOff: z.number().int().describe(`What the coupon takes off in \`currency\`: ${MINOR_UNITS}.`),
        })
        .strict(),
    )
    .max(200)
    .optional()
    .describe('AMOUNT only. One entry per currency the coupon works in.'),
  currencies: z
    .array(CouponCurrencyArg)
    .max(200)
    .optional()
    .describe('PERCENT only. Limit the coupon to prices in these currencies. Empty or left out: any currency.'),
  planSlugs: z
    .array(z.string().min(1).max(40))
    .optional()
    .describe('Limit the coupon to these plans. Empty or left out: any plan.'),
};

const CreateCouponArgs = z
  .object({
    applicationId: ApplicationIdArg,
    code: CodeArg,
    discountType: z.enum(['PERCENT', 'AMOUNT']),
    ...terms,
    startsAt: z.string().datetime().optional().describe('ISO 8601. The coupon is refused before it.'),
    endsAt: z.string().datetime().optional().describe('ISO 8601. The coupon is refused after it.'),
    maxRedemptions: z.number().int().min(1).max(INT_MAX).optional().describe('Across every buyer and currency.'),
    maxRedemptionsPerUser: z.number().int().min(1).max(INT_MAX).optional(),
    metadata: MetadataArg.optional().describe('Free-form operator notes stored on the coupon. Never shown to a buyer.'),
  })
  .strict();

const UpdateCouponArgs = z
  .object({
    applicationId: ApplicationIdArg,
    code: CodeArg,
    active: z.boolean().optional().describe('false stops the coupon being accepted. Reversible.'),
    ...terms,
    amounts: terms.amounts.describe(
      'AMOUNT only. Replaces the whole set, so send every currency the coupon should keep.',
    ),
    endsAt: z.string().datetime().nullable().optional().describe('ISO 8601. The coupon is refused after it. null removes the end.'),
    maxRedemptions: z
      .number()
      .int()
      .min(1)
      .max(INT_MAX)
      .nullable()
      .optional()
      .describe('Across every buyer and currency. null removes the cap. Refused below the redemptions already held.'),
    maxRedemptionsPerUser: z
      .number()
      .int()
      .min(1)
      .max(INT_MAX)
      .nullable()
      .optional()
      .describe('Per buyer. null removes the cap. Refused when any one buyer already holds more.'),
  })
  .strict();

export const operatorCouponTools: OperatorTool[] = [
  defineTool({
    name: 'list_coupons',
    description:
      `Coupons on an application, active and inactive, newest first. ${COUPON_SHAPE} Each also carries ` +
      '`redemptionCount` and `discountIssuedByCurrency`: what it has taken off in each currency it was redeemed ' +
      `in, as \`{ currency, amount, redemptions }\` with \`amount\` an ${MINOR_UNITS}. There is ` +
      'no total across currencies.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        limit: z.number().int().min(1).max(LIST_MAX).default(25),
        offset: z.number().int().min(0).default(0),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const [items, total] = await Promise.all([
        couponsService.listWithStats(app.id, true, { take: input.limit, skip: input.offset }),
        couponsService.count(app.id, true),
      ]);
      return { coupons: items.map((coupon) => serializeCouponWithStats(coupon, coupon)), total };
    },
  }),
  defineTool({
    name: 'create_coupon',
    description:
      `Create a coupon on an application. ${COUPON_SHAPE} Send \`basisPoints\` for PERCENT, \`amounts\` for ` +
      'AMOUNT, never both. `amountOff` and `currency` at the top level were removed and are refused with ' +
      'BILLING_FIELD_REMOVED. Refused with COUPON_CODE_TAKEN when the code exists, COUPON_AMOUNTS_REQUIRED for ' +
      'an AMOUNT coupon with no amounts, and COUPON_CURRENCY_INVALID for a currency no price can be in. ' +
      'Returns the coupon.',
    write: true,
    args: CreateCouponArgs,
    refuse: assertNoRemovedCouponFields,
    run: async (ctx, { applicationId, ...body }) => {
      const app = await loadAppInTenant(ctx, applicationId);
      const coupon = serializeCoupon(
        await couponsService.create(createCouponInput(app.id, body, { operatorId: ctx.tenantUserId })),
      );
      auditOperatorWrite(ctx, 'app.coupon_created', app.id, {
        code: coupon.code,
        discountType: coupon.discountType,
        basisPoints: coupon.basisPoints,
        amounts: coupon.amounts,
        currencies: coupon.currencies,
      });
      return coupon;
    },
  }),
  defineTool({
    name: 'update_coupon',
    description:
      `Change a coupon: switch it on or off, or change its discount, currencies, plans, end date or redemption caps. ${COUPON_SHAPE} Send ` +
      'at least one field. `amounts` replaces the whole set. `discountType` cannot be changed. A checkout already ' +
      'open keeps the discount it was opened with. `endsAt`, `maxRedemptions` and `maxRedemptionsPerUser` each take a ' +
      'value or null, which removes the end date or the cap. A cap below the redemptions already held (settled ones ' +
      'plus checkouts still open) is refused with COUPON_LIMIT_BELOW_REDEEMED, whose `fix` names the lowest cap ' +
      'accepted. Every change is written to the billing log as coupon.changed. Returns the coupon after the change.',
    write: true,
    args: UpdateCouponArgs,
    refuse: assertNoRemovedCouponFields,
    run: async (ctx, { applicationId, code, ...body }) => {
      const app = await loadAppInTenant(ctx, applicationId);
      const coupon = serializeCoupon(
        await couponsService.update(updateCouponInput(app.id, code, body, { operatorId: ctx.tenantUserId })),
      );
      auditOperatorWrite(ctx, 'app.coupon_updated', app.id, { code: coupon.code, ...body });
      return coupon;
    },
  }),
];
