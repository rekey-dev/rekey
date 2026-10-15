/**
 * The operator MCP billing tools on the money model's shapes: a plan with its
 * resolved `price` and `prices`, a payment with what was refunded and whether
 * it was verified, coupons per currency, stats per currency. And the new
 * tools: each one's happy path, and its refusal without the scope, with too
 * low a role, and for another workspace's Application.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { prisma } from '../src/lib/prisma.js';
import { UNRESTRICTED, type Scope } from '../src/lib/operator-scopes.js';
import { recordBillingEvent, type BillingEventInput } from '../src/modules/billing-log/index.js';
import type { RefundPaymentInput, RefundPaymentResult } from '../src/modules/billing/providers/types.js';
import { type OperatorToolContext } from '../src/modules/tenant-mcp/operator-tools.js';
import { TOOL_SCOPES, allOperatorTools, handleOperatorMcpMessage } from '../src/modules/tenant-mcp/tenant-mcp-server.js';
import { fakeStripe } from './fakes/billing-providers.js';
import { twoCurrencyWorld, type TwoCurrencyWorld } from './two-currency-world.js';
import { operatorsConfirmTheirEmail } from './confirmed-accounts.js';

operatorsConfirmTheirEmail();

const READ_TOOLS = [
  'preview_checkout_routing',
  'list_price_fallbacks',
  'get_billing_reconciliation',
  'get_payment',
  'list_payment_refunds',
  'get_reporting_currency',
  'get_billing_stats',
  'list_coupons',
  'list_plans',
] as const;

/** Write tools behind `mcp:operator:write`, each with arguments that would succeed for the owner. */
const WRITE_CALLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['create_plan', { slug: 'team', name: 'Team', price: { currency: 'USD', amount: 4900 } }],
  ['update_plan', { slug: 'pro', name: 'Pro Plus' }],
  ['set_plan_price', { planSlug: 'pro', currency: 'EUR', amount: 1800 }],
  ['remove_plan_price', { planSlug: 'pro', currency: 'INR' }],
  ['create_coupon', { code: 'LAUNCH', discountType: 'PERCENT', basisPoints: 1500 }],
  ['update_coupon', { code: 'welcome', active: false }],
  ['set_reporting_currency', { reportingCurrency: 'EUR' }],
];

const MONEY_TOOLS = [
  'list_plans',
  'create_plan',
  'update_plan',
  'register_plan_with_provider',
  'set_plan_price',
  'list_coupons',
  'create_coupon',
  'update_coupon',
  'preview_checkout_routing',
  'get_billing_reconciliation',
  'get_payment',
  'list_payment_refunds',
  'get_billing_stats',
  'create_refund',
  'recent_payments',
  'recent_subscriptions',
  'get_end_user',
  'get_workspace_overview',
];

/** Fields section 9 of the money model removed. No tool takes one. */
const REMOVED_INPUTS = ['amountOff', 'pricePerUnitCents', 'amountMinor', 'mrrCents', 'mrrCurrency'];

interface ToolResult {
  isError: boolean;
  data: Record<string, unknown>;
}

describe('operator MCP billing tools on the money model', () => {
  let app: FastifyInstance;
  let w: TwoCurrencyWorld;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    w = await twoCurrencyWorld(app);
  });
  afterEach(() => {
    delete (fakeStripe as { refundPayment?: unknown }).refundPayment;
  });

  async function ownerOf(world: TwoCurrencyWorld, over: Partial<OperatorToolContext> = {}): Promise<OperatorToolContext> {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: world.applicationId } });
    const owner = await prisma.tenantMembership.findFirstOrThrow({ where: { tenantId: application.tenantId, role: 'OWNER' } });
    return {
      tenantUserId: owner.tenantUserId,
      tenantId: application.tenantId,
      role: 'OWNER',
      tenantMembershipId: owner.id,
      scopes: UNRESTRICTED,
      canWrite: true,
      canAdmin: true,
      ...over,
    };
  }

  /** One `tools/call` through the dispatcher, so the scope and role gate runs. */
  async function call(ctx: OperatorToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const response = (await handleOperatorMcpMessage(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    return { isError: response.result.isError === true, data: JSON.parse(response.result.content[0]!.text) as Record<string, unknown> };
  }

  async function ok<T>(ctx: OperatorToolContext, name: string, args: Record<string, unknown>): Promise<T> {
    const result = await call(ctx, name, args);
    expect(result.isError, `${name}: ${JSON.stringify(result.data)}`).toBe(false);
    return result.data as T;
  }

  const logged = (type: string) =>
    prisma.billingEvent.findMany({ where: { applicationId: w.applicationId, type }, orderBy: { seq: 'asc' } });

  const usdPayment = (over: Record<string, unknown> = {}) =>
    prisma.payment.create({
      data: {
        applicationId: w.applicationId,
        endUserId: w.buyer.id,
        amount: 2000,
        currency: 'USD',
        status: 'SUCCEEDED',
        provider: 'stripe',
        providerPaymentId: `ch_${Math.random().toString(36).slice(2, 10)}`,
        ...over,
      },
    });

  function refundingStripe(): RefundPaymentInput[] {
    const issued: RefundPaymentInput[] = [];
    (fakeStripe as { refundPayment?: (input: RefundPaymentInput) => Promise<RefundPaymentResult> }).refundPayment = async (input) => {
      issued.push(input);
      return { refundId: `re_${issued.length}`, amount: input.amount ?? 0, currency: 'USD', status: 'succeeded' };
    };
    return issued;
  }

  describe('what the tools publish', () => {
    const named = new Set<string>([...READ_TOOLS, ...MONEY_TOOLS, ...WRITE_CALLS.map(([name]) => name)]);
    const published = () => allOperatorTools.filter((tool) => named.has(tool.name));

    it('every billing tool is governed by a billing scope, and the writes are write tools', () => {
      for (const name of READ_TOOLS) {
        expect(TOOL_SCOPES[name], name).toBe('billing:read');
        expect(allOperatorTools.find((tool) => tool.name === name)!.write, name).toBeFalsy();
      }
      for (const [name] of WRITE_CALLS) {
        const tool = allOperatorTools.find((candidate) => candidate.name === name)!;
        expect(TOOL_SCOPES[name], name).toBe('billing:write');
        expect(tool.write, name).toBe(true);
        expect(tool.admin, name).toBeFalsy();
      }
      const refund = allOperatorTools.find((tool) => tool.name === 'create_refund')!;
      expect(TOOL_SCOPES.create_refund).toBe('billing:write');
      expect(refund).toMatchObject({ write: true, admin: true });
    });

    it('no tool takes a field the money model removed, and a plan takes no amount or currency of its own', () => {
      for (const tool of published()) {
        const properties = Object.keys(tool.inputSchema.properties);
        for (const removed of REMOVED_INPUTS) expect(properties, `${tool.name}.${removed}`).not.toContain(removed);
        expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      }
      for (const name of ['create_plan', 'update_plan', 'create_coupon', 'update_coupon']) {
        const properties = Object.keys(allOperatorTools.find((tool) => tool.name === name)!.inputSchema.properties);
        expect(properties, name).not.toContain('amount');
        expect(properties, name).not.toContain('currency');
      }
      const createPlan = allOperatorTools.find((tool) => tool.name === 'create_plan')!.inputSchema;
      expect(createPlan.required).toEqual(['applicationId', 'slug', 'name']);
      expect(createPlan.properties.price).toMatchObject({
        type: 'object',
        required: ['currency', 'amount'],
        properties: { amount: { type: 'integer', minimum: 1 } },
      });
      const createCoupon = allOperatorTools.find((tool) => tool.name === 'create_coupon')!.inputSchema;
      expect(Object.keys(createCoupon.properties)).toEqual(
        expect.arrayContaining(['basisPoints', 'amounts', 'currencies', 'planSlugs', 'discountType', 'code']),
      );
    });
  });

  describe('reads', () => {
    it('get_end_user reports the current subscription with its own price, null when it has none', async () => {
      const ctx = await ownerOf(w);
      await prisma.subscription.create({
        data: { applicationId: w.applicationId, endUserId: w.buyer.id, planId: w.planId, status: 'ACTIVE', provider: 'external' },
      });
      const unpriced = await ok<{ currentSubscription: Record<string, unknown> }>(ctx, 'get_end_user', {
        applicationId: w.applicationId,
        endUserId: w.buyer.id,
      });
      expect(unpriced.currentSubscription).toMatchObject({ planSlug: 'pro', price: null });

      const other = await w.newBuyer();
      const granted = await w.operator('POST', `/end-users/${other.id}/subscriptions`, { planSlug: 'pro', currency: 'INR' });
      expect(granted.statusCode, granted.body).toBe(201);
      const priced = await ok<{ currentSubscription: Record<string, unknown> }>(ctx, 'get_end_user', {
        applicationId: w.applicationId,
        endUserId: other.id,
      });
      expect(priced.currentSubscription.price).toEqual({ currency: 'INR', amount: 149900 });
    });

    it('list_price_fallbacks counts the fallbacks of the period for this Application', async () => {
      const fallback: BillingEventInput = {
        type: 'checkout.price_fallback',
        applicationId: w.applicationId,
        actor: { type: 'end_user', id: w.buyer.id },
        endUserId: w.buyer.id,
        currency: 'USD',
        amount: 2000,
        occurredAt: new Date(Date.now() - 60 * 60 * 1000),
        data: {
          planSlug: 'pro',
          requested: { planPriceId: w.inrPriceId, currency: 'INR', amount: 149900 },
          charged: { planPriceId: 'pp_usd', currency: 'USD', amount: 2000 },
          reason: 'no_provider_for_currency',
          buyerCountry: 'IN',
          buyerCountrySource: 'vouched',
        },
      } as BillingEventInput;
      await recordBillingEvent(prisma, fallback);
      await recordBillingEvent(prisma, fallback);
      const ctx = await ownerOf(w);
      const summary = await ok<{ total: number; groups: Array<Record<string, unknown>> }>(ctx, 'list_price_fallbacks', {
        applicationId: w.applicationId,
      });
      expect(summary.total).toBe(2);
      expect(summary.groups).toMatchObject([{ planSlug: 'pro', requestedCurrency: 'INR', chargedCurrency: 'USD', country: 'IN', count: 2 }]);

      const tooLong = await call(ctx, 'list_price_fallbacks', {
        applicationId: w.applicationId,
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });
      expect(tooLong).toMatchObject({ isError: true, data: { code: 'BILLING_LOG_PERIOD_INVALID' } });
    });

    it('a read tool is closed to another workspace and to a member without billing:read', async () => {
      const theirs = await twoCurrencyWorld(app);
      const payment = await usdPayment();
      const argsOf = (name: string, applicationId: string): Record<string, unknown> => ({
        applicationId,
        ...(name === 'preview_checkout_routing' && { country: 'IN' }),
        ...((name === 'list_payment_refunds' || name === 'get_payment') && { paymentId: payment.id }),
      });
      const stranger = await ownerOf(theirs);
      const member = await ownerOf(w, { role: 'MEMBER', scopes: new Set<Scope>(['overview:read', 'end-users:read']) });
      for (const name of READ_TOOLS) {
        const outside = await call(stranger, name, argsOf(name, w.applicationId));
        expect(outside, name).toMatchObject({ isError: true, data: { code: 'APPLICATION_NOT_FOUND' } });

        const unscoped = await call(member, name, argsOf(name, w.applicationId));
        expect(unscoped.isError, name).toBe(true);
        expect(String(unscoped.data.error), name).toContain("'billing:read' scope");

        const mine = await call(await ownerOf(w, { canWrite: false, canAdmin: false }), name, argsOf(name, w.applicationId));
        expect(mine.isError, `${name}: ${JSON.stringify(mine.data)}`).toBe(false);
      }
    });
  });

  describe('writes', () => {
    beforeEach(async () => {
      await ok(await ownerOf(w), 'create_coupon', {
        applicationId: w.applicationId,
        code: 'WELCOME',
        discountType: 'PERCENT',
        basisPoints: 1000,
      });
    });

    it.each(WRITE_CALLS)('%s is refused without the write scope, below ADMIN, and for another workspace', async (name, args) => {
      const before = await prisma.billingEvent.count({ where: { applicationId: w.applicationId } });

      const readOnly = await call(await ownerOf(w, { canWrite: false, canAdmin: false }), name, { applicationId: w.applicationId, ...args });
      expect(readOnly.isError).toBe(true);
      expect(String(readOnly.data.error)).toContain('mcp:operator:write');

      const member = await call(await ownerOf(w, { role: 'MEMBER' }), name, { applicationId: w.applicationId, ...args });
      expect(member.isError).toBe(true);
      expect(String(member.data.error)).toContain('ADMIN role');

      const stranger = await call(await ownerOf(await twoCurrencyWorld(app)), name, { applicationId: w.applicationId, ...args });
      expect(stranger).toMatchObject({ isError: true, data: { code: 'APPLICATION_NOT_FOUND' } });

      expect(await prisma.billingEvent.count({ where: { applicationId: w.applicationId } })).toBe(before);

      const owner = await call(await ownerOf(w, { canAdmin: false }), name, { applicationId: w.applicationId, ...args });
      expect(owner.isError, JSON.stringify(owner.data)).toBe(false);
    });

    it('create_plan takes its default price as `price`, refuses the removed fields, and returns the plan priced', async () => {
      const ctx = await ownerOf(w);
      const base = { applicationId: w.applicationId, slug: 'team', name: 'Team' };
      for (const [field, value] of [['amount', 4900], ['currency', 'USD'], ['pricePerUnitCents', 2]] as const) {
        const refused = await call(ctx, 'create_plan', { ...base, [field]: value });
        expect(refused, field).toMatchObject({ isError: true, data: { code: 'BILLING_FIELD_REMOVED' } });
        expect(String(refused.data.fix), field).toMatch(field === 'pricePerUnitCents' ? /meterSlug/ : /`price`/);
      }
      expect(await prisma.plan.count({ where: { applicationId: w.applicationId, slug: 'team' } })).toBe(0);

      const team = await ok<Record<string, unknown>>(ctx, 'create_plan', { ...base, price: { currency: 'eur', amount: 4900 } });
      expect(team).toMatchObject({
        slug: 'team',
        kind: 'SUBSCRIPTION',
        isFree: false,
        price: { currency: 'EUR', amount: 4900, isDefault: true },
        prices: [{ currency: 'EUR', amount: 4900, isDefault: true }],
      });
      for (const removed of ['amount', 'currency', 'pricePerUnitCents']) expect(team, removed).not.toHaveProperty(removed);
      const [set] = (await logged('plan.price_set')).filter((event) => event.planId === team.id);
      expect(set).toMatchObject({ actorType: 'OPERATOR', actorId: ctx.tenantUserId, currency: 'EUR', amount: 4900 });

      const free = await ok<Record<string, unknown>>(ctx, 'create_plan', { applicationId: w.applicationId, slug: 'hobby', name: 'Hobby' });
      expect(free).toMatchObject({ isFree: true, price: null, prices: [] });

      const zero = await call(ctx, 'create_plan', { ...base, slug: 'zero', price: { currency: 'USD', amount: 0 } });
      expect(zero).toMatchObject({ isError: true, data: { code: 'VALIDATION_ERROR' } });
    });

    it('set_plan_price adds and updates a price, remove_plan_price takes it off sale, and both name the operator in the log', async () => {
      const ctx = await ownerOf(w);
      const added = await ok<{ price: Record<string, unknown> }>(ctx, 'set_plan_price', {
        applicationId: w.applicationId,
        planSlug: 'pro',
        currency: 'eur',
        amount: 1800,
        countries: ['de', 'fr'],
      });
      expect(added.price).toMatchObject({ currency: 'EUR', amount: 1800, countries: ['DE', 'FR'], isDefault: false, archived: false });
      expect(added.price.id).toEqual(expect.any(String));
      expect(added.price).toHaveProperty('registration');

      // Countries alone: the amount is not asked for again.
      const moved = await ok<{ price: Record<string, unknown> }>(ctx, 'set_plan_price', {
        applicationId: w.applicationId,
        planSlug: 'pro',
        currency: 'EUR',
        countries: ['DE'],
      });
      expect(moved.price).toMatchObject({ id: added.price.id, amount: 1800, countries: ['DE'] });

      const own = await call(ctx, 'set_plan_price', { applicationId: w.applicationId, planSlug: 'pro', currency: 'USD', amount: 100 });
      expect(own).toMatchObject({ isError: true, data: { code: 'PLAN_PRICE_IS_DEFAULT' } });

      const removed = await ok(ctx, 'remove_plan_price', { applicationId: w.applicationId, planSlug: 'pro', currency: 'eur' });
      expect(removed).toEqual({ planSlug: 'pro', currency: 'EUR', removed: true });

      const sets = (await logged('plan.price_set')).filter((event) => event.currency === 'EUR');
      expect(sets.map((event) => [event.actorType, event.actorId, event.amount])).toEqual([
        ['OPERATOR', ctx.tenantUserId, 1800],
        ['OPERATOR', ctx.tenantUserId, 1800],
      ]);
      expect(await logged('plan.price_archived')).toMatchObject([{ actorType: 'OPERATOR', actorId: ctx.tenantUserId, currency: 'EUR' }]);
    });

    it('update_coupon sets and removes the end date and the caps, refuses a cap below what is redeemed, and logs the operator', async () => {
      const ctx = await ownerOf(w);
      const base = { applicationId: w.applicationId, code: 'WELCOME' };
      const end = '2027-01-31T23:59:59.000Z';
      expect(await ok(ctx, 'update_coupon', { ...base, endsAt: end, maxRedemptions: 5, maxRedemptionsPerUser: 1 })).toMatchObject({
        endsAt: end,
        maxRedemptions: 5,
        maxRedemptionsPerUser: 1,
      });
      expect((await w.checkout({ couponCode: 'WELCOME' })).statusCode).toBe(200);
      expect((await w.checkout({ couponCode: 'WELCOME' }, { buyer: await w.newBuyer() })).statusCode).toBe(200);

      const refused = await call(ctx, 'update_coupon', { ...base, maxRedemptions: 1 });
      expect(refused).toMatchObject({ isError: true, data: { code: 'COUPON_LIMIT_BELOW_REDEEMED' } });
      expect(String(refused.data.fix)).toContain('`maxRedemptions` of 2 or more, or null for no cap');
      expect(await ok(ctx, 'update_coupon', { ...base, endsAt: null, maxRedemptions: 2, maxRedemptionsPerUser: null })).toMatchObject({
        endsAt: null,
        maxRedemptions: 2,
        maxRedemptionsPerUser: null,
      });
      expect(await logged('coupon.changed')).toMatchObject([
        { actorType: 'OPERATOR', actorId: ctx.tenantUserId, data: { after: { endsAt: end, maxRedemptions: 5, maxRedemptionsPerUser: 1 } } },
        { actorType: 'OPERATOR', actorId: ctx.tenantUserId, data: { after: { endsAt: null, maxRedemptions: 2, maxRedemptionsPerUser: null } } },
      ]);
      const schema = allOperatorTools.find((tool) => tool.name === 'update_coupon')!.inputSchema;
      expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['endsAt', 'maxRedemptions', 'maxRedemptionsPerUser']));
    });

    it('create_coupon and update_coupon carry an amount per currency, and list_coupons shows where each works', async () => {
      const ctx = await ownerOf(w);
      const base = { applicationId: w.applicationId };
      const removed = await call(ctx, 'create_coupon', { ...base, code: 'OLD', discountType: 'AMOUNT', amountOff: 500, currency: 'USD' });
      expect(removed).toMatchObject({ isError: true, data: { code: 'BILLING_FIELD_REMOVED' } });

      const fixed = await ok<Record<string, unknown>>(ctx, 'create_coupon', {
        ...base,
        code: 'FIVEOFF',
        discountType: 'AMOUNT',
        amounts: [
          { currency: 'USD', amountOff: 500 },
          { currency: 'INR', amountOff: 40000 },
        ],
      });
      expect(fixed).toMatchObject({
        code: 'fiveoff',
        discountType: 'AMOUNT',
        basisPoints: null,
        amounts: [
          { currency: 'INR', amountOff: 40000 },
          { currency: 'USD', amountOff: 500 },
        ],
        currencies: [],
        coveredCurrencies: ['INR', 'USD'],
      });
      for (const gone of ['amountOff', 'currency']) expect(fixed, gone).not.toHaveProperty(gone);

      const percent = await ok<Record<string, unknown>>(ctx, 'create_coupon', {
        ...base,
        code: 'USDONLY',
        discountType: 'PERCENT',
        basisPoints: 1500,
        currencies: ['USD'],
      });
      expect(percent).toMatchObject({ basisPoints: 1500, amounts: [], currencies: ['USD'], coveredCurrencies: ['USD'] });

      const outOfRange = await call(ctx, 'create_coupon', { ...base, code: 'TOOMUCH', discountType: 'PERCENT', basisPoints: 20000 });
      expect(outOfRange).toMatchObject({ isError: true, data: { code: 'COUPON_AMOUNT_INVALID' } });

      const changed = await ok<Record<string, unknown>>(ctx, 'update_coupon', {
        ...base,
        code: 'FIVEOFF',
        amounts: [{ currency: 'USD', amountOff: 700 }],
      });
      expect(changed).toMatchObject({ amounts: [{ currency: 'USD', amountOff: 700 }], coveredCurrencies: ['USD'] });

      const { coupons, total } = await ok<{ coupons: Array<Record<string, unknown>>; total: number }>(ctx, 'list_coupons', base);
      expect(total).toBe(3);
      expect(coupons.find((coupon) => coupon.code === 'welcome')).toMatchObject({
        basisPoints: 1000,
        coveredCurrencies: null,
        redemptionCount: 0,
        discountIssuedByCurrency: [],
      });

      expect((await logged('coupon.created')).map((event) => [event.actorType, event.actorId])).toEqual(
        Array.from({ length: 3 }, () => ['OPERATOR', ctx.tenantUserId]),
      );
      expect(await logged('coupon.changed')).toMatchObject([{ actorType: 'OPERATOR', actorId: ctx.tenantUserId }]);
    });

    it('set_reporting_currency changes it once, logs before and after, and refuses a currency no plan can be priced in', async () => {
      const ctx = await ownerOf(w);
      const args = { applicationId: w.applicationId, reportingCurrency: 'eur' };
      expect(await ok(ctx, 'set_reporting_currency', args)).toEqual({ reportingCurrency: 'EUR', name: 'Euro', changed: true });
      expect(await ok(ctx, 'set_reporting_currency', args)).toMatchObject({ reportingCurrency: 'EUR', changed: false });
      expect(await ok(ctx, 'get_reporting_currency', { applicationId: w.applicationId })).toMatchObject({ reportingCurrency: 'EUR' });
      expect(await logged('settings.reporting_currency_changed')).toMatchObject([
        { actorType: 'OPERATOR', actorId: ctx.tenantUserId, data: { before: 'USD', after: 'EUR' } },
      ]);

      const refused = await call(ctx, 'set_reporting_currency', { applicationId: w.applicationId, reportingCurrency: 'KWD' });
      expect(refused).toMatchObject({ isError: true, data: { code: 'BILLING_REPORTING_CURRENCY_INVALID' } });
    });

    it('create_refund pays back part of a payment through the provider, and get_payment, list_payment_refunds and recent_payments show it', async () => {
      const issued = refundingStripe();
      const payment = await usdPayment();
      const ctx = await ownerOf(w);
      const args = { applicationId: w.applicationId, paymentId: payment.id };

      expect(await ok(ctx, 'get_payment', args)).toMatchObject({
        id: payment.id,
        amount: 2000,
        currency: 'USD',
        refundedAmount: 0,
        provider: 'stripe',
        refundable: true,
        refundBlockedReason: null,
      });

      const done = await ok<{ refund: Record<string, unknown>; payment: Record<string, unknown> }>(ctx, 'create_refund', {
        ...args,
        amount: 500,
        reason: 'goodwill',
      });
      expect(done.refund).toMatchObject({ paymentId: payment.id, amount: 500, currency: 'USD', status: 'succeeded', initiatedBy: 'operator', reason: 'goodwill' });
      expect(done.payment).toEqual({ id: payment.id, amount: 2000, currency: 'USD', refundedAmount: 500, status: 'PARTIALLY_REFUNDED' });
      expect(issued.map((sent) => [sent.providerPaymentId, sent.amount])).toEqual([[payment.providerPaymentId, 500]]);
      expect(await logged('payment.refunded')).toMatchObject([{ actorType: 'OPERATOR', actorId: ctx.tenantUserId, amount: 500, currency: 'USD' }]);

      const listed = await ok<{ refunds: Array<Record<string, unknown>>; page: Record<string, unknown> }>(ctx, 'list_payment_refunds', args);
      expect(listed).toMatchObject({ refunds: [{ id: done.refund.id, amount: 500 }], page: { total: 1, hasMore: false } });
      const { payments } = await ok<{ payments: Array<Record<string, unknown>> }>(ctx, 'recent_payments', {});
      expect(payments.find((row) => row.id === payment.id)).toMatchObject({ refundedAmount: 500, status: 'PARTIALLY_REFUNDED' });

      const over = await call(ctx, 'create_refund', { ...args, amount: 1501 });
      expect(over).toMatchObject({ isError: true, data: { code: 'BILLING_REFUND_AMOUNT_EXCEEDED' } });
      expect(issued).toHaveLength(1);

      await ok(ctx, 'create_refund', args);
      expect(await ok(ctx, 'get_payment', args)).toMatchObject({
        status: 'REFUNDED',
        refundedAmount: 2000,
        refundable: false,
        refundBlockedReason: 'already_refunded',
      });
      expect(await call(ctx, 'get_payment', { ...args, paymentId: 'pay_missing' })).toMatchObject({
        isError: true,
        data: { code: 'PAYMENT_NOT_FOUND' },
      });
    });

    it("create_refund is refused without the admin scope, below ADMIN, and for a payment or Application that is not the caller's", async () => {
      const issued = refundingStripe();
      const payment = await usdPayment();
      const args = { applicationId: w.applicationId, paymentId: payment.id };

      const writeOnly = await call(await ownerOf(w, { canAdmin: false }), 'create_refund', args);
      expect(writeOnly.isError).toBe(true);
      expect(String(writeOnly.data.error)).toContain('mcp:operator:admin');

      const readOnly = await call(await ownerOf(w, { canWrite: false, canAdmin: false }), 'create_refund', args);
      expect(readOnly.isError).toBe(true);

      const member = await call(await ownerOf(w, { role: 'MEMBER' }), 'create_refund', args);
      expect(member.isError).toBe(true);
      expect(String(member.data.error)).toContain('ADMIN role');

      const theirs = await twoCurrencyWorld(app);
      const stranger = await call(await ownerOf(theirs), 'create_refund', args);
      expect(stranger).toMatchObject({ isError: true, data: { code: 'APPLICATION_NOT_FOUND' } });
      const crossed = await call(await ownerOf(theirs), 'create_refund', { applicationId: theirs.applicationId, paymentId: payment.id });
      expect(crossed).toMatchObject({ isError: true, data: { code: 'PAYMENT_NOT_FOUND' } });

      expect(issued).toHaveLength(0);
      expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(0);
    });
  });
});
