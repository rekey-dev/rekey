/**
 * The published OpenAPI document is generated from these schemas, and a field
 * reaches it with a description only when the schema carries one
 * (`.describe()`). A JSDoc comment is for the editor and does not travel.
 * This walks every money model response schema and fails on a field that
 * would be published undocumented.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BillingLogEntrySchema,
  BillingLogPageSchema,
  BillingOutboxStatusSchema,
  BillingProviderInfoDtoSchema,
  BillingStatsDtoSchema,
  CheckoutResultDtoSchema,
  CouponDtoSchema,
  CouponWithStatsDtoSchema,
  PlanDtoSchema,
  PlanPriceDtoSchema,
  PriceFallbackSummarySchema,
  ProvidersListDtoSchema,
  PublicCouponDtoSchema,
  PublicPlanDtoSchema,
  ReconciliationReportSchema,
  RefundDtoSchema,
  RefundResultDtoSchema,
  ReportingCurrencyDtoSchema,
  RoutingPreviewDtoSchema,
  TenantPaymentDtoSchema,
  ValidateCouponResultDtoSchema,
} from '../src/index.js';

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  Plan: PlanDtoSchema,
  PlanPrice: PlanPriceDtoSchema,
  PublicPlan: PublicPlanDtoSchema,
  CheckoutResult: CheckoutResultDtoSchema,
  Coupon: CouponDtoSchema,
  CouponWithStats: CouponWithStatsDtoSchema,
  PublicCoupon: PublicCouponDtoSchema,
  ValidateCouponResult: ValidateCouponResultDtoSchema,
  BillingProviderInfo: BillingProviderInfoDtoSchema,
  ProvidersList: ProvidersListDtoSchema,
  Payment: TenantPaymentDtoSchema,
  Refund: RefundDtoSchema,
  RefundResult: RefundResultDtoSchema,
  BillingStats: BillingStatsDtoSchema,
  BillingLogPage: BillingLogPageSchema,
  BillingLogEntry: BillingLogEntrySchema,
  BillingOutboxStatus: BillingOutboxStatusSchema,
  PriceFallbackSummary: PriceFallbackSummarySchema,
  ReconciliationReport: ReconciliationReportSchema,
  ReportingCurrency: ReportingCurrencyDtoSchema,
  RoutingPreview: RoutingPreviewDtoSchema,
};

/**
 * Fields exempt from carrying a description: those whose meaning is their
 * name, and a log entry's `data`, whose schema cannot be described without
 * the compiler refusing to emit the entry type (see `entrySchema`).
 */
const SELF_EXPLANATORY = new Set(['id', 'createdAt', 'updatedAt', 'data']);

/** Not walked into: free-form bags, and shapes with their own component. */
const OPAQUE = new Set(['data', 'metadata', 'subscription', 'warnings', 'capabilities']);

function describedSomewhere(schema: z.ZodTypeAny): boolean {
  let current: z.ZodTypeAny | undefined = schema;
  while (current) {
    if (current.description) return true;
    const def = current._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny };
    current = def.innerType ?? def.schema;
  }
  return false;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    const def = current._def as { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny; typeName?: string };
    if (def.innerType) current = def.innerType;
    else if (def.schema) current = def.schema;
    else if (def.typeName === 'ZodArray' && def.type) current = def.type;
    else return current;
  }
}

function undocumented(schema: z.ZodTypeAny, path: string, seen = new Set<z.ZodTypeAny>()): string[] {
  const inner = unwrap(schema);
  if (seen.has(inner)) return [];
  seen.add(inner);
  if (inner instanceof z.ZodDiscriminatedUnion) {
    const options = [...(inner.options as z.ZodTypeAny[])];
    // One variant stands for all: the envelope is the same object spread into each.
    return options.length > 0 ? undocumented(options[0]!, path, seen) : [];
  }
  if (!(inner instanceof z.ZodObject)) return [];
  const missing: string[] = [];
  for (const [key, field] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
    const at = `${path}.${key}`;
    if (!SELF_EXPLANATORY.has(key) && !describedSomewhere(field)) missing.push(at);
    if (!OPAQUE.has(key)) missing.push(...undocumented(field, at, seen));
  }
  return missing;
}

describe('money model response schemas', () => {
  it.each(Object.entries(SCHEMAS))('%s publishes no undocumented field', (name, schema) => {
    expect(undocumented(schema, name)).toEqual([]);
  });
});
