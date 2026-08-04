/**
 * The Rekey side of a sandbox test: a real tenant, a real Application with
 * real BYO provider credentials, a real end-user, and the two things every
 * suite needs — a way to call the public billing API as that end-user, and a
 * way to hand the API an event the provider genuinely emitted.
 *
 * Everything here goes through the product's own services and routes. The one
 * thing that is *not* real is the transport of the webhook, and that deserves
 * a paragraph of its own:
 *
 * ## Why the events are fetched, not received
 *
 * Stripe delivers webhooks by POSTing to a public URL. A suite running on a
 * laptop or a CI runner has no public URL, and standing up a tunnel would make
 * the harness depend on a third service to test the second one.
 *
 * So `deliverStripeEvent` takes an event **retrieved from the Stripe API** —
 * `stripe.events.list` / `events.retrieve`, i.e. the exact object Stripe would
 * have delivered, byte for byte, including every field Stripe chose to
 * populate — and signs it with the Application's own stored webhook secret
 * before POSTing it at the local server.
 *
 * What that does and does not prove:
 *
 *   - PROVEN: the payload shape. Every field the translator reads is one
 *     Stripe actually sent, in the type Stripe actually used, for a lifecycle
 *     Stripe actually performed. This is the half where our understanding and
 *     Stripe's could diverge, and it is the half a hand-written fixture cannot
 *     reach.
 *   - NOT PROVEN: that Stripe's own `Stripe-Signature` header verifies. The
 *     signature is generated locally with `generateTestHeaderString`, over the
 *     same HMAC construction `constructEvent` checks. That construction is
 *     already covered offline by `test/stripe-webhook.test.ts`, and the
 *     harness re-covers the negative case (a tampered body is rejected).
 *
 * That distinction is written down here rather than left implicit, because
 * "we tested webhooks against the real provider" is exactly the kind of claim
 * that decays into something untrue.
 */

import Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { billingCredentialsService } from '../../src/modules/billing/credentials.service.js';
import type { BillingProviderName } from '../../src/modules/billing/credentials.service.js';
import { HARNESS_PREFIX } from './naming.js';
import { fakeCredential } from './redact.js';

/** Everything a sandbox test needs to act as an operator and as a buyer. */
export interface SandboxFixture {
  app: FastifyInstance;
  tenantToken: string;
  applicationId: string;
  applicationSlug: string;
  /** Secret API key — the `Authorization: Bearer` for the public billing API. */
  liveKey: string;
  endUserId: string;
  /** End-user session token — the `x-rekey-user-token` header. */
  userToken: string;
  /**
   * The webhook signing secret stored against this Application.
   *
   * Locally generated, not Stripe's. See the module header: the harness signs
   * the events it replays, so this only has to match what the pipeline will
   * verify against. A separate suite exercises `registerWebhook`, which is
   * where a Stripe-issued secret is obtained for real.
   */
  webhookSecret: string;
}

let sharedApp: FastifyInstance | null = null;

/**
 * One Fastify instance for the whole run.
 *
 * Building the app is the most expensive thing in a sandbox test that is not a
 * network call, and nothing in it holds per-test state — the truncation in
 * `setup.ts` is what isolates tests.
 */
export async function sandboxApp(): Promise<FastifyInstance> {
  if (!sharedApp) {
    sharedApp = await buildApp({ logger: false });
    await sharedApp.ready();
  }
  return sharedApp;
}

export async function closeSandboxApp(): Promise<void> {
  if (sharedApp) {
    await sharedApp.close();
    sharedApp = null;
  }
}

let seq = 0;

/**
 * Create the tenant / Application / API key / end-user chain through the real
 * sign-up and provisioning routes.
 *
 * `label` only has to be unique within a run; slugs and emails are suffixed
 * with a counter so a test can call this more than once.
 */
export async function createFixture(label: string): Promise<SandboxFixture> {
  const app = await sandboxApp();
  const suffix = `${label}-${(seq += 1)}`;
  const applicationSlug = `sbx-${suffix}`.slice(0, 40);

  const tenantToken = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/auth/sign-up',
      payload: {
        email: `${HARNESS_PREFIX}-op-${suffix}@example.com`,
        password: 'sandbox-harness-password',
        workspaceName: `Sandbox ${suffix}`,
      },
    })
    .then((r) => (r.json().data as { accessToken: string }).accessToken);

  const applicationId = await app
    .inject({
      method: 'POST',
      url: '/api/v1/tenant/applications/',
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: { name: `Sandbox ${suffix}`, slug: applicationSlug, enableBilling: true },
    })
    .then((r) => (r.json().data as { id: string }).id);

  const liveKey = await app
    .inject({
      method: 'POST',
      url: `/api/v1/tenant/applications/${applicationId}/api-keys`,
      headers: { authorization: `Bearer ${tenantToken}` },
      payload: {
        name: 'sandbox',
        mode: 'live',
        scopes: ['auth:write', 'billing:read', 'billing:write'],
      },
    })
    .then((r) => (r.json().data as { rawKey: string }).rawKey);

  const session = await app
    .inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up',
      headers: { authorization: `Bearer ${liveKey}` },
      payload: {
        email: `${HARNESS_PREFIX}-buyer-${suffix}@example.com`,
        password: 'sandbox-harness-password',
      },
    })
    .then((r) => r.json().data as { endUser: { id: string }; accessToken: string });

  return {
    app,
    tenantToken,
    applicationId,
    applicationSlug,
    liveKey,
    endUserId: session.endUser.id,
    userToken: session.accessToken,
    webhookSecret: fakeCredential('whsec_', 'harness-webhook-secret'),
  };
}

/**
 * Store BYO Stripe credentials on the Application, exactly as an operator
 * would through Panel → Application → Billing.
 *
 * The service encrypts with `ENCRYPTION_KEY`, which the harness's global setup
 * always sets — so a real `sk_test_` key is never at rest in the harness
 * database in plaintext, even though the database is thrown away afterwards.
 */
export async function configureStripe(
  fixture: SandboxFixture,
  apiKey: string,
  options?: { webhookSecret?: string },
): Promise<void> {
  await billingCredentialsService.upsertCredentials(
    fixture.applicationId,
    'stripe',
    { apiKey, webhookSecret: options?.webhookSecret ?? fixture.webhookSecret },
    { mode: 'test' },
  );
}

export async function configureProvider(
  fixture: SandboxFixture,
  provider: BillingProviderName,
  data: Record<string, string>,
): Promise<void> {
  await billingCredentialsService.upsertCredentials(fixture.applicationId, provider, data, {
    mode: 'test',
  });
}

/**
 * The response `app.inject` resolves to.
 *
 * `ReturnType<FastifyInstance['inject']>` picks the chainable overload, which
 * is not what an awaited call gives back — hence the `Awaited`.
 */
export type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

/** `POST /api/v1/billing/checkout` as the fixture's end-user. */
export function startCheckout(
  fixture: SandboxFixture,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  return fixture.app.inject({
    method: 'POST',
    url: '/api/v1/billing/checkout',
    headers: {
      authorization: `Bearer ${fixture.liveKey}`,
      'x-rekey-user-token': fixture.userToken,
    },
    payload: {
      successUrl: 'https://example.com/thanks',
      cancelUrl: 'https://example.com/cancelled',
      ...body,
    },
  });
}

/** `GET /api/v1/billing/entitlements` as the fixture's end-user. */
export async function readEntitlements(fixture: SandboxFixture): Promise<{
  features: Record<string, unknown>;
  entitlements: Array<Record<string, unknown>>;
  creditBalance: number;
}> {
  const res = await fixture.app.inject({
    method: 'GET',
    url: '/api/v1/billing/entitlements',
    headers: {
      authorization: `Bearer ${fixture.liveKey}`,
      'x-rekey-user-token': fixture.userToken,
    },
  });
  return res.json().data;
}

/**
 * POST a genuine Stripe event at the Application's webhook endpoint, signed
 * with the Application's stored secret.
 *
 * `tamper` exists for the negative case: it mutates the serialised body AFTER
 * the signature is computed, which is what a man-in-the-middle would do and
 * what the pipeline must answer 401 to.
 */
export async function deliverStripeEvent(
  fixture: SandboxFixture,
  event: Stripe.Event | Record<string, unknown>,
  options?: { tamper?: boolean; secret?: string },
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const signer = new Stripe('sk_test_signing_only_never_dialled', {
    apiVersion: '2024-11-20.acacia' as Stripe.LatestApiVersion,
  });
  const payload = JSON.stringify(event);
  const signature = signer.webhooks.generateTestHeaderString({
    payload,
    secret: options?.secret ?? fixture.webhookSecret,
  });
  const res = await fixture.app.inject({
    method: 'POST',
    url: `/api/v1/webhooks/billing/stripe/${fixture.applicationSlug}`,
    headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
    payload: options?.tamper ? payload.replace('"id"', '"id "') : payload,
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json();
  } catch {
    /* the pipeline always answers JSON; an empty object is a fine stand-in */
  }
  return { statusCode: res.statusCode, body };
}

/**
 * Wait for Stripe to publish the events a just-performed action produces, and
 * return them oldest-first.
 *
 * Event publication is asynchronous and not instant — an `invoice.paid` can
 * trail the API call that caused it by a second or two — so this polls rather
 * than reading once. `match` picks the events belonging to THIS test out of
 * the account-wide feed, which matters because a sandbox is shared.
 */
export async function waitForStripeEvents(
  stripe: Stripe,
  args: {
    types: string[];
    match: (event: Stripe.Event) => boolean;
    /** Stop as soon as this many matching events have been seen. */
    expect: number;
    /** Only consider events created at/after this unix second. */
    since: number;
    timeoutMs?: number;
  },
): Promise<Stripe.Event[]> {
  const deadline = Date.now() + (args.timeoutMs ?? 45_000);
  const found = new Map<string, Stripe.Event>();
  while (Date.now() < deadline) {
    const page = await stripe.events.list({
      types: args.types,
      created: { gte: args.since },
      limit: 100,
    });
    for (const event of page.data) {
      if (args.match(event)) found.set(event.id, event);
    }
    if (found.size >= args.expect) break;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return [...found.values()].sort((a, b) => a.created - b.created);
}

/** Read the local Subscription row a checkout created, by its provider session id. */
export async function subscriptionBySession(applicationId: string, sessionId: string) {
  return prisma.subscription.findFirst({
    where: {
      applicationId,
      OR: [
        { metadata: { path: ['checkoutSessionId'], equals: sessionId } },
        { metadata: { path: ['checkoutSessionIds'], array_contains: [sessionId] } },
      ],
    },
  });
}
