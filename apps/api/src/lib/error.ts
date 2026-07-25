/**
 * Error infrastructure.
 *
 * Every error returned to clients carries:
 *   - `code`    — stable string, safe to switch/case on
 *   - `message` — human-readable
 *   - `fix`     — concrete remediation. The single most useful field for
 *                 both humans and AI agents — read this first when debugging.
 *   - `docs`    — optional URL to the long-form explanation.
 *
 * The shape matches `@relipay/shared-types` `RelipayErrorSchema` so the
 * SDK can decode without re-deriving.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  classifyDependencyOutage,
  OUTAGE_SUBSYSTEM_LABEL,
  type OutageSubsystem,
} from './dependency-outage.js';

export interface RelipayErrorPayload {
  code: string;
  message: string;
  fix?: string;
  docs?: string;
  /**
   * For 429 responses: rendered as a `Retry-After` header (in seconds).
   * Clients should honour this before retrying — most HTTP libraries
   * surface it automatically.
   */
  retryAfterSeconds?: number;
}

/**
 * Throw this anywhere inside a route or service. The global error handler
 * (registered in `app.ts`) turns it into the standard error envelope.
 *
 * @example
 * ```ts
 * if (!tenant) {
 *   throw new RelipayError({
 *     statusCode: 404,
 *     code: 'TENANT_NOT_FOUND',
 *     message: `Tenant "${id}" not found.`,
 *     fix: 'List tenants with GET /api/v1/admin/tenants, or create one with POST.',
 *     docs: 'https://relipay.dev/errors/TENANT_NOT_FOUND',
 *   });
 * }
 * ```
 */
export class RelipayError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly docs: string | undefined;
  public readonly retryAfterSeconds: number | undefined;

  constructor(args: RelipayErrorPayload & { statusCode?: number }) {
    super(args.message);
    this.name = 'RelipayError';
    this.statusCode = args.statusCode ?? 400;
    this.code = args.code;
    this.fix = args.fix;
    this.docs = args.docs;
    this.retryAfterSeconds = args.retryAfterSeconds;
  }
}

/**
 * Fastify's internal `FST_ERR_*` codes leaked straight to clients: a bad JSON
 * body answered `code: "FST_ERR_CTP_INVALID_JSON_BODY"`, which appears nowhere
 * in docs/errors.md and is a framework identifier, not part of our contract.
 * Map the ones a client can actually provoke onto documented codes; anything
 * else `FST_ERR_*` collapses to `BAD_REQUEST` (the documented catch-all for
 * Fastify-native 4xx) rather than escaping as-is.
 */
const FASTIFY_CODE_MAP: Record<string, { code: string; fix: string }> = {
  FST_ERR_VALIDATION: {
    code: 'BAD_REQUEST',
    fix: 'Check the request shape against the route schema in /docs.',
  },
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: 'BAD_REQUEST',
    fix: 'Send a syntactically valid JSON body.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    code: 'BAD_REQUEST',
    fix: 'Send a JSON body, or omit the Content-Type header if the route takes no body.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    fix: 'Send Content-Type: application/json',
  },
  FST_ERR_CTP_EMPTY_TYPE: {
    code: 'UNSUPPORTED_MEDIA_TYPE',
    fix: 'Send Content-Type: application/json',
  },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: {
    code: 'BAD_REQUEST',
    fix: 'Send a Content-Length that matches the body you wrote.',
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    code: 'PAYLOAD_TOO_LARGE',
    fix: 'Split the request — the body limit is 1 MiB.',
  },
};

const FALLBACK_4XX_FIX = 'Check the request shape against the route schema in /docs.';

/** Resolve a Fastify-native 4xx onto a documented `code` + `fix`. */
export function normalizeFastifyError(rawCode: string | undefined): {
  code: string;
  fix: string;
} {
  if (rawCode === undefined) return { code: 'BAD_REQUEST', fix: FALLBACK_4XX_FIX };
  const mapped = FASTIFY_CODE_MAP[rawCode];
  if (mapped) return mapped;
  // Unmapped framework code — never surface the `FST_ERR_*` identifier.
  if (rawCode.startsWith('FST_ERR')) return { code: 'BAD_REQUEST', fix: FALLBACK_4XX_FIX };
  return { code: rawCode, fix: FALLBACK_4XX_FIX };
}

/** How long we tell a client to wait out a dependency outage. */
const DEPENDENCY_RETRY_AFTER_SECONDS = 5;

/**
 * 503 envelope for a dead backing service. Names the subsystem so the operator
 * knows which process to look at, and points at `/health/ready` (which reports
 * `db` and `redis` individually). Carries no connection string, credential,
 * host, or port — the underlying error message is logged, never returned.
 */
export function dependencyUnavailablePayload(subsystem: OutageSubsystem): {
  statusCode: number;
  code: string;
  message: string;
  fix: string;
  retryAfterSeconds: number;
} {
  return {
    statusCode: 503,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: `The ${OUTAGE_SUBSYSTEM_LABEL[subsystem]} is unreachable, so this request could not be served.`,
    fix: 'Check GET /health/ready — it reports `db` and `redis` separately — then restore the failed dependency on this deployment and retry.',
    retryAfterSeconds: DEPENDENCY_RETRY_AFTER_SECONDS,
  };
}

/**
 * Fastify error handler. Normalises every error path into the canonical
 * envelope. Hides server-internal detail in production while keeping
 * `code` and a stable `message` clients can rely on.
 */
export function relipayErrorHandler(
  err: FastifyError | RelipayError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  // Surface the Fastify-assigned request id on every error response. Clients
  // can grep server logs for this id to find the matching backtrace — much
  // more useful than the opaque message alone.
  const requestId = req.id;
  reply.header('X-Request-Id', requestId);

  if (err instanceof RelipayError) {
    if (err.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(err.retryAfterSeconds));
    }
    return reply.status(err.statusCode).send({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fix !== undefined && { fix: err.fix }),
        ...(err.docs !== undefined && { docs: err.docs }),
        ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
        requestId,
      },
    });
  }

  const fastifyErr = err as FastifyError;
  if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
    const normalized = normalizeFastifyError(fastifyErr.code);
    return reply.status(fastifyErr.statusCode).send({
      success: false,
      error: {
        code: normalized.code,
        message: fastifyErr.message,
        fix: normalized.fix,
        requestId,
      },
    });
  }

  // A dead dependency is not an application bug and must not read like one:
  // 503 (retryable, and honest about who is at fault) naming the subsystem,
  // instead of the generic 500 every outage used to share.
  const outage = classifyDependencyOutage(err);
  if (outage) {
    req.log.error({ err, requestId, subsystem: outage }, 'dependency unavailable');
    const payload = dependencyUnavailablePayload(outage);
    reply.header('Retry-After', String(payload.retryAfterSeconds));
    return reply.status(payload.statusCode).send({
      success: false,
      error: {
        code: payload.code,
        message: payload.message,
        fix: payload.fix,
        retryAfterSeconds: payload.retryAfterSeconds,
        requestId,
      },
    });
  }

  req.log.error({ err, requestId }, 'unhandled error');
  return reply.status(500).send({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      fix: `Share request id ${requestId} with support — the matching server backtrace is keyed on it.`,
      requestId,
    },
  });
}
