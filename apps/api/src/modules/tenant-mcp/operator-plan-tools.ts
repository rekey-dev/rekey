/**
 * Operator MCP tools for the plan catalogue: list, create, edit, archive and
 * register with a provider.
 *
 * A plan is returned with `price`, the price a buyer with no country would be
 * charged, and `prices`, every price it sells at. It carries no `amount`,
 * `currency` or `pricePerUnitCents` of its own. Every write goes through
 * `plansService`, as the REST routes do.
 */

import { z } from 'zod';
import type { Plan } from '@prisma/client';
import { plansService } from '../plans/plans.service.js';
import { PLAN_LOCAL_PRICES_DESCRIPTION, PlanLocalPricesBody } from '../plans/local-prices.js';
import { serializePlans, type OperatorPlan } from '../plans/plan-dto.js';
import type { OperatorTool } from './operator-tools.js';
import { auditOperatorWrite, loadAppInTenant } from './operator-write-tools.js';
import { ApplicationIdArg, CurrencyArg, MINOR_UNITS, MetadataArg, defineTool, removedField } from './tool-definition.js';

const INT_MAX = 2_147_483_647;

/** A plan as these tools return it: the operator's plan, as the REST plan list returns it. */
export type ToolPlan = OperatorPlan;

async function toolPlans(applicationId: string, plans: Plan[]): Promise<ToolPlan[]> {
  // The serialiser the REST plan list uses, so these tools cannot fall behind it.
  return serializePlans(applicationId, plans, 'operator');
}

async function toolPlan(applicationId: string, plan: Plan): Promise<ToolPlan> {
  const [serialised] = await toolPlans(applicationId, [plan]);
  return serialised!;
}

const PLAN_SHAPE =
  'Each plan carries `price` (`{ id, currency, amount, formatted, isDefault, reason }`, null for a plan with no ' +
  'flat price) and `prices` (every price it sells at, the default first, each with `id`, `currency`, `amount`, ' +
  `\`countries\`, \`isDefault\`, its provider \`registration\`, \`amountEditable\` (false once a provider holds ` +
  `the price or a subscription, an open checkout, a payment or a credit grant names it, after which set_plan_price cannot change its amount), and \`liveSubscriptions\` and \`openCheckouts\` ` +
  `(counts of who is on it: with either above 0, remove_plan_price is refused). Every \`amount\` is an ${MINOR_UNITS}.`;

const SlugArg = z.string().min(1).max(40);

const CreatePlanArgs = z
  .object({
    applicationId: ApplicationIdArg,
    slug: SlugArg.describe('Lowercase letters, digits, underscores and hyphens. Integrations pass it to checkout.'),
    name: z.string().min(1).max(120),
    price: z
      .object({
        currency: CurrencyArg,
        amount: z.number().int().min(1).max(INT_MAX).describe(`What the plan costs: ${MINOR_UNITS}.`),
      })
      .strict()
      .optional()
      .describe(
        "The plan's default price. Leave it out for a free plan, or for a USAGE plan with no base fee. " +
          'Prices in other currencies are added afterwards with set_plan_price.',
      ),
    interval: z.enum(['MONTH', 'YEAR']).optional().describe('Defaults to MONTH.'),
    kind: z
      .enum(['SUBSCRIPTION', 'LICENSE', 'USAGE', 'CREDIT'])
      .optional()
      .describe('Defaults to SUBSCRIPTION.'),
    creditsAmount: z
      .number()
      .int()
      .min(1)
      .max(INT_MAX)
      .optional()
      .describe('CREDIT plans: how many credits the purchase grants. Required for that kind. A count, not money.'),
    licenseKind: z.enum(['PERPETUAL', 'TIMED', 'SEATS']).optional().describe('LICENSE plans: required for that kind.'),
    licenseDurationDays: z
      .number()
      .int()
      .min(1)
      .max(INT_MAX)
      .optional()
      .describe('LICENSE plans with licenseKind TIMED: required for that combination.'),
    licenseSeatsAllowed: z
      .number()
      .int()
      .min(1)
      .max(INT_MAX)
      .optional()
      .describe('LICENSE plans with licenseKind SEATS: required for that combination.'),
    meterSlug: SlugArg.optional().describe('USAGE plans: the usage meter this plan bills against. Required for that kind.'),
    // Provider-reserved keys (stripe, paypal, razorpay) are stripped by the service.
    metadata: MetadataArg.optional().describe('Free-form operator metadata stored on the plan.'),
  })
  .strict();

const UpdatePlanArgs = z
  .object({
    applicationId: ApplicationIdArg,
    slug: SlugArg,
    name: z.string().min(1).max(120).optional(),
    licenseSeatsAllowed: z.number().int().min(0).max(INT_MAX).optional().describe('LICENSE plans only.'),
    licenseDurationDays: z.number().int().min(0).max(INT_MAX).optional().describe('LICENSE plans only.'),
    creditsAmount: z.number().int().min(0).max(INT_MAX).optional().describe('CREDIT plans only. A count, not money.'),
    localPrices: PlanLocalPricesBody.optional().describe(PLAN_LOCAL_PRICES_DESCRIPTION),
  })
  .strict();

const PlanRefArgs = z.object({ applicationId: ApplicationIdArg, planSlug: SlugArg }).strict();

const REMOVED_PLAN_FIELDS: Readonly<Record<string, string>> = {
  amount: 'Send the default price as `price`: { "currency": "USD", "amount": 1900 }. Leave `price` out for a free plan.',
  currency: 'Send the default price as `price`: { "currency": "USD", "amount": 1900 }. Leave `price` out for a free plan.',
  pricePerUnitCents:
    'Nothing ever charged a per-unit price, so a USAGE plan takes `meterSlug` only. Overage is priced on the entitlement with put_plan_entitlement.',
};

function refuseRemovedPlanFields(tool: string) {
  return (raw: Readonly<Record<string, unknown>>): void => {
    for (const [field, fix] of Object.entries(REMOVED_PLAN_FIELDS)) {
      if (field in raw) throw removedField(tool, field, fix);
    }
  };
}

export const operatorPlanTools: OperatorTool[] = [
  defineTool({
    name: 'list_plans',
    description:
      `Plans on an application, including inactive ones. Slugs for the other tools. ${PLAN_SHAPE} ` +
      'Each plan also carries `checkout.ready`: false means a buyer sent to checkout for it is refused, and ' +
      '`checkout.blockers` says by which provider and how to repair it. Check it after configuring a billing ' +
      'provider: plans register with the provider when they are CREATED, so a plan created before the ' +
      'credentials existed has no price behind it at the provider, and register_plan_with_provider repairs it.',
    args: z.object({ applicationId: ApplicationIdArg }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const plans = await plansService.listForApplication(app.id, true);
      return { plans: await toolPlans(app.id, plans) };
    },
  }),
  defineTool({
    name: 'create_plan',
    description:
      'Create a billing Plan on an application. `price` is its default price, `{ currency, amount }` with ' +
      `\`amount\` an ${MINOR_UNITS}; leave \`price\` out for a free plan. Defaults: interval MONTH, kind ` +
      'SUBSCRIPTION. `amount`, `currency` and `pricePerUnitCents` at the top level were removed and are ' +
      'refused with BILLING_FIELD_REMOVED.\n\n' +
      'Each `kind` needs its own fields, and the API refuses the plan without them:\n' +
      '- SUBSCRIPTION: nothing extra. `interval` applies. Free trials are held in this ' +
      'release and a plan cannot carry one.\n' +
      '- CREDIT: `creditsAmount`. A one-off pack of credits, not a recurring charge.\n' +
      '- LICENSE: `licenseKind`, plus `licenseDurationDays` for TIMED and ' +
      '`licenseSeatsAllowed` for SEATS.\n' +
      '- USAGE: `meterSlug` (see list_usage_meters).\n\n' +
      `Returns the plan. ${PLAN_SHAPE}`,
    write: true,
    args: CreatePlanArgs,
    refuse: refuseRemovedPlanFields('create_plan'),
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const kind = input.kind ?? 'SUBSCRIPTION';
      const plan = await plansService.create({
        applicationId: app.id,
        slug: input.slug,
        name: input.name,
        ...(input.price !== undefined && { price: input.price }),
        ...(input.interval !== undefined && { interval: input.interval }),
        kind,
        ...(input.creditsAmount !== undefined && { creditsAmount: input.creditsAmount }),
        ...(input.licenseKind !== undefined && { licenseKind: input.licenseKind }),
        ...(input.licenseDurationDays !== undefined && { licenseDurationDays: input.licenseDurationDays }),
        ...(input.licenseSeatsAllowed !== undefined && { licenseSeatsAllowed: input.licenseSeatsAllowed }),
        ...(input.meterSlug !== undefined && { meterSlug: input.meterSlug }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        actor: { operatorId: ctx.tenantUserId },
      });
      auditOperatorWrite(ctx, 'app.plan_created', app.id, {
        planSlug: plan.slug,
        price: plan.defaultPrice === null ? null : { currency: plan.defaultPrice.currency, amount: plan.defaultPrice.amount },
        kind: plan.kind,
      });
      return toolPlan(app.id, plan);
    },
  }),
  defineTool({
    name: 'set_plan_active',
    description:
      'Activate or ARCHIVE a plan by slug. Deactivating (active=false) archives it: existing ' +
      'subscriptions keep billing, but no new sign-ups. This is how you retire a plan. A price a ' +
      'provider has registered cannot change its amount, so to change pricing you archive the old ' +
      'plan here and create a replacement with create_plan UNDER A DIFFERENT SLUG. Archiving does ' +
      'not release the slug: it is the identifier integrations pass to checkout, so reusing it is ' +
      'refused with PLAN_SLUG_TAKEN. Reversible.',
    write: true,
    args: z.object({ applicationId: ApplicationIdArg, slug: SlugArg, active: z.boolean() }).strict(),
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const plan = await plansService.setActive(app.id, input.slug, input.active);
      auditOperatorWrite(ctx, 'app.plan_active_changed', app.id, { planSlug: plan.slug, active: plan.active });
      return { slug: plan.slug, active: plan.active };
    },
  }),
  defineTool({
    name: 'update_plan',
    description:
      "Edit a plan's ENTITLEMENTS and its local prices rule ONLY: its display name, LICENSE seats or " +
      'duration, CREDIT amount, or `localPrices` (INHERIT, TRUSTED or OFF: whether a buyer\'s country ' +
      'may select one of the plan\'s prices in another currency; a change is written to the billing ' +
      'log as plan.local_prices_changed). You CANNOT change a price or the interval here. To change pricing, ARCHIVE this plan ' +
      '(set_plan_active active=false) and CREATE a replacement (create_plan) under a DIFFERENT slug, ' +
      'because archiving does not release the old one. Existing subscribers keep their old price, new ' +
      'sign-ups get the new plan. To sell this same plan in ANOTHER currency, do not make a second ' +
      `plan: add a price with set_plan_price. Returns the plan. ${PLAN_SHAPE}`,
    write: true,
    args: UpdatePlanArgs,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const patch = {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.licenseSeatsAllowed !== undefined && { licenseSeatsAllowed: input.licenseSeatsAllowed }),
        ...(input.licenseDurationDays !== undefined && { licenseDurationDays: input.licenseDurationDays }),
        ...(input.creditsAmount !== undefined && { creditsAmount: input.creditsAmount }),
        ...(input.localPrices !== undefined && { localPrices: input.localPrices }),
      };
      const plan = await plansService.updateEntitlements(app.id, input.slug, patch, { operatorId: ctx.tenantUserId });
      auditOperatorWrite(ctx, 'app.plan_entitlements_updated', app.id, {
        planSlug: plan.slug,
        fields: Object.keys(patch),
      });
      return toolPlan(app.id, plan);
    },
  }),
  defineTool({
    name: 'register_plan_with_provider',
    description:
      'Register an existing plan with the billing provider, giving it a price there so it can be ' +
      'bought. The repair for `checkout.ready: false` on a plan created before the provider ' +
      'was configured. Idempotent: a plan that already has a price is answered from the row ' +
      'without calling the provider. A plan the provider previously refused is reactivated on ' +
      'success, because it was deactivated by Rekey rather than by you; a plan you retired on ' +
      `purpose keeps its \`active: false\`, since this registers rather than publishes. Returns the plan. ${PLAN_SHAPE}`,
    write: true,
    args: PlanRefArgs,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId);
      const plan = await plansService.registerWithProvider(app.id, input.planSlug);
      auditOperatorWrite(ctx, 'app.plan_updated', app.id, {
        planSlug: plan.slug,
        registrationStatus: plan.registrationStatus,
      });
      return { plan: await toolPlan(app.id, plan) };
    },
  }),
];
