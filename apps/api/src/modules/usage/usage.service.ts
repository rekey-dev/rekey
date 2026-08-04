/**
 * Usage tracking — meters + records.
 *
 * A `UsageMeter` is a named counter scoped to an Application
 * ("api_calls", "storage_gb_hours"). The customer's app reports
 * increments via POST /api/v1/usage/record. We aggregate via SUM on read.
 *
 * `record` DOES enforce the subject's plan-included quota synchronously, via
 * `entitlementsService` — over the allowance it rejects with 402
 * `USAGE_QUOTA_EXCEEDED` rather than recording. What is still absent is
 * *overage invoicing*: nothing bills for consumption beyond the included quota,
 * so metered pricing means "cap and refuse", not "charge for what you used".
 */

import type { UsageMeter, UsageRecord } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { entitlementsService } from '../billing/entitlements.service.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

/**
 * Enforcement window for an included usage quota: the **calendar month (UTC)**
 * of the record's timestamp. Chosen over the subscription billing period for
 * the MVP — predictable for customers ("10k calls/month"), provider-agnostic,
 * and needs no per-sub period bookkeeping. Returns [start, end).
 */
function monthWindowUtc(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

export const usageService = {
  async listMeters(
    applicationId: string,
    opts?: { take?: number; skip?: number },
  ): Promise<UsageMeter[]> {
    return prisma.usageMeter.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'asc' },
      ...(opts?.take !== undefined ? { take: opts.take } : {}),
      ...(opts?.skip !== undefined ? { skip: opts.skip } : {}),
    });
  },

  /** Total usage meters on this Application, ignoring take/skip. */
  async countMeters(applicationId: string): Promise<number> {
    return prisma.usageMeter.count({ where: { applicationId } });
  },

  async createMeter(args: {
    applicationId: string;
    slug: string;
    name: string;
    unit: string;
  }): Promise<UsageMeter> {
    if (!SLUG_RE.test(args.slug)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'USAGE_METER_SLUG_INVALID',
        message: `Meter slug "${args.slug}" must be lowercase alphanumerics + - / _.`,
        fix: 'Use a slug like "api_calls" or "storage-gb-hours".',
      });
    }
    try {
      return await prisma.usageMeter.create({ data: args });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new RekeyError({
          statusCode: 409,
          code: 'USAGE_METER_SLUG_TAKEN',
          message: `A meter with slug "${args.slug}" already exists.`,
          fix: 'Pick a different slug.',
        });
      }
      throw e;
    }
  },

  async setActive(applicationId: string, slug: string, active: boolean): Promise<UsageMeter> {
    const meter = await prisma.usageMeter.findUnique({
      where: { applicationId_slug: { applicationId, slug } },
    });
    if (!meter) {
      throw new RekeyError({
        statusCode: 404,
        code: 'USAGE_METER_NOT_FOUND',
        message: `Meter "${slug}" not found.`,
        fix: 'List meters with GET …/usage-meters.',
      });
    }
    return prisma.usageMeter.update({ where: { id: meter.id }, data: { active } });
  },

  /**
   * Hard-delete a meter. Cascades to UsageRecords. Operators should usually
   * archive (setActive(false)) instead — delete is for cleanup of meters
   * that were created in error and have no production traffic.
   */
  async remove(applicationId: string, slug: string): Promise<void> {
    const meter = await prisma.usageMeter.findUnique({
      where: { applicationId_slug: { applicationId, slug } },
    });
    if (!meter) {
      throw new RekeyError({
        statusCode: 404,
        code: 'USAGE_METER_NOT_FOUND',
        message: `Meter "${slug}" not found.`,
        fix: 'List meters with GET …/usage-meters.',
      });
    }
    await prisma.usageMeter.delete({ where: { id: meter.id } });
  },

  async record(args: {
    applicationId: string;
    meterSlug: string;
    quantity: number;
    endUserId?: string | undefined;
    organizationId?: string | undefined;
    occurredAt?: Date | undefined;
    metadata?: Record<string, unknown> | undefined;
    /**
     * OPTIONAL idempotency key (mirrors credits.consume). A retried record with
     * the same (meter, key) returns the original row instead of double-counting
     * usage / wrongly tripping the included-quota cap. Omitted → each call counts.
     */
    idempotencyKey?: string | undefined;
  }): Promise<UsageRecord> {
    const meter = await prisma.usageMeter.findUnique({
      where: { applicationId_slug: { applicationId: args.applicationId, slug: args.meterSlug } },
    });
    if (!meter) {
      throw new RekeyError({
        statusCode: 404,
        code: 'USAGE_METER_NOT_FOUND',
        message: `Meter "${args.meterSlug}" not found in this application.`,
        fix: 'Create the meter first via the admin panel or POST /tenant/applications/:id/usage-meters.',
      });
    }
    if (!meter.active) {
      throw new RekeyError({
        statusCode: 400,
        code: 'USAGE_METER_INACTIVE',
        message: `Meter "${args.meterSlug}" is currently inactive — records are not accepted.`,
        fix: 'Reactivate the meter, or report against a different one.',
      });
    }
    // Idempotency (BUG-2): a retried record with the same (meter, key) must NOT
    // double-count. Cheap pre-check returns the original row before any quota
    // work; the unique (meterId, idempotencyKey) constraint closes the race
    // (two concurrent first-time replays) — the loser catches P2002 below.
    if (args.idempotencyKey !== undefined) {
      const prior = await prisma.usageRecord.findUnique({
        where: { meterId_idempotencyKey: { meterId: meter.id, idempotencyKey: args.idempotencyKey } },
      });
      if (prior) return prior;
    }

    // Hard cap (BILLING_MODEL §7): when the subject's plan bundles an included
    // quota for this meter, reject once this period's consumption would exceed
    // it. No bundled quota (uncapped meter / no plan) → record freely. App-level
    // usage (no subject) is never capped.
    const subject = args.organizationId
      ? { organizationId: args.organizationId }
      : args.endUserId
        ? { endUserId: args.endUserId }
        : null;
    const data = {
      meterId: meter.id,
      quantity: args.quantity,
      ...(args.endUserId !== undefined && { endUserId: args.endUserId }),
      ...(args.organizationId !== undefined && { organizationId: args.organizationId }),
      ...(args.occurredAt !== undefined && { occurredAt: args.occurredAt }),
      ...(args.metadata !== undefined && { metadata: args.metadata as never }),
      ...(args.idempotencyKey !== undefined && { idempotencyKey: args.idempotencyKey }),
    };

    // On a concurrent first-time replay the unique (meterId, idempotencyKey)
    // fires P2002 for the loser — resolve it to the winning row so the caller
    // still gets the idempotent result instead of a 500.
    const onConflictReturnExisting = async (e: unknown): Promise<UsageRecord> => {
      if (args.idempotencyKey !== undefined && (e as { code?: string }).code === 'P2002') {
        const prior = await prisma.usageRecord.findUnique({
          where: { meterId_idempotencyKey: { meterId: meter.id, idempotencyKey: args.idempotencyKey } },
        });
        if (prior) return prior;
      }
      throw e;
    };

    if (subject) {
      const included = await entitlementsService.includedQuotaFor(args.applicationId, subject, args.meterSlug);
      if (included !== null) {
        const { start, end } = monthWindowUtc(args.occurredAt ?? new Date());
        // Check + insert must be atomic: two concurrent records could both
        // read a pre-insert SUM and together blow past the hard cap. Take a
        // row-level lock on the meter (same pattern as licenses.service.ts
        // verify) so concurrent records against the same meter serialise;
        // records against other meters proceed in parallel.
        return prisma
          .$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM usage_meters WHERE id = ${meter.id} FOR UPDATE`;
            const agg = await tx.usageRecord.aggregate({
              _sum: { quantity: true },
              where: { meterId: meter.id, ...subject, occurredAt: { gte: start, lt: end } },
            });
            const used = agg._sum.quantity ?? 0;
            if (used + args.quantity > included) {
              throw new RekeyError({
                statusCode: 402,
                code: 'USAGE_QUOTA_EXCEEDED',
                message: `Included quota for meter "${args.meterSlug}" exhausted: ${used}/${included} units used this period, cannot add ${args.quantity}.`,
                fix: 'Upgrade the plan for a higher quota, or wait for the next period. (Overage billing is not yet available.)',
              });
            }
            return tx.usageRecord.create({ data });
          })
          .catch(onConflictReturnExisting);
      }
    }
    return prisma.usageRecord.create({ data }).catch(onConflictReturnExisting);
  },

  /**
   * Sum recorded quantity for a meter over an optional time window.
   * Defaults: from = beginning of time, to = now.
   */
  async aggregate(args: {
    applicationId: string;
    meterSlug: string;
    from?: Date;
    to?: Date;
    endUserId?: string;
    organizationId?: string;
  }): Promise<{ total: number; count: number }> {
    const meter = await prisma.usageMeter.findUnique({
      where: { applicationId_slug: { applicationId: args.applicationId, slug: args.meterSlug } },
    });
    if (!meter) {
      throw new RekeyError({
        statusCode: 404,
        code: 'USAGE_METER_NOT_FOUND',
        message: `Meter "${args.meterSlug}" not found.`,
        fix: 'List meters to see what exists.',
      });
    }
    const result = await prisma.usageRecord.aggregate({
      _sum: { quantity: true },
      _count: true,
      where: {
        meterId: meter.id,
        ...(args.endUserId !== undefined && { endUserId: args.endUserId }),
        ...(args.organizationId !== undefined && { organizationId: args.organizationId }),
        ...(args.from !== undefined && { occurredAt: { gte: args.from } }),
        ...(args.to !== undefined && {
          occurredAt: { ...(args.from !== undefined && { gte: args.from }), lte: args.to },
        }),
      },
    });
    return {
      total: result._sum.quantity ?? 0,
      count: result._count,
    };
  },
};
