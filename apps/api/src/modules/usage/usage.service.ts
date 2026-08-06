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
import { creditsService } from '../credits/credits.service.js';

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
    /** Credits charged per unit past the included quota. Omit to only count. */
    creditsPerUnit?: number | undefined;
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
      const { creditsPerUnit, ...rest } = args;
      return await prisma.usageMeter.create({
        data: { ...rest, ...(creditsPerUnit !== undefined && { creditsPerUnit }) },
      });
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

  /**
   * Change what a unit costs.
   *
   * Only affects usage recorded from now on: each `UsageRecord` keeps the
   * credits it was actually charged, so re-pricing a meter never restates what
   * past consumption cost. Setting it to null returns the meter to counting
   * without charging.
   */
  async setPrice(applicationId: string, slug: string, creditsPerUnit: number | null): Promise<UsageMeter> {
    if (creditsPerUnit !== null && (!Number.isInteger(creditsPerUnit) || creditsPerUnit < 0)) {
      throw new RekeyError({
        statusCode: 400,
        code: 'USAGE_METER_PRICE_INVALID',
        message: 'creditsPerUnit must be a non-negative whole number of credits, or null.',
        fix: 'Use a whole number like 1, or null to stop charging for this meter.',
      });
    }
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
    return prisma.usageMeter.update({ where: { id: meter.id }, data: { creditsPerUnit } });
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
    // Mirrors CreditBalance's subjectKey. Computed here rather than derived in
    // SQL so the value written and the value looked up cannot drift.
    const subjectKey = args.organizationId
      ? `o:${args.organizationId}`
      : args.endUserId
        ? `u:${args.endUserId}`
        : 'app';

    // A correction (negative quantity) against a priced meter would run the
    // billing arithmetic backwards and mint credits. The public route already
    // refuses negatives, but the service is callable from inside the API and
    // must not depend on its caller for that.
    // Cheap pre-check on the meter; the plan rate is resolved later, so a
    // negative against a plan-priced meter is refused there by the same rule.
    if (args.quantity < 0 && meter.creditsPerUnit != null) {
      throw new RekeyError({
        statusCode: 400,
        code: 'USAGE_NEGATIVE_ON_PRICED_METER',
        message: `Meter "${args.meterSlug}" is priced, so usage cannot be corrected by recording a negative quantity.`,
        fix: 'Refund the credits explicitly with a credits adjustment, which leaves a ledger entry saying who did it and why.',
      });
    }

    // Idempotency (BUG-2): a retried record with the same (meter, key) must NOT
    // double-count. Cheap pre-check returns the original row before any quota
    // work; the unique (meterId, idempotencyKey) constraint closes the race
    // (two concurrent first-time replays) — the loser catches P2002 below.
    if (args.idempotencyKey !== undefined) {
      const prior = await prisma.usageRecord.findUnique({
        where: {
          meterId_subjectKey_idempotencyKey: {
            meterId: meter.id,
            subjectKey,
            idempotencyKey: args.idempotencyKey,
          },
        },
      });
      if (prior) return prior;
    }

    // Hard cap (BILLING_MODEL §7): when the subject's plan bundles an included
    // quota for this meter, reject once this period's consumption would exceed
    // it. No bundled quota (uncapped meter / no plan) → record freely. App-level
    // usage (no subject) is never capped.
    // `occurredAt` is caller-supplied and decides which month's quota the
    // record lands in. Unbounded, that is a self-service discount on a priced
    // meter: exhaust this month, stamp the record into a quiet earlier month,
    // and it lands inside an unspent quota instead of costing credits.
    //
    // A small backdate is legitimate — a queue drained late, a clock a few
    // seconds off — so this clamps rather than refuses, and only for the
    // window that matters. Future timestamps are refused outright: they move
    // consumption into a quota nobody has paid for yet.
    if (args.occurredAt) {
      const now = new Date();
      if (args.occurredAt.getTime() > now.getTime() + 60_000) {
        throw new RekeyError({
          statusCode: 400,
          code: 'USAGE_OCCURRED_AT_IN_FUTURE',
          message: '`occurredAt` is in the future.',
          fix: 'Record usage as it happens, or omit `occurredAt` to use the current time.',
        });
      }
      const { start } = monthWindowUtc(now);
      if (args.occurredAt < start) {
        throw new RekeyError({
          statusCode: 400,
          code: 'USAGE_OCCURRED_AT_TOO_OLD',
          message: '`occurredAt` is before the current quota period, so it cannot be attributed to it.',
          fix: 'Record usage within the calendar month it happened in. Backfilling an earlier period needs an operator correction, not a record.',
        });
      }
    }

    const subject = args.organizationId
      ? { organizationId: args.organizationId }
      : args.endUserId
        ? { endUserId: args.endUserId }
        : null;
    const data = {
      meterId: meter.id,
      subjectKey,
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
          where: {
          meterId_subjectKey_idempotencyKey: {
            meterId: meter.id,
            subjectKey,
            idempotencyKey: args.idempotencyKey,
          },
        },
        });
        if (prior) return prior;
      }
      throw e;
    };

    if (subject) {
      const included = await entitlementsService.includedQuotaFor(args.applicationId, subject, args.meterSlug);
      // Charging requires BOTH a price and an explicitly configured quota.
      //
      // `includedQuotaFor` returns null for "no USAGE entitlement with a
      // positive quantity was found" — which is also what a subject with no
      // plan at all looks like, and what a legacy USAGE plan looks like, since
      // those synthesize `quantity: null`. Reading null as "quota of zero"
      // would start charging every one of them from the first unit, silently,
      // the moment an operator priced the meter. That is the expensive
      // direction of the ambiguity, so it is the one we refuse to take.
      //
      // An operator who wants to charge from unit one sets an explicit
      // included quota of 0 on the plan. Opting in is a sentence in the panel;
      // opting out after mis-billing is a refund run.
      if (included !== null) {
        const includedUnits = included.included;
        // The plan's rate wins; the meter's is a fallback for a subject whose
        // plan does not price this meter. Null in both means the quota is a
        // hard cap, which is what every meter did before pricing existed.
        const rate = included.creditsPerUnit ?? meter.creditsPerUnit;
        if (args.quantity < 0 && rate != null) {
          throw new RekeyError({
            statusCode: 400,
            code: 'USAGE_NEGATIVE_ON_PRICED_METER',
            message: `Meter "${args.meterSlug}" is priced for this subscriber, so usage cannot be corrected by recording a negative quantity.`,
            fix: 'Refund the credits explicitly with a credits adjustment, which leaves a ledger entry saying who did it and why.',
          });
        }
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
            const remainingIncluded = Math.max(0, includedUnits - used);
            const billable = Math.max(0, args.quantity - remainingIncluded);

            if (billable > 0) {
              // Past the quota. An unpriced meter still stops here — that was
              // the only behaviour before pricing existed, and a meter with no
              // price has no way to charge for the excess.
              if (rate == null) {
                throw new RekeyError({
                  statusCode: 402,
                  code: 'USAGE_QUOTA_EXCEEDED',
                  message: `Included quota for meter "${args.meterSlug}" exhausted: ${used}/${includedUnits} units used this period, cannot add ${args.quantity}.`,
                  fix: 'Upgrade the plan for a higher quota, wait for the next period, or price the meter in credits so usage past the quota can be paid for.',
                });
              }
              // Only the units past the quota cost anything: 10 units with 3
              // included left is 3 free and 7 charged, not 10 charged.
              // Both factors are int4-bounded; their product is not. Without
              // this the overflow surfaces as a Postgres range error, i.e. a
              // 500 on a billing call.
              const cost = billable * rate;
              if (!Number.isSafeInteger(cost) || cost > 2_147_483_647) {
                throw new RekeyError({
                  statusCode: 400,
                  code: 'USAGE_CHARGE_TOO_LARGE',
                  message: `Recording ${billable} units at ${rate} credits each exceeds the maximum chargeable amount.`,
                  fix: 'Record the usage in smaller batches, or lower the meter price.',
                });
              }
              // A rate of zero is a legitimate configuration — "metered, but
              // free" — and `consume` rejects a non-positive amount, so asking
              // it to debit nothing turns every record into a 400.
              if (cost === 0) {
                return tx.usageRecord.create({
                  data: { ...data, creditsCharged: 0, creditsPerUnitApplied: rate },
                });
              }

              // BLOCKER: the result carries `applied`, and false means the
              // ledger already had this key so NO debit happened. Stamping
              // creditsCharged on the record anyway would write a billing
              // artifact claiming money moved when it did not — and the key is
              // reachable by any caller of POST /credits/consume, which holds
              // the same `billing:write` scope. A genuine retry never reaches
              // here: the usage pre-check returns the prior record first.
              const debit = await creditsService.consume({
                applicationId: args.applicationId,
                ...subject,
                amount: cost,
                // Joins THIS transaction. A recorded unit that was not paid
                // for is the bug this whole path exists to prevent, so the
                // debit and the record commit together or not at all.
                tx,
                // Namespaced so a caller's key cannot collide with a direct
                // credits.consume using the same string.
                ...(args.idempotencyKey !== undefined && {
                  idempotencyKey: `usage:${meter.id}:${subjectKey}:${args.idempotencyKey}`,
                }),
                description: `${billable} × ${meter.slug}`,
              });
              if (!debit.applied) {
                throw new RekeyError({
                  statusCode: 409,
                  code: 'USAGE_IDEMPOTENCY_KEY_REUSED',
                  message: `The idempotency key for this record was already used against the credit ledger, so the charge could not be applied.`,
                  fix: 'Use a fresh idempotency key for this usage record. Keys are namespaced per meter, so this means the key was already spent by a direct credits call.',
                });
              }
              return tx.usageRecord.create({
                data: { ...data, creditsCharged: cost, creditsPerUnitApplied: rate },
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
