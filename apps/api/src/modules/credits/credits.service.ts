/**
 * Credits service, prepaid balance + append-only ledger.
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
 *   - Never overspend, guarded atomic `UPDATE … WHERE balance >= need`.
 *   - Idempotent PER SUBJECT, `(applicationId, subjectKey, idempotencyKey)`
 *     unique on the ledger. The subject is in the key because a client-supplied
 *     idempotency key names what is being paid for, not who is paying (#492).
 *   - Every new ledger entry enqueues one `credit.*` webhook in the same
 *     transaction (`creditEventType`), so the event exists exactly when the
 *     entry does. A replay or a refused debit writes no entry and no event.
 */

import type { Prisma, PrismaClient, CreditReason, CreditLedger } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import type { WebhookEventType } from '../webhooks/events.js';

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

/** A credit subject, exactly one of endUserId / organizationId. */
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
  throw new RekeyError({
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
  /**
   * Join a transaction the caller already has open, instead of opening one.
   *
   * Needed because Prisma has no nested interactive transactions: a caller
   * that must succeed or fail *together* with the debit, usage recording
   * against a priced meter, where a recorded unit that was not paid for is
   * exactly the bug, cannot call this from inside its own `$transaction`
   * without it hanging or committing separately.
   *
   * The caller owns the rollback. Note the idempotency fallback below is
   * skipped in this mode: recovering from a unique violation requires a
   * *fresh* connection, and the caller's transaction is already poisoned by
   * the time we would look.
   */
  tx?: Prisma.TransactionClient | undefined;
  /**
   * With `tx`: receives the ids of the webhook delivery rows written in the
   * caller's transaction, to hand to `kickDeliveries` once it commits. Without
   * it the rows still go out, from the delivery poller, only later.
   */
  onDeliveries?: ((deliveryIds: string[]) => void) | undefined;
  /**
   * Runs inside the ledger write's transaction, after a NEW entry is written
   * (never for a replay). A throw rolls the entry back. For a record that must
   * exist exactly when the entry does, like the audit row of a key grant.
   */
  afterEntry?: ((tx: Prisma.TransactionClient, entry: CreditLedger) => Promise<void>) | undefined;
  /** Refuse (409) a replay whose stored entry has a different delta or reason. */
  strictReplay?: boolean | undefined;
}

/**
 * An idempotency key matched an entry that is not this request: a different
 * amount or reason under the same key. Returned as `applied: false` it would
 * read as "already done" when nothing the caller asked for happened.
 */
export function creditsReplayMismatch(prior: { delta: number; reason: CreditReason }): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CREDITS_IDEMPOTENCY_KEY_REUSED',
    message:
      'This idempotency key was already used for a different ledger entry ' +
      `(${prior.reason}, ${prior.delta > 0 ? '+' : ''}${prior.delta}).`,
    fix: 'Use a new idempotency key for a different grant. Retry with the same key only with the same body.',
  });
}

export interface ApplyDeltaResult {
  balance: number;
  entryId: string;
  applied: boolean;
}

const INSUFFICIENT = (need: number, have: number): RekeyError =>
  new RekeyError({
    statusCode: 402,
    code: 'CREDITS_INSUFFICIENT',
    message: `Not enough credits: need ${need}, balance ${have}.`,
    fix: 'Buy a credit pack (CREDIT plan/entitlement), or grant credits from the panel.',
  });

/**
 * Which webhook announces a ledger entry.
 *
 * Not the sign alone. A consume is usage and a correction is not, and a
 * consumer mirroring usage must be able to tell them apart without parsing
 * `reason`: an operator taking back 50 mistakenly granted credits arriving as
 * `credit.consumed` would read as 50 units of work nobody did. So CONSUME is
 * `credit.consumed`, ADJUST (either sign) and any other removal is
 * `credit.adjusted`, and everything else adds and is `credit.granted`.
 */
export function creditEventType(entry: { delta: number; reason: CreditReason }): WebhookEventType {
  if (entry.reason === 'CONSUME') return 'credit.consumed';
  if (entry.reason === 'ADJUST' || entry.delta < 0) return 'credit.adjusted';
  return 'credit.granted';
}

/**
 * Write the `credit.*` delivery rows for one ledger entry through the
 * transaction that wrote the entry. Returns the row ids to kick after commit.
 */
function enqueueCreditEvent(tx: Prisma.TransactionClient, entry: CreditLedger): Promise<string[]> {
  return enqueueEvent(tx, {
    applicationId: entry.applicationId,
    type: creditEventType(entry),
    data: {
      credit: {
        entryId: entry.id,
        endUserId: entry.endUserId,
        organizationId: entry.organizationId,
        delta: entry.delta,
        amount: Math.abs(entry.delta),
        reason: entry.reason,
        balance: entry.balanceAfter,
        idempotencyKey: entry.idempotencyKey,
        description: entry.description,
        createdAt: entry.createdAt.toISOString(),
      },
    },
  });
}

async function applyDelta(input: ApplyDeltaInput): Promise<ApplyDeltaResult> {
  const subject = resolveCreditSubject(input);
  const balanceWhere = {
    applicationId_subjectKey: { applicationId: input.applicationId, subjectKey: subject.subjectKey },
  };
  let deliveryIds: string[] = [];

  const run = async (tx: Prisma.TransactionClient): Promise<ApplyDeltaResult> => {
    if (input.idempotencyKey) {
      const prior = await tx.creditLedger.findUnique({
        where: {
          applicationId_subjectKey_idempotencyKey: {
            applicationId: input.applicationId,
            // Keyed by SUBJECT, not just application: a client-supplied key
            // names what is being paid for (e.g. a lead id), not who is
            // paying. Without this, a second buyer drawing down for the same
            // lead found the first buyer's row and consumed for free (#492).
            subjectKey: subject.subjectKey,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (prior) return replayOf(prior);
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
      // Atomic guarded debit, prevents lost-update overspend.
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
    // Same transaction as the entry: the event exists exactly when the entry
    // does. Only reached for a new entry, so an idempotent replay (returned
    // above) and a refused debit (thrown above) announce nothing.
    deliveryIds = await enqueueCreditEvent(tx, entry);
    if (input.afterEntry) await input.afterEntry(tx, entry);
    return { balance: balanceAfter, entryId: entry.id, applied: true };
  };

  // A replay is only "already done" when it is the same entry. With
  // `strictReplay`, a key that matched a different amount or reason is
  // refused instead of answering `applied: false` for work that never happened.
  const replayOf = (prior: CreditLedger): ApplyDeltaResult => {
    if (input.strictReplay && (prior.delta !== input.delta || prior.reason !== input.reason)) {
      throw creditsReplayMismatch(prior);
    }
    return { balance: prior.balanceAfter, entryId: prior.id, applied: false };
  };

  // Caller-owned transaction: run inline and let their rollback cover us. The
  // P2002 recovery below deliberately does not apply, a failed statement has
  // already aborted their transaction, so a read inside it would fail too.
  // Kicking is theirs as well: from here the rows are not committed yet.
  if (input.tx) {
    const result = await run(input.tx);
    input.onDeliveries?.(deliveryIds);
    return result;
  }

  try {
    const result = await prisma.$transaction(run);
    kickDeliveries(deliveryIds);
    return result;
  } catch (e) {
    if (isUniqueViolation(e) && input.idempotencyKey) {
      const prior = await prisma.creditLedger.findUnique({
        where: {
          applicationId_subjectKey_idempotencyKey: {
            applicationId: input.applicationId,
            // Keyed by SUBJECT, not just application: see the same check above.
            subjectKey: subject.subjectKey,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (prior) return replayOf(prior);
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
    /**
     * Join a transaction the caller already has open, so the debit commits
     * with their work. Used by usage recording against a priced meter, where
     * a unit recorded but not paid for is precisely the bug.
     */
    tx?: Prisma.TransactionClient | undefined;
    /** With `tx`: the `credit.consumed` delivery ids to kick after the caller commits. */
    onDeliveries?: ((deliveryIds: string[]) => void) | undefined;
  }): Promise<ApplyDeltaResult> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new RekeyError({
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
      ...(input.tx ? { tx: input.tx } : {}),
      ...(input.onDeliveries ? { onDeliveries: input.onDeliveries } : {}),
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
    /** See `ApplyDeltaInput.afterEntry`. */
    afterEntry?: ApplyDeltaInput['afterEntry'];
    /** See `ApplyDeltaInput.strictReplay`. */
    strictReplay?: boolean | undefined;
  }): Promise<ApplyDeltaResult> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new RekeyError({
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
      afterEntry: input.afterEntry,
      strictReplay: input.strictReplay,
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
      // `id` breaks ties: entries written in the same millisecond (a batch,
      // a usage charge and its grant) otherwise come back in whatever order
      // Postgres finds them, and offset paging can repeat or skip one.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      skip: Math.max(opts.offset ?? 0, 0),
    });
  },

  /**
   * Total ledger entries for a subject, ignoring limit/offset.
   *
   * The append-only ledger is the clearest case for reporting `total`: it only
   * ever grows, so a caller reading the default 50-row window has no way to
   * know whether it is looking at a complete history or the tip of one.
   */
  async countLedger(applicationId: string, subject: CreditSubjectInput): Promise<number> {
    const { subjectKey } = resolveCreditSubject(subject);
    return prisma.creditLedger.count({ where: { applicationId, subjectKey } });
  },
};

// Re-exported for tests / callers that need the low-level primitive.
export type CreditsServiceClient = PrismaClient;
