/**
 * The money rows of the super-admin billing lists. The API types its answers
 * with these and the admin dashboard checks its own row types against them,
 * so neither side can change a money field alone.
 */

import { z } from 'zod';

/** One row of `GET /api/v1/admin/metrics/payments`. */
export const AdminPaymentRowDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  applicationSlug: z.string(),
  endUserId: z.string().nullable(),
  /** Smallest unit of `currency`. */
  amount: z.number().int(),
  currency: z.string(),
  status: z.string(),
  /** The sum of this payment's refunds that have not failed. 0 when nothing was refunded. */
  refundedAmount: z.number().int(),
  /** `unverified` for a charge recorded and not applied. It is in no revenue figure. */
  verification: z.enum(['verified', 'unverified']),
  createdAt: z.string(),
});
export type AdminPaymentRowDto = z.infer<typeof AdminPaymentRowDtoSchema>;

/** One row of `GET /api/v1/admin/metrics/subscriptions`. */
export const AdminSubscriptionRowDtoSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  applicationSlug: z.string(),
  endUserId: z.string(),
  planSlug: z.string(),
  planName: z.string(),
  status: z.string(),
  /** The subscription's own currency, upper-case. Null when it has no price of its own. */
  currency: z.string().nullable(),
  /** The subscription's own price, smallest unit of `currency`. Null when it has none. */
  amount: z.number().int().nullable(),
  interval: z.string(),
  createdAt: z.string(),
  currentPeriodEnd: z.string().nullable(),
});
export type AdminSubscriptionRowDto = z.infer<typeof AdminSubscriptionRowDtoSchema>;
