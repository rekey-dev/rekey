/**
 * Completing a hosted Checkout Session for real, with a test card.
 *
 * Stripe test mode has **no API that completes a Checkout Session**. Test
 * clocks advance billing for subscriptions that already exist; the Sessions
 * API can create and expire a session but not pay for one. The supported route
 * is the documented one — open the hosted page and pay with a test card — so
 * that is what this does, with Playwright.
 *
 * It is opt-in (`REKEY_SANDBOX_BROWSER=1`) for a boring reason: it needs a
 * browser binary that the repo does not install by default, and a suite that
 * fails on a missing binary teaches contributors to ignore red. Everything the
 * completion unlocks that can be reached another way is covered
 * unconditionally in `stripe-webhook-entitlement.test.ts`; what ONLY lives here
 * is `checkout.session.completed` itself — the event that writes
 * `providerSubId` onto the local row and provisions the first period.
 *
 * The hosted page is somebody else's UI and will change. The selectors below
 * are therefore deliberately loose, and the assertion that matters is not "the
 * form submitted" but "Stripe now reports this session as `complete`", read
 * back from the API.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { prisma } from '../src/lib/prisma.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { entitlementsService } from '../src/modules/billing/entitlements.service.js';
import { browserCompletionEnabled, describeSandbox, stripeSandbox } from './support/credentials.js';
import { StripeJanitor, stripeClient } from './support/stripe-sandbox.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import {
  configureStripe,
  createFixture,
  deliverStripeEvent,
  readEntitlements,
  startCheckout,
  subscriptionBySession,
  waitForStripeEvents,
} from './support/fixture.js';

/** Stripe's always-succeeds test card. Documented test data, not a real PAN. */
const TEST_CARD = '4242424242424242';

/**
 * Resolve the credential AND the browser opt-in together, so a missing browser
 * skips with the install command in the suite title exactly the way a missing
 * key skips with the env var in it.
 */
function browserSandbox(): { apiKey: string } | { error: string } {
  const gate = browserCompletionEnabled();
  if ('error' in gate) return gate;
  return stripeSandbox();
}

describeSandbox('stripe', 'Stripe sandbox · hosted checkout completion (browser)', browserSandbox, (creds) => {
  let stripe: Stripe;
  let janitor: StripeJanitor;
  let runId: string;

  beforeAll(() => {
    stripe = stripeClient(creds.apiKey);
    janitor = new StripeJanitor(stripe);
    runId = newRunId();
  });

  afterAll(async () => {
    await janitor.cleanup();
  });

  /**
   * Pay for `url` with the test card.
   *
   * Playwright is imported dynamically: it is a root devDependency and the
   * browser binary is a separate download, so a static import would make this
   * file fail to LOAD on a machine that has neither — which vitest reports as
   * a smaller passing count, not as an error.
   */
  async function payWithTestCard(url: string): Promise<void> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Stripe renders card fields in the top-level document on the hosted
      // page (unlike Elements, which uses iframes). Fall back to searching
      // frames anyway — this page is not ours and has changed before.
      const fill = async (selector: string, value: string): Promise<void> => {
        for (const frame of [page.mainFrame(), ...page.frames()]) {
          const field = frame.locator(selector).first();
          if (await field.count().catch(() => 0)) {
            await field.fill(value, { timeout: 20_000 });
            return;
          }
        }
        throw new Error(`Stripe Checkout: no field matched ${selector}`);
      };

      await fill('#cardNumber, input[name="cardNumber"]', TEST_CARD);
      await fill('#cardExpiry, input[name="cardExpiry"]', '12 / 34');
      await fill('#cardCvc, input[name="cardCvc"]', '123');
      const name = page.locator('#billingName, input[name="billingName"]').first();
      if (await name.count().catch(() => 0)) await name.fill('Rekey Harness');
      const postal = page.locator('#billingPostalCode, input[name="billingPostalCode"]').first();
      if (await postal.count().catch(() => 0)) await postal.fill('12345');

      await page.locator('button[type="submit"], .SubmitButton').first().click({ timeout: 20_000 });
      // The redirect back to `successUrl` is example.com, which will not load —
      // that is fine and expected. What matters is that the navigation was
      // attempted; the authority on whether the session completed is the API.
      await page.waitForURL(/example\.com\/thanks/, { timeout: 90_000 }).catch(() => undefined);
    } finally {
      await browser.close();
    }
  }

  it('a real card payment completes the Session and provisions the buyer', async () => {
    const fixture = await createFixture('browser-checkout');
    await configureStripe(fixture, creds.apiKey);

    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'hosted',
      name: `${HARNESS_PREFIX} Hosted ${runId}`,
      amount: 2100,
      currency: 'usd',
      interval: 'MONTH',
    });
    await entitlementsService.upsert({
      planId: plan.id,
      kind: 'FEATURE',
      key: 'hosted_checkout',
      valueType: 'BOOL',
      value: 'true',
    });
    const priceId = (plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId!;
    const price = await stripe.prices.retrieve(priceId);
    janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);

    const since = Math.floor(Date.now() / 1000) - 5;
    const res = await startCheckout(fixture, { planSlug: 'hosted' });
    expect(res.statusCode).toBe(200);
    const { url, subscription } = res.json().data as {
      url: string;
      subscription: { metadata: Record<string, unknown> };
    };
    const sessionId = subscription.metadata.checkoutSessionId as string;
    janitor.track('checkoutSession', sessionId);

    await payWithTestCard(url);

    // The API is the authority, not the browser.
    const completed = await stripe.checkout.sessions.retrieve(sessionId);
    expect(completed.status).toBe('complete');
    expect(completed.payment_status).toBe('paid');
    const providerSubId =
      typeof completed.subscription === 'string'
        ? completed.subscription
        : completed.subscription?.id;
    expect(providerSubId).toMatch(/^sub_/);
    janitor.track('subscription', providerSubId);
    janitor.track('customer', typeof completed.customer === 'string' ? completed.customer : completed.customer?.id);

    // The genuine completion event — the one that cannot be obtained any other
    // way, and the one `applyCheckoutCompleted` is written against.
    const events = await waitForStripeEvents(stripe, {
      types: ['checkout.session.completed'],
      since,
      expect: 1,
      match: (e) => (e.data.object as { id?: string }).id === sessionId,
    });
    expect(events).toHaveLength(1);
    const session = events[0]!.data.object as Stripe.Checkout.Session;
    // The routing metadata, as Stripe delivered it rather than as we sent it.
    expect(session.metadata?.applicationId).toBe(fixture.applicationId);

    const ack = await deliverStripeEvent(fixture, events[0]!);
    expect(ack.statusCode).toBe(200);
    expect(ack.body).toMatchObject({ processed: true });

    const local = await subscriptionBySession(fixture.applicationId, sessionId);
    expect(local?.status).toBe('ACTIVE');
    expect(local?.providerSubId).toBe(providerSubId);
    expect((await readEntitlements(fixture)).features.hosted_checkout).toBe(true);

    // A `mode: 'subscription'` completion records NO payment of its own — the
    // money is `invoice.paid`'s to record, and recording it twice under two
    // provider ids is the double-count `oneTimeCharge` avoids. Pinned here
    // because it is a claim about Stripe's payload, not about our code.
    expect(await prisma.payment.count({ where: { applicationId: fixture.applicationId } })).toBe(0);

    const invoice = await waitForStripeEvents(stripe, {
      types: ['invoice.paid'],
      since,
      expect: 1,
      match: (e) => (e.data.object as { subscription?: unknown }).subscription === providerSubId,
    });
    expect(invoice).toHaveLength(1);
    await deliverStripeEvent(fixture, invoice[0]!);
    const payment = await prisma.payment.findFirstOrThrow({
      where: { applicationId: fixture.applicationId },
    });
    expect(payment.amount).toBe(2100);
    expect(payment.status).toBe('SUCCEEDED');
  });
});
