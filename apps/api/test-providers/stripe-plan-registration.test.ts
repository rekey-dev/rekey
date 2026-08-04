/**
 * Plan registration against a real Stripe test account, and the two things the
 * mock could not tell us:
 *
 *   1. **Does the Price Stripe minted mean what our Plan row says?** The mock
 *      answered `{ providerPlanId: 'price_fake' }` and agreed with whatever we
 *      sent. Here the Price is read back OUT of Stripe and compared field by
 *      field with the Plan — currency case, amount units, interval mapping,
 *      the metadata the webhook path later relies on.
 *
 *   2. **What actually happens when Stripe refuses.** PR #325 made a refused
 *      plan un-purchasable and repairable, and every assertion behind that
 *      feature was written against a mock that threw whatever the test told it
 *      to. A genuinely invalid `sk_test_` key produces a real
 *      `StripeAuthenticationError` with a real status, a real message and a
 *      real shape — which is what `providerError` and `registerAndSettle` have
 *      to cope with.
 *
 * The invalid-key case is also where a credential is most likely to be printed:
 * Stripe's own message for a bad key quotes it back (masked). This suite pins
 * that our stored `registrationError` never contains the key in full.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { prisma } from '../src/lib/prisma.js';
import { plansService } from '../src/modules/plans/plans.service.js';
import { describeSandbox, stripeSandbox, STRIPE_KEY_VAR } from './support/credentials.js';
import { StripeJanitor, harnessWebhookUrl, stripeClient } from './support/stripe-sandbox.js';
import { HARNESS_PREFIX, newRunId } from './support/naming.js';
import { configureStripe, createFixture, startCheckout } from './support/fixture.js';
import { fakeCredential } from './support/redact.js';

describeSandbox('stripe', 'Stripe sandbox · plan registration', stripeSandbox, (creds) => {
  let stripe: Stripe;
  let janitor: StripeJanitor;
  let runId: string;

  beforeAll(() => {
    // Constructed here, never in the describe body: a skipped suite still has
    // its body executed for collection, and `creds.apiKey` is a placeholder
    // then. See `describeSandbox`.
    stripe = stripeClient(creds.apiKey);
    janitor = new StripeJanitor(stripe);
    runId = newRunId();
  });

  afterAll(async () => {
    await janitor.cleanup();
  });

  it('mints a Stripe Price that matches the Plan row field for field', async () => {
    const fixture = await createFixture('reg-ok');
    await configureStripe(fixture, creds.apiKey);

    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'pro-monthly',
      // The product name is what the sweep matches on — keep the prefix.
      name: `${HARNESS_PREFIX} Pro Monthly ${runId}`,
      amount: 2499,
      currency: 'usd',
      interval: 'MONTH',
    });

    expect(plan.registrationStatus).toBe('REGISTERED');
    expect(plan.active).toBe(true);
    const priceId = (plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId;
    expect(priceId).toMatch(/^price_/);

    const price = await stripe.prices.retrieve(priceId!, { expand: ['product'] });
    const product = price.product as Stripe.Product;
    janitor.track('product', product.id);

    // Units. `plan.amount` is the smallest currency unit and Stripe's
    // `unit_amount` is too — a mismatch here would be the classic
    // dollars-vs-cents defect, and no mock can catch it.
    expect(price.unit_amount).toBe(2499);
    // Case. We store `currency` as given and lowercase it on the way out;
    // Stripe always answers lowercase.
    expect(price.currency).toBe('usd');
    expect(price.recurring?.interval).toBe('month');
    expect(price.type).toBe('recurring');
    // The metadata `stripe-real.ts` writes so an operator can trace a Stripe
    // object back to the Rekey row. Read back from Stripe, not asserted on the
    // request we sent.
    expect(price.metadata.rekeyPlanId).toBe(plan.id);
    expect(product.metadata.rekeyPlanId).toBe(plan.id);
    expect(product.metadata.rekeyApplicationId).toBe(fixture.applicationId);
  });

  it('is idempotent — re-registering reuses the stored Price instead of minting a second', async () => {
    const fixture = await createFixture('reg-idem');
    await configureStripe(fixture, creds.apiKey);

    const plan = await plansService.create({
      applicationId: fixture.applicationId,
      slug: 'idem-monthly',
      name: `${HARNESS_PREFIX} Idempotent ${runId}`,
      amount: 500,
      currency: 'usd',
      interval: 'MONTH',
    });
    const first = (plan.metadata as { stripe?: { priceId?: string } }).stripe?.priceId;

    const again = await plansService.registerWithProvider(fixture.applicationId, 'idem-monthly');
    const second = (again.metadata as { stripe?: { priceId?: string } }).stripe?.priceId;

    expect(second).toBe(first);
    const price = await stripe.prices.retrieve(first!);
    janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);
  });

  it('a key Stripe genuinely refuses leaves the plan off sale, repairable, and un-buyable', async () => {
    const fixture = await createFixture('reg-bad');
    // Syntactically a test key, so it passes our own `pattern` validation and
    // reaches Stripe — which is the only party that can tell us it is wrong.
    const badKey = fakeCredential('sk_test_', 'deliberately-invalid-stripe-key');
    await configureStripe(fixture, badKey);

    await expect(
      plansService.create({
        applicationId: fixture.applicationId,
        slug: 'refused',
        name: `${HARNESS_PREFIX} Refused ${runId}`,
        amount: 1000,
        currency: 'usd',
        interval: 'MONTH',
      }),
    ).rejects.toMatchObject({
      // Not Stripe's own 401. `provider-errors.ts` exists because a raw
      // StripeError reaching the error handler answered `401 BAD_REQUEST` with
      // the operator's key fragment in the message.
      statusCode: 502,
      code: 'BILLING_PROVIDER_ERROR',
    });

    const row = await prisma.plan.findUniqueOrThrow({
      where: { applicationId_slug: { applicationId: fixture.applicationId, slug: 'refused' } },
    });
    expect(row.registrationStatus).toBe('FAILED');
    expect(row.active).toBe(false);
    // Stripe's own words, kept for the operator — the whole point of storing
    // the raw text is that it names which credential is wrong.
    expect(row.registrationError ?? '').toMatch(/api key/i);
    // …but never the key itself. Stripe masks the middle of the key it echoes;
    // this asserts we are not the ones un-masking it.
    expect(row.registrationError ?? '').not.toContain(badKey);

    // Off the public catalogue — read through the pricing-page endpoint a
    // buyer's browser would hit, not through the row we just asserted on.
    const catalogue = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/billing/plans',
      headers: { authorization: `Bearer ${fixture.liveKey}` },
    });
    const slugs = (catalogue.json().data.items as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).not.toContain('refused');

    // And un-buyable, with the operator's repair in the error rather than a 500.
    const checkout = await startCheckout(fixture, { planSlug: 'refused' });
    expect(checkout.statusCode).toBeGreaterThanOrEqual(400);
    expect(checkout.json().error?.code).toMatch(/PLAN_INACTIVE|PLAN_NOT_REGISTERED_WITH_PROVIDER/);

    // The repair: fix the credential, re-register, back on sale — same slug.
    await configureStripe(fixture, creds.apiKey);
    const repaired = await plansService.registerWithProvider(fixture.applicationId, 'refused');
    expect(repaired.registrationStatus).toBe('REGISTERED');
    expect(repaired.active).toBe(true);
    const priceId = (repaired.metadata as { stripe?: { priceId?: string } }).stripe?.priceId;
    expect(priceId).toMatch(/^price_/);
    const price = await stripe.prices.retrieve(priceId!);
    janitor.track('product', typeof price.product === 'string' ? price.product : price.product.id);
  });

  it('registerWebhook creates a real endpoint subscribed to the events the module consumes', async () => {
    const fixture = await createFixture('reg-webhook');
    await configureStripe(fixture, creds.apiKey);

    const { getProviderForApplication } = await import(
      '../src/modules/billing/providers/index.js'
    );
    const application = await prisma.application.findUniqueOrThrow({
      where: { id: fixture.applicationId },
    });
    const provider = await getProviderForApplication(application, 'stripe');

    // example.com is RFC 2606 reserved, so a stray endpoint that outlives
    // cleanup delivers to nothing rather than to a host somebody owns — and
    // the `rekey-harness` label in it is what the entry sweep matches on.
    const url = harnessWebhookUrl(runId, fixture.applicationSlug);
    const first = await provider.registerWebhook!(url);
    janitor.track('webhookEndpoint', first.webhookId);

    expect(first.webhookId).toMatch(/^we_/);
    // Stripe reveals a signing secret exactly once, at creation. If this is
    // ever absent, auto-configuration silently stores nothing and every
    // inbound webhook 503s — worth an assertion of its own.
    expect(first.secret).toMatch(/^whsec_/);

    const endpoint = await stripe.webhookEndpoints.retrieve(first.webhookId!);
    expect(new Set(endpoint.enabled_events)).toEqual(
      new Set([
        'checkout.session.completed',
        'customer.subscription.updated',
        'customer.subscription.deleted',
        'invoice.paid',
        'invoice.payment_failed',
      ]),
    );
    expect(endpoint.url).toBe(url);

    // Re-registering the SAME url: our implementation deletes and recreates,
    // because Stripe will not re-reveal a secret. Verify that is what happens
    // rather than trusting the comment — a duplicate endpoint would mean every
    // event delivered twice, and a missing secret would mean none verified.
    const second = await provider.registerWebhook!(url);
    janitor.track('webhookEndpoint', second.webhookId);
    expect(second.webhookId).not.toBe(first.webhookId);
    expect(second.secret).toMatch(/^whsec_/);

    const all = await stripe.webhookEndpoints.list({ limit: 100 });
    expect(all.data.filter((e) => e.url === url)).toHaveLength(1);
  });

  it(`refuses to run at all without ${STRIPE_KEY_VAR} — this suite is credential-gated`, () => {
    // A self-check on the gate: if this test is executing, the credential
    // resolver handed the suite a real test key. It exists so the run summary
    // carries one unambiguously-named assertion about the gate itself.
    expect(creds.apiKey.startsWith('sk_test_')).toBe(true);
  });
});
