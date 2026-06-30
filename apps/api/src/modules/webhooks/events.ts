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

export type WebhookEventType =
  | 'user.created'
  | 'user.updated'
  | 'user.deleted'
  // GDPR erasure (roadmap §10). Distinct from `user.deleted`: the end-user is
  // tombstoned (PII/auth hard-deleted, financial rows retained anonymized) and
  // can never authenticate again — consumers should propagate the erasure to
  // their own copies of the user's PII. Payload: `data.user` (id + erasedAt).
  | 'user.erased'
  | 'session.revoked'
  | 'mfa.enabled'
  | 'mfa.disabled'
  | 'password.changed'
  | 'email.verified'
  // Billing lifecycle — emitted from the Stripe/PayPal inbound-webhook
  // handlers when LOCAL state actually transitions (a provider-event replay
  // that changes nothing emits nothing). A provider retry after a 5xx on our
  // side may still re-emit; consumers must dedupe on the envelope's eventId.
  | 'subscription.activated'
  | 'subscription.canceled'
  | 'subscription.past_due'
  | 'payment.succeeded'
  | 'payment.failed'
  // Dunning lifecycle — emitted by `modules/billing/dunning.service.ts` when a
  // failed-payment recovery case opens, recovers, or exhausts (day 14 →
  // subscription canceled). Same transition-only + eventId-dedupe contract as
  // the billing events above.
  | 'dunning.case_opened'
  | 'dunning.case_recovered'
  | 'dunning.case_exhausted';

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

export const KNOWN_WEBHOOK_EVENTS: ReadonlyArray<WebhookEventType> = [
  'user.created',
  'user.updated',
  'user.deleted',
  'user.erased',
  'session.revoked',
  'mfa.enabled',
  'mfa.disabled',
  'password.changed',
  'email.verified',
  'subscription.activated',
  'subscription.canceled',
  'subscription.past_due',
  'payment.succeeded',
  'payment.failed',
  'dunning.case_opened',
  'dunning.case_recovered',
  'dunning.case_exhausted',
];

export function isKnownWebhookEvent(s: string): s is WebhookEventType {
  return (KNOWN_WEBHOOK_EVENTS as ReadonlyArray<string>).includes(s);
}

/** True if the subscriber's `events` list matches the given event type. */
export function endpointMatches(events: ReadonlyArray<string>, type: WebhookEventType): boolean {
  if (events.includes('*')) return true;
  return events.includes(type);
}
