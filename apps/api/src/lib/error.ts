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
 * The shape matches `@rekey.dev/shared-types` `RekeyErrorSchema` so the
 * SDK can decode without re-deriving.
 */

import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import {
  classifyDependencyOutage,
  isProviderSdkError,
  shouldRecordOutageEvent,
  OUTAGE_SUBSYSTEM_LABEL,
  type OutageSubsystem,
} from './dependency-outage.js';
import { recordSecurityEvent } from './security-events.js';

export interface RekeyErrorPayload {
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
 *   throw new RekeyError({
 *     statusCode: 404,
 *     code: 'TENANT_NOT_FOUND',
 *     message: `Tenant "${id}" not found.`,
 *     fix: 'List tenants with GET /api/v1/admin/tenants, or create one with POST.',
 *     docs: 'https://rekey.dev/errors/TENANT_NOT_FOUND',
 *   });
 * }
 * ```
 */
export class RekeyError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly fix: string | undefined;
  public readonly docs: string | undefined;
  public readonly retryAfterSeconds: number | undefined;

  constructor(args: RekeyErrorPayload & { statusCode?: number; cause?: unknown }) {
    // `cause` keeps the original exception attached without putting any of it
    // in the response. 5xx RekeyErrors are logged with it below, so a mapped
    // upstream failure still leaves a full backtrace in the server log.
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = 'RekeyError';
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

/**
 * Cap on how many field errors a validation response enumerates.
 *
 * A schema can produce one issue per field, and an object with many optional
 * keys can generate dozens from a single bad request. Ten is more than enough
 * to fix the call, and bounds a response body a caller controls the size of.
 */
const MAX_VALIDATION_ISSUES = 10;

/**
 * Turn a `ZodError` into the 400 envelope.
 *
 * This exists because the handler had no ZodError branch at all, so a raw
 * ZodError fell through to the generic 500 — and most of the routes that parse
 * with zod in the handler (every `/admin/metrics/*` endpoint among them)
 * declare no Fastify `querystring` schema, which makes that parse the ONLY
 * validator. `?limit=500`, `?sort=bogus` or `?order=sideways` therefore
 * answered `500 INTERNAL_ERROR` with "share this request id with support": a
 * server error for the caller's own typo, pointing them at the one place that
 * cannot help.
 *
 * `path` is the dotted field path (`""` for a whole-body failure) and
 * `message` is zod's own text, which already reads well ("Expected number,
 * received nan", "Unrecognized key(s) in object: 'dunningEnabld'"). Neither
 * can carry server internals — both are derived from the schema and the
 * caller's own input.
 */
function zodErrorPayload(err: ZodError): {
  code: string;
  message: string;
  fix: string;
  issues: Array<{ path: string; message: string }>;
} {
  const issues = err.issues.slice(0, MAX_VALIDATION_ISSUES).map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
  const omitted = err.issues.length - issues.length;
  const first = issues[0];
  return {
    code: 'VALIDATION_ERROR',
    message:
      first === undefined
        ? 'The request did not match the expected shape.'
        : first.path === ''
          ? first.message
          : `${first.path}: ${first.message}`,
    fix:
      omitted > 0
        ? `Fix the fields listed in \`issues\` (${omitted} further problem${omitted === 1 ? '' : 's'} not shown) and retry.`
        : 'Fix the fields listed in `issues` and retry.',
    issues,
  };
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
export function rekeyErrorHandler(
  err: FastifyError | RekeyError | Error,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  // Surface the Fastify-assigned request id on every error response. Clients
  // can grep server logs for this id to find the matching backtrace — much
  // more useful than the opaque message alone.
  const requestId = req.id;
  reply.header('X-Request-Id', requestId);

  if (err instanceof RekeyError) {
    if (err.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(err.retryAfterSeconds));
    }
    // A 5xx is a failure even when we chose its shape deliberately. Without
    // this, mapping an upstream provider exception onto a clean 502 traded the
    // caller's bad error message for a server log that no longer mentioned the
    // failure at all. 4xx stays unlogged — a rejected request is normal traffic.
    if (err.statusCode >= 500) {
      req.log.error({ err, requestId, code: err.code }, 'upstream or server failure');
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

  // A schema parse that failed is the CALLER's error, not ours. Checked before
  // the Fastify branch because a ZodError carries no `statusCode` at all and
  // would otherwise fall all the way through to the 500 below.
  if (err instanceof ZodError) {
    const payload = zodErrorPayload(err);
    // `info`, not `error`: a rejected request is normal traffic. Logging it at
    // error level is how a route that 400s on a typo ends up in an alert.
    req.log.info(
      { requestId, issues: payload.issues, route: req.routeOptions?.url ?? req.url },
      'request failed schema validation',
    );
    return reply.status(400).send({
      success: false,
      error: {
        code: payload.code,
        message: payload.message,
        fix: payload.fix,
        issues: payload.issues,
        requestId,
      },
    });
  }

  // Backstop for finding #3. A `StripeError` carries `.statusCode` and
  // `.message`, which is all the branch below needs to mistake it for a
  // framework 4xx: the provider's status passed through, its absent `.code`
  // collapsed to `BAD_REQUEST`, and the caller was told to check their request
  // shape — for a wrong key on the OPERATOR's provider account, with a
  // fragment of that key echoed back in `message`. Every known provider call
  // site now maps its own failures (see `lib/provider-errors.ts`); this
  // catches the one somebody adds later and forgets to wrap. Checked before
  // the duck-type, because the duck-type is exactly what goes wrong.
  if (isProviderSdkError(err)) {
    req.log.error({ err, requestId }, 'unmapped payment-provider error');
    return reply.status(502).send({
      success: false,
      error: {
        code: 'BILLING_PROVIDER_ERROR',
        message: 'The payment provider for this application rejected the request.',
        fix: `The provider's own message is in the server log against request id ${requestId}; it is withheld here because it can carry credential fragments. Re-check this Application's billing credentials and mode.`,
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
    // Durable, operator-visible trail. Throttled per (subsystem, tenant): an
    // outage hits every request, and a row each would bury the log it is meant to
    // explain. Fire-and-forget — an audit write must never replace the response.
    const outageTenantId = req.tenantId ?? req.application?.tenantId ?? null;
    if (shouldRecordOutageEvent(outage, outageTenantId)) {
      void recordSecurityEvent({
        type: 'system.dependency_unavailable',
        actorType: 'system',
        ...(outageTenantId !== null && { tenantId: outageTenantId }),
        ...(req.application?.id !== undefined && { applicationId: req.application.id }),
        ip: req.ip,
        metadata: { subsystem: outage, route: req.routeOptions?.url ?? req.url },
      });
    }
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
