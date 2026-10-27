/**
 * Operator MCP write tools for a plan's prices in other currencies.
 *
 * Gated like `update_plan`: `write: true` here and `billing:write` in
 * TOOL_SCOPES. Both go through `planPricesService`, the same service the REST
 * routes call, so a refusal reads the same on either surface and the billing
 * log gets the same `plan.price_set` and `plan.price_archived` events.
 */

import { z } from 'zod';
import { plansService } from '../plans/plans.service.js';
import { planPricesService } from '../plans/plan-prices.service.js';
import type { OperatorTool } from './operator-tools.js';
import { auditOperatorWrite, loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, CurrencyArg, MINOR_UNITS, defineTool } from './tool-definition.js';

const MAX_COUNTRIES = 250;

const PlanPriceRef = {
  applicationId: ApplicationIdArg,
  planSlug: z.string().min(1).max(200).describe("The plan's slug, from list_plans."),
  currency: CurrencyArg,
};

const SetPlanPriceArgs = z
  .object({
    ...PlanPriceRef,
    amount: z
      .number()
      .int()
      .min(1)
      .max(2_147_483_647)
      .optional()
      .describe(
        `The price: ${MINOR_UNITS}. Required to add a price. Leave it out to change only \`countries\` on a price that exists.`,
      ),
    countries: z
      .array(z.string().regex(/^[A-Za-z]{2}$/, 'each country must be a two-letter ISO 3166-1 code'))
      .max(MAX_COUNTRIES)
      .optional()
      .describe(
        'ISO 3166-1 alpha-2 codes where the price applies. Leave it out on an update to keep the list. ' +
          'Empty means wherever the currency is the local one.',
      ),
  })
  .strict();

export const operatorPlanPriceTools: OperatorTool[] = [
  defineTool({
    name: 'set_plan_price',
    description:
      "Add a price in ANOTHER currency to a plan, or update one. The plan's default price is not changed here; " +
      `this adds to \`prices\` on list_plans. \`amount\` is an ${MINOR_UNITS}: 149900 is INR 1,499.00. ` +
      '`countries` is where the price applies; leave it empty to offer the price wherever that currency is the ' +
      "local one. A buyer's country selects the price at checkout, and by default only a country the operator's " +
      'server declares or a trusted proxy vouches for counts. Refused with PLAN_PRICE_IS_DEFAULT for the currency ' +
      "of the plan's default price, PLAN_PRICE_NOT_APPLICABLE for a free or usage-billed plan, " +
      'PLAN_PRICE_CURRENCY_UNSUPPORTED for a three-decimal currency (KWD, BHD, OMR, JOD, TND), and ' +
      'PLAN_PRICE_IMMUTABLE when it would change the amount of a price a provider has already registered, and ' +
      'PLAN_PRICE_REFERENCED when it would change the amount of a price a subscription, an open checkout, a ' +
      'payment or a credit grant names (in both cases its countries can still change; to charge a different ' +
      'amount, remove the price once nobody is on it and set the new amount). Existing subscribers keep the currency they started in. Returns the price ' +
      'as list_plans shows it, with its `id`, `isDefault` and provider `registration`.',
    write: true,
    args: SetPlanPriceArgs,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'billing-write');
      const plan = await plansService.getBySlug(app.id, input.planSlug);
      const price = await planPricesService.put({
        applicationId: app.id,
        plan: plan.id,
        currency: input.currency,
        amount: input.amount,
        countries: input.countries,
        actor: { operatorId: ctx.tenantUserId },
      });
      auditOperatorWrite(ctx, 'app.plan_updated', app.id, {
        plan: plan.slug,
        price: price.currency,
        amount: price.amount,
        countries: price.countries,
      });
      return { planSlug: plan.slug, price };
    },
  }),
  defineTool({
    name: 'remove_plan_price',
    description:
      "Take a plan's price in another currency off sale. New buyers it applied to are charged the plan's default " +
      'price instead. A price a payment or an ended subscription still names is archived, not deleted, so their ' +
      'records keep pointing at it. Refused with PLAN_PRICE_IN_USE (409) while a live subscription or an open ' +
      "checkout is on the price. The plan's default price cannot be removed here.",
    write: true,
    annotations: { destructiveHint: true },
    args: z.object(PlanPriceRef).strict(),
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'billing-write');
      const plan = await plansService.getBySlug(app.id, input.planSlug);
      const currency = input.currency.toUpperCase();
      await planPricesService.remove({
        applicationId: app.id,
        plan: plan.id,
        currency,
        actor: { operatorId: ctx.tenantUserId },
      });
      auditOperatorWrite(ctx, 'app.plan_updated', app.id, { plan: plan.slug, priceDeleted: currency });
      return { planSlug: plan.slug, currency, removed: true };
    },
  }),
];
