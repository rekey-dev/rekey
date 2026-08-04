/**
 * Tracking and cleanup for everything this harness creates in a real Stripe
 * test account. (The naming rule itself is provider-neutral and lives in
 * `naming.ts`.)
 *
 * A sandbox account is shared — with the operator's own manual experiments,
 * with other contributors, with every previous run of this suite. Two rules
 * follow, and both are enforced here rather than left to each test:
 *
 *   1. **Everything is namespaced.** Every object carries the `rekey-harness`
 *      prefix in its name and `rekeyHarness: '1'` in its metadata where Stripe
 *      allows metadata. Nothing this file deletes can be an operator's own
 *      object, because nothing of theirs is named that.
 *
 *   2. **Everything is cleaned up twice.** Once by the `StripeJanitor` at the
 *      end of the run, and once by `sweepStaleHarnessObjects` at the START of
 *      the next one, which collects whatever a crashed or `SIGINT`-ed run left
 *      behind. Cleanup-at-exit alone is not idempotent; a sweep on entry is
 *      what makes repeated runs safe.
 *
 * What Stripe will and will not let us remove, which shapes the whole file:
 *
 *   - **Prices cannot be deleted, ever.** They can only be archived
 *     (`active: false`). A price is referenced by invoices, so Stripe keeps it.
 *   - **A Product cannot be deleted while any Price references it**, so a
 *     product that has been through `ensurePlanRegistered` is archived, not
 *     deleted. This is not a leak the harness can fix, and it is worth knowing
 *     before pointing the suite at an account you care about the tidiness of.
 *   - **Coupons, Customers, Webhook Endpoints and Test Clocks CAN be deleted.**
 *   - **Deleting a Test Clock deletes every Customer and Subscription attached
 *     to it**, which is why the subscription tests anchor to one: it makes the
 *     most expensive cleanup a single call.
 */

import Stripe from 'stripe';
import { HARNESS_PREFIX } from './naming.js';

/** How old a leftover must be before the entry sweep will remove it. */
const STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * How many objects of each kind the entry sweep will look at.
 *
 * Stripe's auto-pagination will happily walk an entire account, and the sweep
 * runs before any test — an unbounded scan of somebody's long-lived sandbox
 * turns `pnpm test:providers` into a five-minute wait for nothing. Leftovers
 * are newest-first in every list this touches, so a bound only ever misses
 * residue that is already very old, and the next run gets another shot at it.
 */
const SWEEP_SCAN_LIMIT = 300;

/** Stripe API version this harness pins — the one `stripe-real.ts` uses. */
const API_VERSION = '2024-11-20.acacia' as Stripe.LatestApiVersion;

export function stripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, { apiVersion: API_VERSION, timeout: 20_000, maxNetworkRetries: 2 });
}

type TrackedKind =
  | 'coupon'
  | 'customer'
  | 'subscription'
  | 'checkoutSession'
  | 'webhookEndpoint'
  | 'testClock'
  | 'product';

/**
 * Records what a test created and undoes it, best-effort, in dependency order.
 *
 * Every removal is individually try/caught: cleanup runs in `afterAll`, and a
 * single 404 (an object a test already deleted, an object the test clock took
 * with it) must not abandon the remaining twenty.
 */
export class StripeJanitor {
  private readonly tracked: Array<{ kind: TrackedKind; id: string }> = [];
  readonly failures: string[] = [];

  constructor(private readonly stripe: Stripe) {}

  track(kind: TrackedKind, id: string | null | undefined): void {
    if (id) this.tracked.push({ kind, id });
  }

  /**
   * Remove everything tracked, most-derived first.
   *
   * Order matters in one place: test clocks come before the customers and
   * subscriptions they own, so deleting the clock does most of the work and
   * the individual deletes that follow are cheap no-ops.
   */
  async cleanup(): Promise<void> {
    const order: TrackedKind[] = [
      'checkoutSession',
      'webhookEndpoint',
      'testClock',
      'subscription',
      'customer',
      'coupon',
      'product',
    ];
    for (const kind of order) {
      for (const entry of this.tracked.filter((t) => t.kind === kind)) {
        try {
          await this.remove(entry.kind, entry.id);
        } catch (e) {
          // Recorded, not thrown, and NOT printed with the object id alone:
          // a cleanup failure means an object is still sitting in the sandbox,
          // which the caller should see, but it must never fail a run whose
          // assertions all passed.
          this.failures.push(`${entry.kind} ${entry.id}: ${(e as Error).message}`);
        }
      }
    }
  }

  private async remove(kind: TrackedKind, id: string): Promise<void> {
    switch (kind) {
      case 'checkoutSession':
        // Expiring is the only "undo" a session has, and it only applies while
        // the session is still open — a completed one 400s, which is fine.
        await this.stripe.checkout.sessions.expire(id).catch(() => undefined);
        return;
      case 'webhookEndpoint':
        await this.stripe.webhookEndpoints.del(id);
        return;
      case 'testClock':
        await this.stripe.testHelpers.testClocks.del(id);
        return;
      case 'subscription':
        await this.stripe.subscriptions.cancel(id).catch(() => undefined);
        return;
      case 'customer':
        await this.stripe.customers.del(id);
        return;
      case 'coupon':
        await this.stripe.coupons.del(id);
        return;
      case 'product':
        await archiveProduct(this.stripe, id);
        return;
    }
  }
}

/**
 * Archive a product and every price under it.
 *
 * Deletion is attempted first and expected to fail for any product that has
 * been through `ensurePlanRegistered` — Stripe refuses to delete a product
 * with prices. Archiving is the real outcome; the delete is there for the
 * products that happen to have none.
 */
export async function archiveProduct(stripe: Stripe, productId: string): Promise<void> {
  for await (const price of stripe.prices.list({ product: productId, limit: 100 })) {
    if (price.active) await stripe.prices.update(price.id, { active: false }).catch(() => undefined);
  }
  try {
    await stripe.products.del(productId);
  } catch {
    await stripe.products.update(productId, { active: false });
  }
}

/**
 * Delete what previous runs left behind.
 *
 * Called once from the harness's global setup, before any suite runs. Only
 * touches objects whose name or metadata carries the harness marker AND that
 * are older than `STALE_AFTER_MS` — the age check is what stops this from
 * eating the objects of a run happening at the same moment on another machine
 * pointed at the same sandbox.
 *
 * Returns a per-kind count for the setup banner. Never throws: a sandbox that
 * refuses a cleanup call must not stop the suite that is about to run.
 */
export async function sweepStaleHarnessObjects(stripe: Stripe): Promise<Record<string, number>> {
  const cutoff = Math.floor((Date.now() - STALE_AFTER_MS) / 1000);
  const removed: Record<string, number> = {};
  const bump = (k: string): void => {
    removed[k] = (removed[k] ?? 0) + 1;
  };

  /**
   * Walk at most `SWEEP_SCAN_LIMIT` objects of one kind, removing the stale
   * harness ones. Never throws — the suite about to run matters more than the
   * tidiness of an account we do not own.
   */
  const sweep = async <T extends { created: number }>(
    label: string,
    list: AsyncIterable<T>,
    mine: (item: T) => boolean,
    remove: (item: T) => Promise<unknown>,
  ): Promise<void> => {
    try {
      let scanned = 0;
      for await (const item of list) {
        if (++scanned > SWEEP_SCAN_LIMIT) return;
        if (!mine(item) || item.created > cutoff) continue;
        await remove(item).catch(() => undefined);
        bump(label);
      }
    } catch {
      removed[`${label}:error`] = 1;
    }
  };

  // Test clocks first: deleting one takes its customers and subscriptions with
  // it, so the passes below have less to do.
  await sweep(
    'testClocks',
    stripe.testHelpers.testClocks.list({ limit: 100 }),
    (clock) => clock.name?.startsWith(HARNESS_PREFIX) ?? false,
    (clock) => stripe.testHelpers.testClocks.del(clock.id),
  );

  await sweep(
    'coupons',
    stripe.coupons.list({ limit: 100 }),
    (coupon) =>
      (coupon.name?.startsWith(HARNESS_PREFIX) ?? false) || coupon.metadata?.rekeyHarness === '1',
    (coupon) => stripe.coupons.del(coupon.id),
  );

  await sweep(
    'customers',
    stripe.customers.list({ limit: 100 }),
    (customer) =>
      customer.metadata?.rekeyHarness === '1' ||
      (customer.email?.startsWith(HARNESS_PREFIX) ?? false),
    (customer) => stripe.customers.del(customer.id),
  );

  await sweep(
    'webhookEndpoints',
    stripe.webhookEndpoints.list({ limit: 100 }),
    // Matched on the URL: `registerWebhook` writes its own fixed description
    // ('Rekey (auto-configured)') that the harness does not control, but the
    // harness owns the whole hostname it points them at — see `harnessWebhookUrl`.
    (endpoint) => endpoint.url.includes(`${HARNESS_PREFIX}.example.com`),
    (endpoint) => stripe.webhookEndpoints.del(endpoint.id),
  );

  await sweep(
    'products',
    stripe.products.list({ active: true, limit: 100 }),
    (product) => product.name.startsWith(HARNESS_PREFIX),
    (product) => archiveProduct(stripe, product.id),
  );

  return removed;
}

/**
 * The URL the harness registers webhook endpoints at.
 *
 * `example.com` is reserved by RFC 2606 and resolves for nobody, so a stray
 * endpoint that outlives cleanup delivers to nothing and gets disabled by
 * Stripe rather than reaching a host somebody owns. The `rekey-harness`
 * label is what the sweep above matches on, so it must stay in the hostname.
 */
export function harnessWebhookUrl(runId: string, applicationSlug: string): string {
  return `https://${HARNESS_PREFIX}.example.com/${runId}/api/v1/webhooks/billing/stripe/${applicationSlug}`;
}
