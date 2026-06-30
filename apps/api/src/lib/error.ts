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
    return reply.status(fastifyErr.statusCode).send({
      success: false,
      error: {
        code: fastifyErr.code ?? 'BAD_REQUEST',
        message: fastifyErr.message,
        fix: 'Check the request shape against the route schema in /docs.',
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
