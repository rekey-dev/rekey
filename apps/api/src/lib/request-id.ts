/**
 * Request-id generation.
 *
 * Fastify's default id is a per-process counter (`req-1`, `req-2`, … rendered
 * base36 so it reads as `req-f`, `req-ea`). That counter restarts at 1 on every
 * boot, so "share the request id with support" was useless advice: ids collide
 * across restarts and across replicas, and grepping `req-1` in an aggregated log
 * matches the first request of every deploy. Every error envelope quotes this
 * id, so it has to actually identify one request.
 *
 * We therefore mint a UUIDv4 per request. If the caller supplied its own
 * `X-Request-Id` we honour it so a trace spans the proxy → API boundary, but the
 * value is untrusted input that lands in structured logs: it is clamped to a
 * conservative charset and length before it goes anywhere near the logger.
 */

import { randomUUID } from 'node:crypto';

/**
 * Longest inbound id we echo. UUIDs are 36 chars and W3C `traceparent` is 55,
 * so 64 accommodates every sane format while bounding what a caller can push
 * into the log line and the response header.
 */
export const MAX_INBOUND_REQUEST_ID_LENGTH = 64;

/**
 * Characters kept from an inbound id. Deliberately narrow: no whitespace, no
 * control characters, no quotes/brackets — nothing that can forge a field
 * boundary in a log line or split a header. Covers UUID, ULID, traceparent,
 * and base64url shapes.
 */
const SAFE_REQUEST_ID_CHARS = /[^A-Za-z0-9._:@+=/-]/g;

/**
 * Sanitise a client-supplied request id. Returns `null` when there is nothing
 * usable left, which is the signal to mint a fresh one.
 */
export function normalizeInboundRequestId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(SAFE_REQUEST_ID_CHARS, '');
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, MAX_INBOUND_REQUEST_ID_LENGTH);
}

/** Collision-resistant id for a request that didn't bring one. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Fastify `genReqId`. Note `requestIdHeader: false` is set alongside this in
 * app.ts: Fastify's own header support would adopt the raw header value
 * unsanitised, so we take over the whole decision here.
 */
export function requestIdFor(headers: Record<string, unknown> | undefined): string {
  return normalizeInboundRequestId(headers?.['x-request-id']) ?? generateRequestId();
}
