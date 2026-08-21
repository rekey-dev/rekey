/**
 * Per-subscription entitlement overrides — the write path.
 *
 * `Subscription.entitlementOverrides` decides what a subscription actually
 * grants: `entitlements.service.ts` merges it over the plan's rows on every
 * resolve. Until this module existed it was read in five places and written in
 * none, so the documented way to sell a bespoke deal without minting a private
 * plan ("raising that allowance means setting `entitlementOverrides` on the
 * subscription" — the hosted commercial layer) required SQL
 * against production.
 *
 * ## The rule every validation here follows
 *
 * **The resolver silently drops what it cannot use.** `applyOverrides` ignores
 * a non-finite quantity, never matches a malformed key, and only ADDs rows for
 * `FEATURE:`. Each of those is a value an operator can store, believe they
 * sold, and never deliver — with nothing anywhere reporting a problem.
 *
 * So this module refuses what the read path would ignore. Every rule below
 * exists because the alternative is not an error but a silence.
 *
 * ## Why `null` deletes instead of storing
 *
 * `applyOverrides` skips only `undefined`. A stored `null` reaches `String(o)`
 * for a FEATURE and materialises the literal string `"null"` as the
 * entitlement value; for a quantity kind `Number(null)` is `0`, silently
 * selling zero of something. Treating `null` as "remove this override" makes
 * both unreachable rather than merely undocumented, and gives the API the
 * obvious way to revert one key to the plan's value.
 *
 * See docs/specs/entitlement-overrides.md.
 */

import { Prisma, type Subscription } from '@prisma/client';
import { isEntitlingStatus } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { entitlementsService, type ResolvedEntitlement } from './entitlements.service.js';
import { enqueueSubscriptionEvent } from './webhooks/billing-events.js';

/** Kinds an override key may name. Mirrors `PlanEntitlementKind`. */
const KINDS = ['FEATURE', 'CREDIT', 'LICENSE', 'USAGE'] as const;

/**
 * `KIND:key`. The key half is deliberately permissive about punctuation
 * (`max_production_apps`, `api.calls`, `seats:premium` are all real shapes)
 * and deliberately strict about length and character class, because anything
 * outside it can be stored and will never match an entitlement at resolve
 * time.
 */
/** `CreditLedger.delta` and the entitlement quantity columns are `Int`. */
const MAX_QUANTITY = 2_147_483_647;

const OVERRIDE_KEY_RE = new RegExp(`^(${KINDS.join('|')}):[A-Za-z0-9_.:-]{0,64}$`);

/**
 * Why the key half may be EMPTY.
 *
 * A plan created with a legacy `kind` and no explicit entitlement rows is
 * resolved by `synthesizeLegacy`, which emits a single row with `key: ''`. Its
 * lookup key is therefore `"CREDIT:"` — and that is the only key an override
 * could use to reach it. Requiring at least one character refused exactly the
 * one form that works, with a message saying it "never matches an entitlement",
 * which was the precise opposite of true.
 *
 * The `planRows` check below still does the real work: an empty key on a plan
 * that has explicit rows has nothing to match and is refused there, with an
 * accurate reason.
 */

/**
 * Ceiling on the STORED blob, measured after the merge.
 *
 * Same reasoning as `METADATA_MAX_BYTES` and the same failure it avoids: the
 * merge is sparse and additive, so a stream of small patches is exactly how you
 * would grow this without any single request looking large. 8 KB is far above
 * any real deal — a few dozen `KIND:key` entries — and far below the size at
 * which it starts to matter that this blob is inlined into every webhook
 * payload for the subscription and re-resolved on `GET /billing/entitlements`,
 * which customer apps call on page load.
 *
 * Measured post-merge, not on the request body, for the reason the metadata cap
 * learned the hard way: a cap on the request lets an oversized blob accumulate
 * and then brick the very route that could shrink it.
 */
const OVERRIDES_MAX_BYTES = 8 * 1024;

/** What a caller may set a key to. `null` means "remove this override". */
export type OverrideValue = string | number | boolean | null;

export interface PatchOverridesInput {
  applicationId: string;
  subscriptionId: string;
  /** Sparse. Keys absent here are left exactly as they are. */
  patch: Record<string, OverrideValue>;
}

export interface PatchOverridesResult {
  subscription: Subscription;
  /** Plan ⊕ overrides — what this subscriber now holds. */
  entitlements: ResolvedEntitlement[];
  /** True when the resolved entitlements differ from before the write. */
  changed: boolean;
  /**
   * Webhook delivery rows written in the same transaction as the update, for
   * the caller to hand to `kickDeliveries` AFTER it commits. Empty when
   * nothing changed.
   */
  deliveryIds: string[];
}

function invalid(message: string, fix: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'ENTITLEMENT_OVERRIDE_INVALID',
    message,
    fix,
  });
}

/**
 * Decode the stored blob into a plain object.
 *
 * A non-object (hand-edited row, historical junk) reads as "no overrides"
 * rather than throwing: refusing every write on a subscription because its
 * blob is malformed would leave an operator with no way to repair it through
 * the API, and the merge that follows overwrites the bad value anyway.
 */
function currentOverrides(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/**
 * Stable, order-insensitive shape of a resolved entitlement set, for deciding
 * whether a write actually changed anything.
 *
 * Compares what the entitlement GRANTS — value, quantity, price-per-unit,
 * licence kind, rollover — and not object identity or array order, because
 * `applyOverrides` appends added FEATURE rows at the end and a set that merely
 * reordered has not changed what the customer holds.
 */
function entitlementFingerprint(entitlements: ResolvedEntitlement[]): string {
  return JSON.stringify(
    entitlements
      .map((e) => [e.kind, e.key, e.valueType, e.value, e.quantity, e.creditsPerUnit, e.licenseKind, e.rollover])
      .sort((a, b) => String(a[0]) .concat(':', String(a[1])).localeCompare(String(b[0]).concat(':', String(b[1])))),
  );
}

export const entitlementOverridesService = {
  /**
   * Merge `patch` into a subscription's overrides and return what it now
   * grants.
   *
   * Sparse by design: an operator raising one allowance must not have to
   * restate a deal they did not come to change, and a client round-tripping a
   * stale read must not silently drop an override added since.
   */
  async patch(input: PatchOverridesInput): Promise<PatchOverridesResult> {
    const { applicationId, subscriptionId, patch } = input;

    if (Object.keys(patch).length === 0) {
      throw invalid(
        'No overrides were supplied.',
        'Send at least one `KIND:key` entry. Use null as the value to remove an override and revert that entitlement to the plan.',
      );
    }

    // One transaction around read, write and announce. `enqueueSubscriptionEvent`
    // does no network I/O — it writes delivery ROWS — so the event either
    // commits with the change that caused it or not at all. The alternative,
    // announcing after the commit, drops the event whenever the process dies in
    // between and leaves a consumer projecting entitlements that have moved.
    const result = await prisma.$transaction(async (tx) => {
      const sub = await findSubscription(tx, applicationId, subscriptionId);

      // A dead subscription is not a deal to adjust.
      //
      // `resolveForSubscription` does NOT gate on status — it answers "what do
      // this subscription's plan and overrides describe", which is the right
      // question for a live one. So without this guard, editing a CANCELED or
      // EXPIRED subscription resolves its full entitlement set, reports
      // `changed: true`, and emits `entitlements_updated` carrying paid
      // entitlements for something nobody is paying for.
      //
      // Downstream that is not cosmetic. A consumer projecting entitlements
      // onto its own state has no status to check — the payload is a set of
      // entitlements and a plan slug, and cancellation does not change the plan
      // row. Rekey Cloud would write the paid ceiling back onto a churned
      // customer's workspace, and nothing would ever emit again to remove it.
      //
      // Refusing here rather than suppressing the event: an operator editing a
      // dead subscription has made a mistake worth being told about (very
      // often a wrong id), and silently accepting a write that grants nothing
      // is its own trap. Reviving a subscription is a status change, which is
      // deliberately not something this endpoint does.
      if (!isEntitlingStatus(sub.status)) {
        throw new RekeyError({
          statusCode: 409,
          code: 'SUBSCRIPTION_NOT_ENTITLING',
          message: `Subscription "${subscriptionId}" is ${sub.status} and grants nothing, so its entitlements cannot be adjusted.`,
          fix: 'Overrides deviate a LIVE deal from its plan; they do not revive a dead one. Check the subscription id, or start a new subscription for this customer.',
        });
      }

      // Resolved BEFORE the write, so "did this change anything" is answered
      // against what the subscriber actually held rather than against the
      // stored blob. Two different blobs can grant the same thing — removing an
      // override that merely restated the plan's own value is the common case —
      // and it is the grant that consumers care about.
      const before = await entitlementsService.resolveForSubscription(sub, tx).catch(() => []);

      // The plan's OWN rows, for deciding whether a quantity-kind key has
      // anything to override. Read from the plan rather than from `before`:
      // `before` already has overrides applied, so a key introduced by an
      // earlier override would look like a plan row and let the next write in.
      const plan = await tx.plan.findUnique({ where: { id: sub.planId } });
      const planRowList = plan ? await entitlementsService.resolveForPlan(plan, tx).catch(() => []) : [];
      const planRows = new Map(planRowList.map((e) => [`${e.kind}:${e.key}`, e] as const));

      const next = mergePatch(currentOverrides(sub.entitlementOverrides), patch, planRows);

      const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
      if (bytes > OVERRIDES_MAX_BYTES) {
        throw invalid(
          `These overrides would be ${bytes} bytes after merging; the limit is ${OVERRIDES_MAX_BYTES}.`,
          'Overrides describe how one deal deviates from its plan, so they should be a handful of keys. If a customer needs a substantially different bundle, give them their own plan.',
        );
      }

      const updated = await tx.subscription.update({
        where: { id: subscriptionId },
        // An empty object is stored as NULL rather than `{}`. Both resolve
        // identically, and NULL is what a subscription that never had an
        // override looks like — so removing the last one returns the row to a
        // state indistinguishable from never having been touched, instead of
        // leaving a tombstone that reads as "someone configured something".
        data: {
          entitlementOverrides:
            Object.keys(next).length === 0 ? Prisma.DbNull : (next as Prisma.InputJsonValue),
        },
      });

      const after = await entitlementsService.resolveForSubscription(updated, tx).catch(() => []);
      const changed = entitlementFingerprint(before) !== entitlementFingerprint(after);

      return {
        subscription: updated,
        entitlements: after,
        changed,
        // Announced only on a real change. A PATCH restating the current deal
        // is news to nobody, and emitting anyway would make
        // "entitlements_updated" stop meaning that entitlements updated.
        deliveryIds: changed
          ? await enqueueSubscriptionEvent(tx, 'subscription.entitlements_updated', subscriptionId)
          : [],
      };
    });

    return result;
  },
};

// ---------------------------------------------------------------------------
// Below: the per-key policy and the one scoped read, kept out of `patch` so the
// transaction above reads as a sequence of steps rather than a wall of rules.
// ---------------------------------------------------------------------------

/**
 * Apply `patch` onto `current`, refusing anything the resolver would accept
 * into storage and then ignore. See the module docblock for why every rule
 * here is a refusal rather than a filter.
 */
function mergePatch(
  current: Record<string, unknown>,
  patch: Record<string, OverrideValue>,
  planRows: ReadonlyMap<string, ResolvedEntitlement>,
): Record<string, unknown> {
  const next = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (!OVERRIDE_KEY_RE.test(key)) {
      throw invalid(
        `"${key}" is not a valid override key.`,
        'Use `KIND:key`, where KIND is FEATURE, CREDIT, LICENSE or USAGE — for example `FEATURE:max_production_apps`. A key outside that shape is stored but never matches an entitlement, so it would sell nothing.',
      );
    }

    // Removal. Deleting an absent key is not an error: the caller asked for a
    // state ("no override on this key") that is already true.
    if (value === null) {
      delete next[key];
      continue;
    }

    const kind = key.slice(0, key.indexOf(':'));

    // An EMPTY key half is legal only where a plan row already has one, which
    // in practice means the row `synthesizeLegacy` emits for a legacy
    // CREDIT/LICENSE plan. It can never be created: `applyOverrides`'s ADD path
    // skips a `FEATURE:` whose key half is empty, so allowing one through would
    // store precisely the silent no-op every other rule here exists to refuse.
    if (key.length === kind.length + 1 && !planRows.has(key)) {
      throw invalid(
        `"${key}" names no entitlement — the part after the colon is empty.`,
        'An empty key matches only the single entitlement synthesized for a legacy plan that carries no explicit rows. On any other plan, name the entitlement — for example `FEATURE:max_production_apps`.',
      );
    }

    if (kind === 'FEATURE') {
      const ok = typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
      if (!ok) {
        throw invalid(
          `The value for "${key}" must be a string, a finite number, or a boolean.`,
          'FEATURE values are stringified at resolve time, so an object or array would become "[object Object]" and grant nothing meaningful.',
        );
      }

      // The override must fit the DECLARED type of the row it lands on.
      //
      // `applyOverrides` replaces only `value` and keeps the plan's
      // `valueType`, so a mistyped override is read back through
      // `parseFeatureValue` under the old type and quietly becomes something
      // else: "yes" on a BOOL row parses as `false` (only the exact string
      // "true" is truthy there), and `true` on an INT row parses to null, which
      // a consumer then treats as an absent allowance. Both are silent — the
      // write succeeds, the webhook fires, and the customer gets the opposite
      // of what was sold. This is the one silent-drop path in `applyOverrides`
      // that the other rules here do not already cover.
      const row = planRows.get(key);
      if (row && row.valueType !== null) {
        assertFitsValueType(key, row.valueType, value);
      }

      next[key] = value;
      continue;
    }

    // Quantity kinds. Two separate refusals, both of values the resolver would
    // store happily and then discard.
    if (!planRows.has(key)) {
      throw invalid(
        `The plan behind this subscription has no "${key}" entitlement to override.`,
        'Only FEATURE overrides may introduce an entitlement the plan does not carry. For CREDIT, LICENSE or USAGE, add it to the plan first (PUT /api/v1/tenant/applications/:id/plans/:slug/entitlements), then override its quantity here.',
      );
    }
    if (typeof value === 'boolean' || !Number.isFinite(Number(value))) {
      throw invalid(
        `The value for "${key}" must be a finite number.`,
        'CREDIT, LICENSE and USAGE overrides replace a quantity. A non-numeric value is discarded at resolve time, leaving the plan quantity in force with nothing reporting it.',
      );
    }
    const quantity = Number(value);

    // The column is `Int`. A fraction or an out-of-range value stores fine here
    // and then throws inside `entitlementsService.provision` at the NEXT
    // renewal, so the operator's typo surfaces weeks later as a retrying 500 on
    // the renewal webhook, nowhere near the person who typed it.
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > MAX_QUANTITY) {
      throw invalid(
        `The quantity for "${key}" must be a whole number between 0 and ${MAX_QUANTITY}.`,
        'Quantities are stored in a 32-bit integer column. A fraction or a larger number is rejected by the database at the next renewal, long after this call reported success.',
      );
    }

    // Per-kind semantics, delegated rather than restated.
    //
    // `entitlementsService.validate` already encodes every rule that makes a
    // quantity meaningful — CREDIT must be positive, a SEATS licence needs at
    // least one seat, and a USAGE row with no included units must carry a price
    // "because an entitlement granting no units and costing nothing is
    // indistinguishable from not having one". Those rules guard the PLAN and
    // this path writes the same numbers to the same resolver, so restating them
    // here would be a second copy free to drift. It is called with the plan
    // row's own `creditsPerUnit` and `licenseKind`, because whether 0 is
    // meaningful depends on them, not on the override.
    //
    // The refusal is re-wrapped: `validate` throws PLAN_ENTITLEMENT_INVALID,
    // and a caller of this route is not editing a plan. The message and fix are
    // kept verbatim, so the reason survives the change of code.
    const row = planRows.get(key)!;
    try {
      entitlementsService.validate({
        kind: row.kind as Parameters<typeof entitlementsService.validate>[0]['kind'],
        key: row.key,
        quantity,
        creditsPerUnit: row.creditsPerUnit ?? null,
        licenseKind: row.licenseKind ?? null,
      });
    } catch (e) {
      if (e instanceof RekeyError && e.code === 'PLAN_ENTITLEMENT_INVALID') {
        throw invalid(e.message, e.fix ?? 'Pick a quantity this entitlement kind can carry.');
      }
      throw e;
    }

    next[key] = quantity;
  }

  return next;
}

/**
 * Refuse a FEATURE value that its plan row's `valueType` cannot carry.
 *
 * `BOOL` is the sharp one: `parseFeatureValue` treats ONLY the exact string
 * "true" as true, so every other value — "yes", "1", 1 — reads as `false`. An
 * operator switching a flag on with "yes" would switch it off and be told the
 * write succeeded.
 *
 * `INT` refuses booleans and non-integers: `Number(true)` is 1 rather than an
 * error, and a fractional value survives `parseFeatureValue` here but is typed
 * STRING when the same key is ADDED rather than overridden, which downstream
 * consumers report as an absent allowance rather than a malformed one.
 *
 * `STRING` accepts anything stringifiable, which is what it means.
 */
function assertFitsValueType(
  key: string,
  valueType: NonNullable<ResolvedEntitlement['valueType']>,
  value: string | number | boolean,
): void {
  if (valueType === 'BOOL') {
    const ok = typeof value === 'boolean' || value === 'true' || value === 'false';
    if (!ok) {
      throw invalid(
        `"${key}" is a BOOL entitlement, so its value must be true or false.`,
        'Only the exact string "true" reads as true at resolve time — anything else, including "yes" or 1, resolves to false. Send a JSON boolean.',
      );
    }
    return;
  }
  if (valueType === 'INT') {
    const n = typeof value === 'boolean' ? NaN : Number(value);
    if (!Number.isInteger(n)) {
      throw invalid(
        `"${key}" is an INT entitlement, so its value must be a whole number.`,
        'A boolean or a fractional value does not survive the integer parse at resolve time, and consumers read the result as an absent allowance rather than a rejected one.',
      );
    }
  }
}

/**
 * The subscription, scoped to the Application in the path.
 *
 * Scoped in the QUERY rather than checked after the fact: `ensureAppAccess`
 * upstream has proved the caller may touch the APPLICATION, not this row, and
 * a subscription id is a cuid an operator of another workspace could hold.
 */
async function findSubscription(
  tx: Prisma.TransactionClient,
  applicationId: string,
  subscriptionId: string,
): Promise<Subscription> {
  const sub = await tx.subscription.findFirst({ where: { id: subscriptionId, applicationId } });
  if (!sub) {
    throw new RekeyError({
      statusCode: 404,
      code: 'SUBSCRIPTION_NOT_FOUND',
      message: `Subscription "${subscriptionId}" not found on this application.`,
      fix: "List a customer's subscriptions via GET /api/v1/tenant/applications/:id/end-users/:euid/billing.",
    });
  }
  return sub;
}
