/**
 * Generic `Idempotency-Key` header support (ENTERPRISE-ROADMAP §6).
 *
 * Opt-in per route via `config: { idempotency: true }` — never blanket-applied,
 * so existing route semantics can't regress. When an authenticated mutating
 * request (POST/PATCH/PUT/DELETE) carries the header, the first execution's
 * response is persisted and replays of the same request return it verbatim.
 *
 * Scoping — the key belongs to the authenticated principal:
 *   - API-key routes:        `req.application.id`  → scopeKey "app:<id>"
 *   - operator-session routes: `req.tenantId`      → scopeKey "tenant:<id>"
 * Two different Applications (or workspaces) can use the same key string
 * without ever seeing each other's cached responses. Requests with neither
 * principal (the hook runs after the onRequest auth middlewares) skip
 * idempotency entirely rather than sharing an anonymous scope.
 *
 * Semantics (one key = ONE logical operation per scope):
 *   - first request          → executes; {status, body} persisted on completion,
 *                              but only for 2xx/4xx — a 5xx deletes the
 *                              reservation so the client can retry for real.
 *   - replay, same fingerprint (method + path + body hash)
 *                            → stored response + `Idempotency-Replayed: true`.
 *   - same key, different fingerprint → 409 IDEMPOTENCY_KEY_REUSED.
 *   - concurrent duplicate while the first is in flight
 *                            → 409 IDEMPOTENCY_KEY_IN_FLIGHT with
 *                              `Retry-After: 1`. Deliberately the simple
 *                              deterministic option — we do not block the
 *                              second request waiting on the first.
 *   - key expired (24 h TTL) → row replaced, request re-executes.
 *
 * Mechanism: a "reservation" row (responseStatus NULL) is inserted in the
 * preHandler — the `(scopeKey, key)` unique constraint is the lock, so exactly
 * one of N concurrent duplicates executes. The onSend hook completes or
 * discards the reservation. If the process dies mid-request the orphaned
 * reservation is cleared by the TTL sweep (lib/token-prune.ts).
 *
 * Interaction with the credits-native key: `POST /credits/consume` and the
 * operator credits-grant accept a body-level `idempotencyKey` that dedupes at
 * the *ledger* level — that keeps working unchanged. The header is the
 * generic, route-agnostic mechanism layered above it.
 */

import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { RekeyError } from '../lib/error.js';
import { decryptJson, encryptJson } from '../lib/secrets.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt this route into generic Idempotency-Key header handling. */
    idempotency?: boolean;
  }
  interface FastifyRequest {
    /** Set by idempotencyPreHandler when this request holds the reservation. */
    idempotencyRecordId?: string | undefined;
  }
}

export const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_KEY_LENGTH = 200;

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

function fingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

const inFlightError = (): RekeyError =>
  new RekeyError({
    statusCode: 409,
    code: 'IDEMPOTENCY_KEY_IN_FLIGHT',
    message: 'A request with this Idempotency-Key is still being processed.',
    fix: 'Wait for the original request to finish, then retry with the same key to receive its stored response (honour the Retry-After header).',
    retryAfterSeconds: 1,
  });

/**
 * Instance-level preHandler (registered in app.ts, so it runs after the
 * onRequest auth middlewares and after body parsing/validation, but before
 * the route handler).
 */
export async function idempotencyPreHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (req.routeOptions.config?.idempotency !== true) return;
  if (!MUTATING_METHODS.has(req.method)) return;

  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return;
  if (Array.isArray(raw) || raw.length === 0 || raw.length > MAX_KEY_LENGTH) {
    throw new RekeyError({
      statusCode: 400,
      code: 'IDEMPOTENCY_KEY_INVALID',
      message: `The Idempotency-Key header must be a single value of 1–${MAX_KEY_LENGTH} characters.`,
      fix: 'Send one header with a stable unique string (a UUID works well), max 200 chars.',
    });
  }

  // Principal scope — auth middlewares (onRequest) have already run.
  let scopeKey: string;
  let applicationId: string | null = null;
  let tenantId: string | null = null;
  if (req.application) {
    scopeKey = `app:${req.application.id}`;
    applicationId = req.application.id;
    tenantId = req.application.tenantId;
  } else if (req.tenantId) {
    scopeKey = `tenant:${req.tenantId}`;
    tenantId = req.tenantId;
  } else {
    // No authenticated principal to scope to — behave as if no header was sent.
    return;
  }

  const method = req.method;
  const path = req.url; // includes query string — part of the fingerprint
  const requestHash = fingerprint(req.body);

  // Try to take the reservation. Loop once so an expired row can be replaced.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const created = await prisma.idempotencyKey.create({
        data: {
          scopeKey,
          key: raw,
          applicationId,
          tenantId,
          method,
          path,
          requestHash,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_KEY_TTL_MS),
        },
      });
      req.idempotencyRecordId = created.id;
      return; // we hold the reservation — execute the handler
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }

    const existing = await prisma.idempotencyKey.findUnique({
      where: { scopeKey_key: { scopeKey, key: raw } },
    });
    if (!existing) {
      // Lost the insert race AND the row vanished before we read it (a 5xx
      // cleanup or TTL sweep). One retry via the loop; if that loses too,
      // tell the client to come back.
      continue;
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      // Expired — remove it (guarded, so we never delete a fresh row that
      // replaced it concurrently) and retry the insert.
      await prisma.idempotencyKey.deleteMany({
        where: { id: existing.id, expiresAt: { lte: new Date() } },
      });
      continue;
    }

    if (existing.responseStatus === null) throw inFlightError();

    if (
      existing.method !== method ||
      existing.path !== path ||
      existing.requestHash !== requestHash
    ) {
      throw new RekeyError({
        statusCode: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key was already used for a different request (the method, path, or body does not match the original).',
        fix: 'An idempotency key identifies ONE logical operation. Reuse it only for byte-identical retries; generate a fresh key (e.g. a UUID) for new operations.',
      });
    }

    // Faithful replay — stored status + body, plus the replay marker. Bodies
    // are encrypted at rest (see onSend); a string responseBody is ciphertext.
    reply.header('Idempotency-Replayed', 'true');
    const storedBody =
      typeof existing.responseBody === 'string'
        ? decryptJson(existing.responseBody)
        : existing.responseBody;
    await reply.status(existing.responseStatus).send(storedBody);
    return;
  }

  throw inFlightError();
}

/**
 * Instance-level onSend — completes (2xx/4xx) or discards (5xx / non-JSON)
 * the reservation taken in the preHandler. Awaited deliberately: the row must
 * be durable before the client sees the response, otherwise an immediate
 * retry could race past a half-written reservation.
 */
export async function idempotencyOnSend(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const recordId = req.idempotencyRecordId;
  if (!recordId) return payload;
  // Guard against any double-send path: only the first onSend persists.
  req.idempotencyRecordId = undefined;

  const status = reply.statusCode;
  let parsedBody: unknown;
  let storable = status >= 200 && status < 500; // never cache 5xx
  if (storable) {
    try {
      const text =
        typeof payload === 'string'
          ? payload
          : Buffer.isBuffer(payload)
            ? payload.toString('utf8')
            : undefined;
      parsedBody = text === undefined || text === '' ? null : JSON.parse(text);
    } catch {
      storable = false; // non-JSON payload — don't attempt a replayable cache
    }
  }

  try {
    if (storable) {
      await prisma.idempotencyKey.update({
        where: { id: recordId },
        data: {
          responseStatus: status,
          // Encrypted at rest: covered routes can return secret material
          // (api-key mint returns the plaintext rawKey) and this cache must
          // not become a second, weaker home for it — the key itself is only
          // ever stored hashed. Ciphertext is a string, which is valid Json,
          // so no schema change. Replay decrypts (see preHandler).
          responseBody: parsedBody === null ? Prisma.JsonNull : encryptJson(parsedBody),
        },
      });
    } else {
      // 5xx (or unserializable body): drop the reservation so the client's
      // retry with the same key re-executes instead of replaying a failure.
      await prisma.idempotencyKey.deleteMany({ where: { id: recordId } });
    }
  } catch (err) {
    // Never fail the already-produced response over idempotency bookkeeping.
    req.log.warn({ err, recordId }, 'idempotency-key persistence failed');
  }
  return payload;
}
