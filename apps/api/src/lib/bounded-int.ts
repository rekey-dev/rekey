/**
 * Integer schemas with an upper bound, because Postgres has one.
 *
 * Every money and metering field in this codebase was written as
 * `z.number().int().min(0)` — a floor, no ceiling. Zod accepted anything up to
 * `Number.MAX_SAFE_INTEGER`, Prisma passed it through, and Postgres answered
 * `22003 value out of range for type integer`. An external audit turned that
 * into a 500 on five routes by sending `9007199254740991` as a usage quantity,
 * a plan amount, and a credit grant.
 *
 * A 500 is the wrong answer to a number the caller typed. It reads as "the
 * server broke" rather than "that value is not allowed", it pages whoever owns
 * the error rate, and on `usage/record` it is reachable by any application API
 * key. The bound belongs in the schema, where the 400 carries the field name.
 *
 * Two ceilings, because the columns differ:
 *
 *   - `int4Max` — 2147483647, the actual limit of a Postgres `integer` column.
 *     Use for counts and durations that map to `Int` in the Prisma schema.
 *   - `moneyMax` — 10^11 minor units, ~1 billion in a two-decimal currency.
 *     Deliberately far below `int4Max`: money above this is a typo or a probe,
 *     not a real charge, and the difference between "rejected at the edge" and
 *     "accepted, then charged" is worth more than the flexibility. Raise it if
 *     a real deployment ever needs to — a bound that is too low fails loudly
 *     at the boundary, which is the direction to err in.
 */

import { z } from 'zod';

/** Largest value a Postgres `integer` (int4) column can store. */
export const INT4_MAX = 2_147_483_647;

/**
 * Ceiling for monetary amounts in minor units (cents).
 *
 * This is `INT4_MAX`, because that is what the column holds: `Plan.amount` and
 * `Coupon.amountOff` are Prisma `Int`, i.e. Postgres `integer`.
 *
 * The first version of this bound was 10^11 — picked as "a sane ceiling for
 * money" without checking the column, which is 46× smaller. The result was a
 * bound that looked like it fixed the 500s and did not: every value from
 * 2147483648 up to the declared maximum still reached Postgres and came back
 * `22003 value out of range for type integer`, and the OpenAPI document
 * advertised a `maximum` that was itself guaranteed to 500. An external audit
 * found it by sending the exact declared maximum.
 *
 * 2147483647 minor units is ~21.5 million in a two-decimal currency. If a
 * deployment ever needs more than that, the column has to widen to BigInt
 * first — this constant must never exceed what the column can store, which is
 * the whole point of it.
 */
export const MONEY_MAX = INT4_MAX;

/** A non-negative money amount in minor units, bounded at {@link MONEY_MAX}. */
export const moneyAmount = () => z.number().int().min(0).max(MONEY_MAX);

/** A positive money amount in minor units, bounded at {@link MONEY_MAX}. */
export const positiveMoneyAmount = () => z.number().int().positive().max(MONEY_MAX);

/** A non-negative count bounded by what an int4 column can hold. */
export const boundedInt = () => z.number().int().min(0).max(INT4_MAX);

/** A positive count bounded by what an int4 column can hold. */
export const positiveBoundedInt = () => z.number().int().positive().max(INT4_MAX);
