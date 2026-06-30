/**
 * Credits service — prepaid balance + append-only ledger.
 *
 * The "lead pack / pay-as-you-go" model: a buyer purchases a CREDIT-kind plan
 * (or a CREDIT entitlement) and the customer's app draws the balance down per
 * unit consumed.
 *
 * Billing subject (ORG_BILLING.md): a balance belongs to EITHER an end-user OR
 * an organization (a shared team pool). Rows carry nullable `endUserId` +
 * `organizationId` and a non-null `subjectKey` ("u:<id>" | "o:<id>") used for
 * the unique + all lookups (sidesteps Prisma's nullable-compound-unique).
 *
 * Correctness:
 *   - Never overspend — guarded atomic `UPDATE … WHERE balance >= need`.
 *   - Idempotent — `(applicationId, idempotencyKey)` unique on the ledger.
 */

import type { Prisma, PrismaClient, CreditReason } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RelipayError } from '../../lib/error.js';

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

/** A credit subject — exactly one of endUserId / organizationId. */
export interface CreditSubjectInput {
  endUserId?: string | null;
  organizationId?: string | null;
}

interface ResolvedSubject {
  endUserId: string | null;
  organizationId: string | null;
  subjectKey: string;
}

export function resolveCreditSubject(input: CreditSubjectInput): ResolvedSubject {
  if (input.organizationId) {
    return { endUserId: null, organizationId: input.organizationId, subjectKey: `o:${input.organizationId}` };
  }
  if (input.endUserId) {
    return { endUserId: input.endUserId, organizationId: null, subjectKey: `u:${input.endUserId}` };
  }
  throw new RelipayError({
    statusCode: 400,
    code: 'CREDITS_SUBJECT_REQUIRED',
    message: 'A credit subject (endUserId or organizationId) is required.',
    fix: 'Pass endUserId for a personal balance, or organizationId for an org pool.',
  });
}

interface ApplyDeltaInput extends CreditSubjectInput {
  applicationId: string;
  /** Signed change: positive adds, negative debits. */
  delta: number;
  reason: CreditReason;
  idempotencyKey?: string | undefined;
  description?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ApplyDeltaResult {
  balance: number;
  entryId: string;
  applied: boolean;
}

const INSUFFICIENT = (need: number, have: number): RelipayError =>
  new RelipayError({
    statusCode: 402,
    code: 'CREDITS_INSUFFICIENT',
    message: `Not enough credits: need ${need}, balance ${have}.`,
    fix: 'Buy a credit pack (CREDIT plan/entitlement), or grant credits from the panel.',
  });

async function applyDelta(input: ApplyDeltaInput): Promise<ApplyDeltaResult> {
  const subject = resolveCreditSubject(input);
  const balanceWhere = {
    applicationId_subjectKey: { applicationId: input.applicationId, subjectKey: subject.subjectKey },
  };

  const run = async (tx: Prisma.TransactionClient): Promise<ApplyDeltaResult> => {
    if (input.idempotencyKey) {
      const prior = await tx.creditLedger.findUnique({
        where: {
          applicationId_idempotencyKey: {
            applicationId: input.applicationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (prior) return { balance: prior.balanceAfter, entryId: prior.id, applied: false };
    }

    let balanceAfter: number;
    if (input.delta >= 0) {
      const bal = await tx.creditBalance.upsert({
        where: balanceWhere,
        create: {
          applicationId: input.applicationId,
          endUserId: subject.endUserId,
          organizationId: subject.organizationId,
          subjectKey: subject.subjectKey,
          balance: input.delta,
        },
        update: { balance: { increment: input.delta } },
      });
      balanceAfter = bal.balance;
    } else {
      const need = -input.delta;
      // Atomic guarded debit — prevents lost-update overspend.
      const res = await tx.creditBalance.updateMany({
        where: { applicationId: input.applicationId, subjectKey: subject.subjectKey, balance: { gte: need } },
        data: { balance: { decrement: need } },
      });
      if (res.count === 0) {
        const existing = await tx.creditBalance.findUnique({ where: balanceWhere });
        throw INSUFFICIENT(need, existing?.balance ?? 0);
      }
      const bal = await tx.creditBalance.findUniqueOrThrow({ where: balanceWhere });
      balanceAfter = bal.balance;
    }

    const entry = await tx.creditLedger.create({
      data: {
        applicationId: input.applicationId,
        endUserId: subject.endUserId,
        organizationId: subject.organizationId,
        subjectKey: subject.subjectKey,
        delta: input.delta,
        reason: input.reason,
        balanceAfter,
        idempotencyKey: input.idempotencyKey ?? null,
        description: input.description ?? null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
    return { balance: balanceAfter, entryId: entry.id, applied: true };
  };

  try {
    return await prisma.$transaction(run);
  } catch (e) {
    if (isUniqueViolation(e) && input.idempotencyKey) {
      const prior = await prisma.creditLedger.findUnique({
        where: {
          applicationId_idempotencyKey: {
            applicationId: input.applicationId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (prior) return { balance: prior.balanceAfter, entryId: prior.id, applied: false };
    }
    throw e;
  }
}

export const creditsService = {
  /** Current balance for a subject (0 when none). */
  async getBalance(applicationId: string, subject: CreditSubjectInput): Promise<number> {
    const { subjectKey } = resolveCreditSubject(subject);
    const row = await prisma.creditBalance.findUnique({
      where: { applicationId_subjectKey: { applicationId, subjectKey } },
    });
    return row?.balance ?? 0;
  },

  /** Draw down credits. Throws CREDITS_INSUFFICIENT (402) if too low. */
  async consume(input: CreditSubjectInput & {
    applicationId: string;
    amount: number;
    idempotencyKey?: string | undefined;
    description?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ApplyDeltaResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new RelipayError({
        statusCode: 400,
        code: 'CREDITS_AMOUNT_INVALID',
        message: 'Consume amount must be a positive integer.',
        fix: 'Pass a whole number of credits > 0.',
      });
    }
    return applyDelta({
      applicationId: input.applicationId,
      ...(input.endUserId != null && { endUserId: input.endUserId }),
      ...(input.organizationId != null && { organizationId: input.organizationId }),
      delta: -input.amount,
      reason: 'CONSUME',
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      metadata: input.metadata,
    });
  },

  /** Operator-issued change (top-up, refund, correction). */
  async grant(input: CreditSubjectInput & {
    applicationId: string;
    amount: number;
    reason: Extract<CreditReason, 'GRANT' | 'REFUND' | 'ADJUST'>;
    idempotencyKey?: string | undefined;
    description?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ApplyDeltaResult> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new RelipayError({
        statusCode: 400,
        code: 'CREDITS_AMOUNT_INVALID',
        message: 'Grant amount must be a non-zero integer.',
        fix: 'Positive to add; negative with reason ADJUST to remove.',
      });
    }
    return applyDelta({
      applicationId: input.applicationId,
      ...(input.endUserId != null && { endUserId: input.endUserId }),
      ...(input.organizationId != null && { organizationId: input.organizationId }),
      delta: input.amount,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      metadata: input.metadata,
    });
  },

  /** Grant credits from a paid purchase / entitlement. Idempotent on paymentRef. */
  async grantFromPurchase(input: CreditSubjectInput & {
    applicationId: string;
    amount: number;
    paymentRef: string;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<ApplyDeltaResult> {
    return applyDelta({
      applicationId: input.applicationId,
      ...(input.endUserId != null && { endUserId: input.endUserId }),
      ...(input.organizationId != null && { organizationId: input.organizationId }),
      delta: input.amount,
      reason: 'PURCHASE',
      idempotencyKey: `purchase:${input.paymentRef}`,
      description: 'Credit pack purchase',
      metadata: input.metadata,
    });
  },

  /**
   * Ledger entries for a subject, newest first. `offset` pages back through the
   * full append-only history (the table grows for the life of a subject), so a
   * caller can build a complete transaction view, not just the most recent window.
   */
  async listLedger(
    applicationId: string,
    subject: CreditSubjectInput,
    opts: { limit?: number; offset?: number } = {},
  ) {
    const { subjectKey } = resolveCreditSubject(subject);
    return prisma.creditLedger.findMany({
      where: { applicationId, subjectKey },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      skip: Math.max(opts.offset ?? 0, 0),
    });
  },
};

// Re-exported for tests / callers that need the low-level primitive.
export type CreditsServiceClient = PrismaClient;
