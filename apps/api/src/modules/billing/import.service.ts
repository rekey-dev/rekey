/**
 * Subscription import, reading what a billing system already sold.
 *
 * ## Why this is a run, not a call
 *
 * The event feed covers everything from the moment a billing system connects.
 * It cannot cover what was sold BEFORE that, which on migration day is the
 * entire book of business. So there is an import, and an import is the most
 * dangerous shape a button can have: a bulk write against somebody else's data,
 * matching strangers to local accounts by email, decided in one click.
 *
 * So it is two steps. A DRY RUN reads the provider and records, per row, what
 * WOULD happen and why. Nothing is written to `subscriptions`. The operator
 * reads that, fixes the plan mapping, and applies, or does not. The preview is
 * the feature; the write is the easy part.
 *
 * ## What "already imported" means
 *
 * `externalId` is the idempotency key. Re-running an import never creates a
 * second subscription for the same provider subscription, because the apply
 * goes through `subscriptionGrantsService.grantSubscription`, which is itself
 * idempotent on (application, end-user, plan) and returns `activated: false`
 * for a subscriber who is already entitled.
 *
 * ## What it deliberately does not do
 *
 * It does not overwrite. A local subscriber who is already ACTIVE is
 * `skip_active`, never "updated to match the provider", an import is for
 * subscriptions Rekey does not have, and silently rewriting live entitlement
 * from a file somebody uploaded is how a customer loses access.
 *
 * It does not resurrect. An erased end-user is never matched: their address is
 * anonymised, and matching a tombstone would rebuild the person a GDPR request
 * removed.
 */

import { randomUUID } from 'node:crypto';
import type { Application, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { getProviderForApplication } from './providers/index.js';
import type { ExternalSubscription } from './providers/types.js';
import type { BillingProviderName } from './credentials.service.js';
import { subscriptionGrantsService } from './grant.service.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { applicationRolesService } from '../application-roles/application-roles.service.js';
import { emitDetached, kickDeliveries } from '../webhooks/webhook.service.js';
import { assertMetadataWithinLimit } from '../../lib/metadata-limit.js';
import { assertEndUserQuota } from '../../lib/tenant-limits.js';
import { entitlementOverridesService } from './entitlement-overrides.service.js';
import { entitlementsService } from './entitlements.service.js';

/** How a row was decided. Mirrors the panel's preview groups exactly. */
export type ImportOutcome =
  | 'match'
  | 'create'
  | 'skip_no_plan'
  | 'skip_active'
  | 'skip_invalid'
  | 'error';

export type MatchStrategy = 'email' | 'email_or_create';

const PAGE_SIZE = 200;
const MAX_ROWS = 10_000;

/**
 * The metadata keys a provider registration owns.
 *
 * Mirrors `PROVIDER_METADATA_KEYS` in plans.service.ts, which is what
 * `stripProviderMetadata` reserves. Everything outside this set is operator
 * free-text and must not be read as a provider plan reference.
 */
const PROVIDER_METADATA_KEYS = ['stripe', 'paypal', 'razorpay'] as const;

const LIVE_STATUSES = new Set(['ACTIVE', 'PAST_DUE', 'TRIALING']);
const IMPORTABLE_STATUSES = new Set(['active', 'trialing', 'past_due']);

interface PlannedItem {
  externalId: string;
  email: string | null;
  planRef: string | null;
  outcome: ImportOutcome;
  endUserId: string | null;
  planSlug: string | null;
  detail: Record<string, unknown>;
  /**
   * The terms the provider reported, carried through to the grant.
   *
   * These were typed and documented before they were threaded, which meant
   * every imported subscription silently came out open-ended and single-seat
   * regardless of what the provider said, the exact opposite of what
   * `docs/external-billing-pull.md` promises about `currentPeriodEnd`.
   */
  terms: {
    currentPeriodEnd?: string | undefined;
    startedAt?: string | undefined;
    cancelAt?: string | undefined;
    trialEndsAt?: string | undefined;
    quantity?: number | undefined;
    metadata?: Record<string, unknown> | undefined;
    customerExternalId?: string | undefined;
    customerName?: string | undefined;
  };
}

/**
 * Decide what would happen to one provider row.
 *
 * Every refusal is named rather than dropped: an operator looking at a preview
 * that says "412 rows, 30 imported" needs to know what the other 382 were, or
 * the import is a black box they have to trust.
 */
async function planRow(
  application: Application,
  raw: ExternalSubscription,
  strategy: MatchStrategy,
  planByRef: Map<string, string>,
): Promise<PlannedItem> {
  const externalId = typeof raw?.externalId === 'string' ? raw.externalId : '';
  const email = typeof raw?.customer?.email === 'string' ? raw.customer.email.toLowerCase() : null;
  const planRef = typeof raw?.planRef === 'string' ? raw.planRef : null;
  const terms = {
    ...(typeof raw?.currentPeriodEnd === 'string' && { currentPeriodEnd: raw.currentPeriodEnd }),
    ...(typeof raw?.startedAt === 'string' && { startedAt: raw.startedAt }),
    ...(typeof raw?.cancelAt === 'string' && { cancelAt: raw.cancelAt }),
    ...(typeof raw?.trialEndsAt === 'string' && { trialEndsAt: raw.trialEndsAt }),
    ...(typeof raw?.quantity === 'number' && { quantity: raw.quantity }),
    ...(raw?.metadata !== undefined && { metadata: raw.metadata }),
    ...(typeof raw?.customer?.externalId === 'string' && {
      customerExternalId: raw.customer.externalId,
    }),
    ...(typeof raw?.customer?.name === 'string' && { customerName: raw.customer.name }),
  };
  const base = { externalId, email, planRef, endUserId: null, planSlug: null, terms };

  if (externalId === '') {
    return { ...base, outcome: 'skip_invalid', detail: { reason: 'No externalId on the row.' } };
  }
  if (email === null || !email.includes('@')) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: { reason: 'No usable customer.email, so there is nothing to match on.' },
    };
  }
  if (typeof raw.status !== 'string' || !IMPORTABLE_STATUSES.has(raw.status)) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: {
        reason: `Status "${String(raw.status)}" is not one Rekey imports.`,
        // Canceled and expired are valid statuses and deliberately not
        // imported: there is no entitlement to grant, and creating a canceled
        // subscription would only add noise to the customer's history.
        hint: 'Only active, trialing and past_due carry entitlement worth importing.',
      },
    };
  }

  const planSlug = planRef === null ? undefined : planByRef.get(planRef);
  if (planSlug === undefined) {
    return {
      ...base,
      outcome: 'skip_no_plan',
      detail: {
        reason:
          planRef === null
            ? 'The row names no plan.'
            : `No local plan is mapped to "${planRef}".`,
        hint: 'Map it to a plan and run the import again.',
      },
    };
  }

  const existing = await prisma.endUser.findUnique({
    where: { applicationId_email: { applicationId: application.id, email } },
    select: { id: true, erasedAt: true },
  });

  // A tombstone is not a match. Their address is anonymised and matching one
  // would rebuild the person a GDPR request removed.
  if (existing && existing.erasedAt === null) {
    const live = await prisma.subscription.findFirst({
      where: {
        applicationId: application.id,
        endUserId: existing.id,
        status: { in: [...LIVE_STATUSES] as never },
      },
      select: { id: true, status: true },
    });
    if (live) {
      return {
        ...base,
        outcome: 'skip_active',
        endUserId: existing.id,
        planSlug,
        detail: {
          reason: `Already has a ${live.status} subscription in Rekey.`,
          hint: 'An import never overwrites live entitlement.',
        },
      };
    }
    return { ...base, outcome: 'match', endUserId: existing.id, planSlug, detail: {} };
  }

  if (strategy !== 'email_or_create') {
    return {
      ...base,
      outcome: 'skip_invalid',
      planSlug,
      detail: {
        reason: existing ? 'That end-user was erased.' : 'No end-user in Rekey with that address.',
        hint: existing
          ? 'An erasure cannot be undone.'
          : 'Re-run with "create missing users" to bring them in.',
      },
    };
  }
  if (existing) {
    return {
      ...base,
      outcome: 'skip_invalid',
      detail: { reason: 'That end-user was erased; nothing can be granted to a tombstone.' },
    };
  }
  return { ...base, outcome: 'create', planSlug, detail: {} };
}

/**
 * Parse a date a third party wrote, refusing anything that is not a real one.
 *
 * A period end in the PAST is dropped rather than honoured: `grantSubscription`
 * refuses a subscription born already expired, and one bad row must not fail an
 * import when open-ended is the safe reading of "we could not tell".
 */
function futureDate(v: unknown, now: Date): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) return undefined;
  return d;
}

/**
 * How long an `applying` run may go without a heartbeat before it counts as
 * abandoned and a new apply may take it over.
 *
 * An apply runs inside one HTTP request, so a deploy, crash or OOM mid-run
 * leaves nothing behind to finish it. The number comes from what one row can
 * cost. A row is roughly a dozen queries (end-user create, quota count, the
 * grant transaction, entitlement provisioning, a seat patch, the item mark),
 * normally tens of milliseconds. Its worst case is bounded by Prisma's
 * interactive transaction limits, 2s to start and 5s to run, on each of the
 * two transactions, plus the plain queries around them: about 20 seconds. The
 * heartbeat is checked between rows every `HEARTBEAT_EVERY_MS`, so a live run
 * goes at most about 35 seconds without one. Five minutes is eight times that,
 * which keeps a slow but living run from being taken over, and is still a short
 * wait for an operator recovering a run on migration day.
 */
export const APPLY_STALE_AFTER_MS = 5 * 60_000;

/** How often a live apply refreshes its heartbeat, checked between rows. */
const HEARTBEAT_EVERY_MS = 15_000;

/**
 * Whether a run is `applying` with no live process behind it. A NULL heartbeat
 * is stale: that is a run claimed before the heartbeat existed.
 */
export function isApplyStale(
  run: { status: string; heartbeatAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (run.status !== 'applying') return false;
  return run.heartbeatAt === null || now.getTime() - run.heartbeatAt.getTime() > APPLY_STALE_AFTER_MS;
}

/**
 * Whether a subscription was activated by this run for this provider row.
 *
 * True only when the import provenance names both, and that provenance is
 * written in the same transaction as the activation, so it is present exactly
 * when the grant committed. A second row in the same run for the same buyer
 * and plan carries a different `externalId` and is correctly not a match.
 */
function importedByThisRun(
  subscription: { metadata: Prisma.JsonValue | null },
  runId: string,
  externalId: string,
): boolean {
  const meta = subscription.metadata;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const imp = (meta as Record<string, unknown>).import;
  if (imp === null || typeof imp !== 'object' || Array.isArray(imp)) return false;
  const rec = imp as Record<string, unknown>;
  return rec.importRunId === runId && rec.externalId === externalId;
}

/** This apply's lease was taken over by another, so it must stop writing. */
class ApplyLeaseLost extends Error {}

function leaseLost(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'IMPORT_RUN_NOT_READY',
    message: 'This apply stalled and another one took the run over.',
    fix: 'Reload the run to see what landed. The apply that took over is finishing the remaining rows.',
  });
}

/**
 * The subscription's metadata with the import's provenance added, kept under
 * the same 16 KB ceiling every other metadata write observes. A provider that
 * returns a large blob per row loses the blob, not the subscription.
 */
function withImportProvenance(
  previous: Prisma.JsonValue | null,
  provenance: Record<string, unknown>,
  minimal: Record<string, unknown>,
): Record<string, unknown> {
  const base = (previous ?? {}) as Record<string, unknown>;
  const merged = { ...base, import: provenance };
  try {
    assertMetadataWithinLimit(merged);
    return merged;
  } catch {
    const trimmed = {
      ...base,
      import: { ...provenance, providerMetadata: '[dropped: over the metadata limit]' },
    };
    // Re-checked, because the fields that survive the trim are unbounded
    // provider strings too, so the ceiling has to be enforced twice, not
    // asserted once.
    try {
      assertMetadataWithinLimit(trimmed);
      return trimmed;
    } catch {
      return {
        ...base,
        import: { ...minimal, note: '[provider fields dropped: over the metadata limit]' },
      };
    }
  }
}

/**
 * Move a run out of `applying` when something threw that the per-row handler
 * could not absorb. Best-effort: if even this write fails there is nothing
 * further to try, and re-throwing it would mask the original cause.
 *
 * Fenced on the lease, so an apply that lost the run cannot fail the one that
 * took it over.
 */
async function markRunFailed(runId: string, lease: string, err: unknown): Promise<void> {
  await prisma.subscriptionImportRun
    .updateMany({
      where: { id: runId, status: 'applying', applyLease: lease },
      data: {
        status: 'failed',
        error: `Apply aborted: ${(err as Error).message}`.slice(0, 500),
        completedAt: new Date(),
      },
    })
    .catch(() => undefined);
}

function tally(items: PlannedItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, i) => {
    acc[i.outcome] = (acc[i.outcome] ?? 0) + 1;
    return acc;
  }, {});
}

export const subscriptionImportService = {
  /**
   * Read the provider and record what WOULD happen. Writes nothing to
   * `subscriptions`, the whole point of the step.
   */
  async dryRun(args: {
    application: Application;
    provider: BillingProviderName;
    matchStrategy: MatchStrategy;
    startedBy: string;
  }): Promise<{ runId: string }> {
    const impl = await getProviderForApplication(args.application, args.provider);
    if (typeof impl.listSubscriptions !== 'function') {
      throw new RekeyError({
        statusCode: 400,
        code: 'PROVIDER_CANNOT_LIST_SUBSCRIPTIONS',
        message: `The ${args.provider} provider cannot list subscriptions, so there is nothing to import from.`,
        fix: 'Only providers that expose a list API can be imported from. For your own billing system, configure the external provider\'s subscriptions endpoint.',
      });
    }

    const run = await prisma.subscriptionImportRun.create({
      data: {
        applicationId: args.application.id,
        provider: args.provider,
        mode: 'dry_run',
        status: 'running',
        matchStrategy: args.matchStrategy,
        startedBy: args.startedBy,
      },
    });

    try {
      // Plan mapping is by slug first, then by any provider ref recorded on the
      // plan's metadata when it was registered. An operator therefore gets a
      // working mapping for free when their plan slugs already match.
      // Ordered, because the map below is built by insertion and an unordered
      // read makes which plan wins a collision depend on DB row order, which
      // can differ between the dry run and the apply, so the operator would
      // approve one mapping and get another.
      const plans = await prisma.plan.findMany({
        where: { applicationId: args.application.id },
        orderBy: { slug: 'asc' },
        select: { slug: true, metadata: true },
      });

      // Slugs first, in their own pass. A plan's OWN slug is the strongest
      // mapping there is and must never be overwritten by another plan's
      // recorded provider ref.
      const planByRef = new Map<string, string>();
      for (const p of plans) planByRef.set(p.slug, p.slug);

      // Then provider refs, and ONLY from the reserved provider blocks.
      //
      // `Plan.metadata` is free-form operator input, `stripProviderMetadata`
      // reserves exactly these three keys and lets every other key through
      // verbatim. So walking every nested object looking for a `planId` would
      // let an operator's own bookkeeping (`metadata.crm = { planId: 'x' }`)
      // silently map provider rows onto the wrong plan, and an import that
      // puts customers on the wrong plan is worse than one that reports it
      // cannot map them.
      //
      // Rekey itself only ever writes `metadata.stripe.priceId` (in
      // `registerAndSettle`, from what `ensurePlanRegistered` returns).
      // `planId` and `productId` are read by the PayPal and Razorpay modules
      // and are accepted here for a provider ref an operator recorded by hand.
      for (const p of plans) {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        for (const providerKey of PROVIDER_METADATA_KEYS) {
          const block = meta[providerKey];
          if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
          for (const key of ['priceId', 'planId', 'productId']) {
            const v = (block as Record<string, unknown>)[key];
            // `has` guard: a ref must not displace a real slug, and the first
            // plan to claim a ref keeps it rather than the last one read.
            if (typeof v === 'string' && v !== '' && !planByRef.has(v)) {
              planByRef.set(v, p.slug);
            }
          }
        }
      }

      const planned: PlannedItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 500; page++) {
        const res = await impl.listSubscriptions({ limit: PAGE_SIZE, ...(cursor !== undefined && { cursor }) });
        for (const raw of res.items) {
          planned.push(await planRow(args.application, raw, args.matchStrategy, planByRef));
          if (planned.length >= MAX_ROWS) break;
        }
        if (planned.length >= MAX_ROWS || res.nextCursor === undefined) break;
        cursor = res.nextCursor;
      }

      // De-duplicate on externalId: a provider paginating an unstable sort can
      // return the same subscription twice, and importing it twice is exactly
      // what `externalId` exists to prevent.
      const seen = new Set<string>();
      const unique = planned.filter((p) =>
        seen.has(p.externalId) ? false : (seen.add(p.externalId), true),
      );

      await prisma.subscriptionImportItem.createMany({
        data: unique.map((p) => ({
          runId: run.id,
          externalId: p.externalId,
          email: p.email,
          planRef: p.planRef,
          outcome: p.outcome,
          endUserId: p.endUserId,
          planSlug: p.planSlug,
          // The provider's terms ride along in `detail` because that is the
          // only JSON column on the item, and apply has to honour them. They
          // are namespaced so the panel's `reason`/`hint` rendering is
          // unaffected.
          detail: {
            ...p.detail,
            ...(Object.keys(p.terms).length > 0 && { terms: p.terms }),
          } as Prisma.InputJsonValue,
        })),
      });
      await prisma.subscriptionImportRun.update({
        where: { id: run.id },
        data: {
          status: 'ready',
          counts: { ...tally(unique), total: unique.length },
          completedAt: new Date(),
        },
      });
      return { runId: run.id };
    } catch (err) {
      await prisma.subscriptionImportRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          error: (err as Error).message.slice(0, 500),
          completedAt: new Date(),
        },
      });
      throw err;
    }
  },

  /**
   * Apply a run that has been previewed.
   *
   * Only `match` and `create` items are acted on, the preview already decided,
   * and re-deciding here would mean applying something the operator never saw.
   * Each one goes through `grantSubscription`, so entitlements are materialised
   * and `subscription.activated` is announced exactly as for a real sale.
   */
  async apply(args: {
    application: Application;
    runId: string;
    actorId: string;
  }): Promise<{ imported: number; failed: number }> {
    const run = await prisma.subscriptionImportRun.findFirst({
      where: { id: args.runId, applicationId: args.application.id },
    });
    if (!run) {
      throw new RekeyError({
        statusCode: 404,
        code: 'IMPORT_RUN_NOT_FOUND',
        message: `Import run "${args.runId}" not found for this Application.`,
        fix: 'List recent runs to find one.',
      });
    }
    if (run.status !== 'ready' && !isApplyStale(run)) {
      throw new RekeyError({
        statusCode: 409,
        code: 'IMPORT_RUN_NOT_READY',
        message:
          run.status === 'applying'
            ? 'That run is being applied right now.'
            : `That run is "${run.status}", not "ready".`,
        fix:
          run.status === 'applied'
            ? 'It has already been applied. Start a new dry run to import anything new.'
            : run.status === 'applying'
              ? 'Reload the run to see it finish. If the apply was interrupted, it can be resumed once it has been silent for five minutes.'
              : 'Wait for the dry run to finish, or start a new one.',
      });
    }

    // Claim the run with a CONDITIONAL write. The status check above is a
    // read, and between it and this line a second operator pressing Apply on
    // the same preview would pass the same check, importing every row twice,
    // announcing `subscription.activated` twice, and running whatever
    // provisions downstream twice. Only the writer that moves the row out of
    // `ready` proceeds.
    //
    // The same statement reclaims an ABANDONED apply: `applying` with a
    // heartbeat older than the threshold. Staleness is judged by the database
    // clock on both sides, the write that set the heartbeat and the predicate
    // that reads it, so no process clock is involved. Postgres re-evaluates the
    // predicate after a concurrent winner commits, and the winner has just
    // written a fresh heartbeat, so of any number of reclaimers exactly one
    // proceeds. The lease names the winner for every write that follows.
    const lease = randomUUID();
    const staleSeconds = Math.round(APPLY_STALE_AFTER_MS / 1000);
    const claimed = await prisma.$executeRaw`
      UPDATE "subscription_import_runs"
         SET "status" = 'applying',
             "heartbeat_at" = (now() AT TIME ZONE 'UTC'),
             "apply_lease" = ${lease}
       WHERE "id" = ${run.id}
         AND (
           "status" = 'ready'
           OR (
             "status" = 'applying'
             AND (
               "heartbeat_at" IS NULL
               OR "heartbeat_at" < (now() AT TIME ZONE 'UTC') - (${staleSeconds}::int * interval '1 second')
             )
           )
         )`;
    if (claimed !== 1) {
      throw new RekeyError({
        statusCode: 409,
        code: 'IMPORT_RUN_NOT_READY',
        message: 'That run was already being applied.',
        fix: 'Someone else applied this preview a moment ago. Reload the run to see what landed.',
      });
    }

    // Everything from here to the terminal write is guarded. An exception
    // escaping (the item read, or the error-marking update in the per-row
    // catch failing in turn) marks the run failed with its cause. A process
    // that dies outright cannot do that, which is what the heartbeat is for.
    //
    // Only rows not yet applied are read. A row is applied once its
    // `subscriptionId` is set and failed once its outcome is `error`, so a
    // resumed apply picks up exactly the rows the interrupted one never
    // finished. A row whose grant committed but whose mark did not is read
    // again, and that is safe: see `importedByThisRun` below.
    let items: Awaited<ReturnType<typeof prisma.subscriptionImportItem.findMany>>;
    try {
      items = await prisma.subscriptionImportItem.findMany({
        where: { runId: run.id, outcome: { in: ['match', 'create'] }, subscriptionId: null },
        orderBy: { id: 'asc' },
      });
    } catch (err) {
      await markRunFailed(run.id, lease, err);
      throw err;
    }

    let lastBeat = Date.now();
    const heartbeat = async (): Promise<void> => {
      if (Date.now() - lastBeat < HEARTBEAT_EVERY_MS) return;
      const held = await prisma.$executeRaw`
        UPDATE "subscription_import_runs"
           SET "heartbeat_at" = (now() AT TIME ZONE 'UTC')
         WHERE "id" = ${run.id} AND "status" = 'applying' AND "apply_lease" = ${lease}`;
      if (held !== 1) throw new ApplyLeaseLost();
      lastBeat = Date.now();
    };

    const now = new Date();
    const warnings: string[] = [];
    let quotaRefusal: RekeyError | null = null;
    try {
    for (const item of items) {
      // Outside the per-row catch: losing the lease stops the whole apply.
      await heartbeat();
      try {
        let endUserId = item.endUserId;
        if (endUserId === null) {
          // Unlinked: no password, unverified, and marked so the end-user page
          // can explain why the account looks half-finished. They get in
          // through the normal recovery paths.
          // The workspace ceiling, exactly as sign-up, the billing webhook and
          // the operator create route apply it. Without this an import was the
          // one path in the API that could create end-users past a plan's
          // limit, and it is the path most likely to create thousands at once.
          //
          // Cached once it refuses: the ceiling only gets further out of reach
          // as a run proceeds, so a 5,000-row import against an exhausted
          // workspace should not issue 5,000 identical count queries to learn
          // the same thing. Each row is still marked `error` individually,
          // which is what makes the refusal legible in the preview.
          if (quotaRefusal !== null) throw quotaRefusal;
          try {
            await assertEndUserQuota(args.application.tenantId);
          } catch (e) {
            if (e instanceof RekeyError) quotaRefusal = e;
            throw e;
          }
          const role = await applicationRolesService.getDefault(args.application.id);
          let created: {
            id: string;
            email: string;
            emailVerified: boolean;
            role: string;
            createdAt: Date;
          } | null;
          try {
            created = await prisma.endUser.create({
              data: {
                applicationId: args.application.id,
                email: item.email!,
                passwordHash: null,
                emailVerified: false,
                role: role.name,
                metadata: { importedFrom: run.provider, importRunId: run.id },
              },
              select: { id: true, email: true, emailVerified: true, role: true, createdAt: true },
            });
          } catch (e) {
            // Two rows in the SAME run can carry one address, a customer with
            // two provider subscriptions is ordinary, and the preview
            // resolved both against an end-user that did not exist yet, so
            // both are `create`. Sign-up racing the run does it too. The
            // loser reads the winner back rather than failing a row that has
            // a perfectly good subscriber, which is the same resolution
            // `subscriber.service.ts` reached for billing webhooks.
            if ((e as { code?: string }).code !== 'P2002') throw e;
            const won = await prisma.endUser.findUniqueOrThrow({
              where: {
                applicationId_email: { applicationId: args.application.id, email: item.email! },
              },
              select: { id: true, erasedAt: true },
            });
            if (won.erasedAt !== null) {
              throw new RekeyError({
                statusCode: 409,
                code: 'END_USER_ERASED',
                message: 'That address belongs to an erased end-user and cannot be granted to.',
                fix: 'An erasure cannot be undone. The customer must be re-created under a new address.',
              });
            }
            created = null;
            endUserId = won.id;
          }
          if (created !== null) {
          endUserId = created.id;
          void recordSecurityEvent({
            type: 'end_user.created_by_import',
            actorType: 'operator',
            actorId: args.actorId,
            applicationId: args.application.id,
            metadata: { endUserId, provider: run.provider, importRunId: run.id },
          });
          emitDetached({
            applicationId: args.application.id,
            type: 'user.created',
            data: {
              user: {
                id: created.id,
                email: created.email,
                emailVerified: created.emailVerified,
                role: created.role,
                createdAt: created.createdAt.toISOString(),
                metadata: null,
              },
              via: `import:${run.provider}`,
            },
          });
          }
        }

        // The terms the provider reported, recorded at preview time.
        //
        // These have to be threaded or DELETED, not merely typed: without
        // them every imported subscription comes out open-ended, and
        // `docs/external-billing-pull.md` tells integrators the opposite,
        // that sending `currentPeriodEnd` is how the term is honoured. An
        // open-ended subscription also changes what CANCELLING it does later:
        // with no period, `cancelEffect` has nothing to schedule against and
        // access stops on the spot instead of at period end.
        const terms = ((item.detail ?? {}) as { terms?: Record<string, unknown> }).terms ?? {};
        const periodEnd = futureDate(terms.currentPeriodEnd, now);
        const cancelAt = futureDate(terms.cancelAt, now);
        // A trial still running at the provider. Judged by the trial ledger
        // inside the grant, keyed on this run, so applying the same preview
        // cannot spend two slots and a buyer who already had their trial is
        // imported ACTIVE rather than handed another one.
        const trialEndsAt = futureDate(terms.trialEndsAt, now);

        const subscriberId = endUserId;
        if (subscriberId === null) throw new Error('No subscriber could be resolved for this row.');

        const minimal = {
          importedFrom: run.provider,
          importRunId: run.id,
          externalId: item.externalId,
        };
        const provenance = {
          ...minimal,
          ...(typeof terms.customerExternalId === 'string' && {
            customerExternalId: terms.customerExternalId,
          }),
          // Recorded rather than dropped. Deliberately NOT written onto the
          // end-user: an import must not rename somebody who already has an
          // account here.
          ...(typeof terms.customerName === 'string' && {
            customerName: terms.customerName,
          }),
          ...(typeof terms.startedAt === 'string' && { providerStartedAt: terms.startedAt }),
          ...(terms.metadata !== undefined && { providerMetadata: terms.metadata }),
        };

        const result = await subscriptionGrantsService.grantSubscription({
          application: args.application,
          planSlug: item.planSlug!,
          endUserId: subscriberId,
          note: `Imported from ${run.provider} (${item.externalId})`,
          providerBinding: { provider: run.provider, providerSubId: item.externalId },
          ...(periodEnd !== undefined && { currentPeriodEnd: periodEnd }),
          ...(trialEndsAt !== undefined && { trialEndsAt, trialAttemptId: run.id }),
          // Provenance and `cancelAt` commit INSIDE the grant's transaction.
          // Written afterwards, a crash between the two left an entitled row
          // with no scheduled end, and a resumed apply could never add it: a
          // repeated grant is `activated: false` and writes nothing. The
          // decoration only runs when this call activates the row, so a
          // subscriber who was already entitled is never rewritten from a
          // file, which is the overwrite this feature exists not to do.
          decorate: (tx, sub) =>
            tx.subscription.update({
              where: { id: sub.id },
              data: {
                metadata: withImportProvenance(sub.metadata, provenance, minimal) as Prisma.InputJsonValue,
                ...(cancelAt !== undefined && { cancelAt }),
              },
            }),
        });
        if (result.trialRefused) {
          warnings.push(
            `${item.externalId}: imported ACTIVE without its trial (${result.trialRefused.reason === 'already_used' ? 'the buyer has already had one' : 'this attempt already ran its trial'})`,
          );
        }

        // A row an interrupted apply of THIS run already granted. Its grant,
        // provenance, `cancelAt`, trial redemption and `subscription.activated`
        // outbox row all committed together, so the repeated grant above
        // wrote nothing and spent nothing. What runs after that commit may
        // not have: entitlement provisioning and the seat count. Both are
        // idempotent (provisioning anchors on the period, the seat patch sets
        // an absolute value and announces only a real change), so they are
        // run again rather than guessed at.
        const resumed = !result.activated && importedByThisRun(result.subscription, run.id, item.externalId);
        if (resumed) {
          await entitlementsService.provision({ subscription: result.subscription });
        }

        if (result.activated || resumed) {

          // Seats.
          //
          // The override key has to be the plan's ACTUAL licence key, not a
          // guess. `'LICENSE:'` with an empty key half only ever matches a
          // legacy plan that `synthesizeLegacy` resolves, one with
          // `kind: 'LICENSE'` and no explicit entitlement rows. A plan
          // carrying the ordinary modern shape (`LICENSE:seats`) would have
          // been refused by `mergePatch` every single time, so the seat count
          // was reported as applied in the doc and silently downgraded to a
          // line of run `error` text in practice.
          const quantity = terms.quantity;
          if (typeof quantity === 'number' && Number.isInteger(quantity) && quantity > 1) {
            const planRows = await entitlementsService
              .resolveForPlan(await prisma.plan.findUniqueOrThrow({ where: { id: result.subscription.planId } }))
              .catch(() => []);
            const licence = planRows.find((r) => r.kind === 'LICENSE');
            if (licence === undefined) {
              // Not an error. The provider sold a seat count for something
              // this plan does not license, and inventing a LICENSE
              // entitlement the plan never carried would be selling something
              // nobody agreed to.
              warnings.push(
                `${item.externalId}: plan "${item.planSlug}" has no LICENSE entitlement, so quantity ${quantity} was not applied`,
              );
            } else {
              try {
                const patched = await entitlementOverridesService.patch({
                  applicationId: args.application.id,
                  subscriptionId: result.subscription.id,
                  patch: { [`LICENSE:${licence.key}`]: quantity },
                });
                // After the transaction committed, never inside it, the same
                // reason the tenant override route kicks here. Without this the
                // `entitlements_updated` rows sit waiting for the retry poller.
                kickDeliveries(patched.deliveryIds);
              } catch (e) {
                warnings.push(
                  `${item.externalId}: seats not applied (${(e as Error).message.slice(0, 120)})`,
                );
              }
            }
          }
        }

        await prisma.subscriptionImportItem.update({
          where: { id: item.id },
          data: { endUserId: subscriberId, subscriptionId: result.subscription.id },
        });
      } catch (err) {
        // One bad row must not abandon the rest: an import that stops halfway
        // leaves the operator with no way to tell what landed.
        await prisma.subscriptionImportItem.update({
          where: { id: item.id },
          data: {
            outcome: 'error',
            detail: { reason: (err as Error).message.slice(0, 500) } as Prisma.InputJsonValue,
          },
        });
      }
    }

    } catch (err) {
      if (err instanceof ApplyLeaseLost) throw leaseLost();
      await markRunFailed(run.id, lease, err);
      throw err;
    }

    // Tallied from the rows rather than from this pass, so a resumed apply
    // reports the whole run, not only the rows it happened to finish.
    const [imported, failed] = await Promise.all([
      prisma.subscriptionImportItem.count({
        where: { runId: run.id, outcome: { in: ['match', 'create'] }, subscriptionId: { not: null } },
      }),
      prisma.subscriptionImportItem.count({ where: { runId: run.id, outcome: 'error' } }),
    ]);

    const counts = (run.counts ?? {}) as Record<string, number>;
    const finished = await prisma.subscriptionImportRun.updateMany({
      where: { id: run.id, status: 'applying', applyLease: lease },
      data: {
        mode: 'applied',
        status: 'applied',
        counts: { ...counts, imported, failed } as Prisma.InputJsonValue,
        // A subscription that landed but whose seat count did not is a
        // half-delivered deal, and the operator has to be told which ones.
        ...(warnings.length > 0 && { error: warnings.join('; ').slice(0, 500) }),
        completedAt: new Date(),
      },
    });
    // Another apply took the run over while this one was finishing. It owns
    // the terminal write, and this caller must not report a result as final.
    if (finished.count !== 1) throw leaseLost();

    void recordSecurityEvent({
      type: 'app.subscriptions_imported',
      actorType: 'operator',
      actorId: args.actorId,
      applicationId: args.application.id,
      metadata: { importRunId: run.id, provider: run.provider, imported, failed },
    });
    return { imported, failed };
  },
};
