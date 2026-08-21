/**
 * Outbound webhook event registry.
 *
 * Each event has a stable string key (mirrored from Clerk/better-auth for
 * familiarity) and a payload schema. The dispatcher in `webhooks.service`
 * fans out to every WebhookEndpoint whose `events` array contains the
 * event type OR the wildcard `"*"`.
 *
 * Customers should treat the wire payload's `eventId` field as the
 * idempotency key — retries from our delivery worker reuse the same id,
 * so deduping on the consumer side is one cheap upsert.
 */

/**
 * Every event this deployment can emit. **One declaration, deliberately.**
 *
 * This used to be two — a string-literal union and a matching array — and
 * nothing derived one from the other or checked that they agreed. That is a
 * trap with an unusually quiet failure: adding to the union alone type-checks
 * everywhere, and then `isKnownWebhookEvent` returns false for the new type, so
 * `enqueueEvent` returns `[]` without an error and the event is simply never
 * delivered. It also silently drops the name from the `events` enum on
 * webhook-endpoint creation, so a customer cannot even subscribe to it. It
 * happened while adding `subscription.entitlements_updated`, and the fix is
 * structural rather than a parity test: with the type DERIVED from the array,
 * the two cannot disagree because there is no longer a second thing to keep in
 * step.
 *
 * `as const` is what makes that work — without it the array widens to
 * `string[]` and `WebhookEventType` becomes `string`, which would silently
 * disable the compile-time checking on every emit site in the codebase.
 */
export const KNOWN_WEBHOOK_EVENTS = [
  'user.created',
  'user.updated',
  'user.deleted',
  // GDPR erasure (roadmap §10). Distinct from `user.deleted`: the end-user is
  // tombstoned (PII/auth hard-deleted, financial rows retained anonymized) and
  // can never authenticate again — consumers should propagate the erasure to
  // their own copies of the user's PII. Payload: `data.user` (id + erasedAt).
  'user.erased',
  'session.revoked',
  'mfa.enabled',
  'mfa.disabled',
  'password.changed',
  'email.verified',
  // Billing lifecycle — emitted from the Stripe/PayPal inbound-webhook
  // handlers when LOCAL state actually transitions (a provider-event replay
  // that changes nothing emits nothing). A provider retry after a 5xx on our
  // side may still re-emit; consumers must dedupe on the envelope's eventId.
  'subscription.activated',
  'subscription.canceled',
  'subscription.past_due',
  // Not a status transition: what the subscription GRANTS changed, while the
  // subscription itself carried on. Emitted when an operator writes
  // `entitlementOverrides`, and only when the RESOLVED entitlements actually
  // differ — a PATCH that restates the current deal announces nothing.
  //
  // Exists because a consumer that projects entitlements onto its own state
  // (Rekey Cloud maps `FEATURE:max_production_apps` onto `Tenant.limits`) had
  // no way to hear about a change that never touched `status`, and so enforced
  // a ceiling the customer was no longer sold.
  'subscription.entitlements_updated',
  'payment.succeeded',
  'payment.failed',
  // Dunning lifecycle — emitted by `modules/billing/dunning.service.ts` when a
  // failed-payment recovery case opens, recovers, or exhausts (day 14 →
  // subscription canceled). Same transition-only + eventId-dedupe contract as
  // the billing events above.
  'dunning.case_opened',
  'dunning.case_recovered',
  'dunning.case_exhausted',
] as const;

/**
 * Derived from the array above, which is what makes the two impossible to
 * disagree. See the docblock on `KNOWN_WEBHOOK_EVENTS`.
 */
export type WebhookEventType = (typeof KNOWN_WEBHOOK_EVENTS)[number];

export interface WebhookEventEnvelope<TData = Record<string, unknown>> {
  /** Stable cuid; safe to use as the consumer-side idempotency key. */
  eventId: string;
  /** ISO timestamp the event was generated server-side. */
  occurredAt: string;
  type: WebhookEventType;
  /** Application id this event happened in (== caller's secret-key scope). */
  applicationId: string;
  data: TData;
}


export function isKnownWebhookEvent(s: string): s is WebhookEventType {
  return (KNOWN_WEBHOOK_EVENTS as ReadonlyArray<string>).includes(s);
}

/** True if the subscriber's `events` list matches the given event type. */
export function endpointMatches(events: ReadonlyArray<string>, type: WebhookEventType): boolean {
  if (events.includes('*')) return true;
  return events.includes(type);
}
