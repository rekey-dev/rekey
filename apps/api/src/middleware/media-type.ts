/**
 * Content-Type gate.
 *
 * `@fastify/formbody` is registered globally because the MCP OAuth
 * token/authorize/register/introspect endpoints legitimately accept
 * `application/x-www-form-urlencoded` bodies (RFC 6749/7591/7662). The side
 * effect was that a form-encoded POST to a JSON route *parsed successfully* and
 * then failed schema validation, producing a 400 that blamed a field the caller
 * had in fact sent (`body must have required property 'email'` for
 * `email=…&password=…`). Nothing in the API returned 415, so the one class of
 * mistake HTTP has a dedicated status for was reported as a payload bug.
 *
 * `text/plain` had the same shape for a different reason — Fastify parses it by
 * default, so a JSON payload sent with the wrong header became a string and then
 * failed validation as "not an object".
 *
 * This hook therefore requires JSON on any route that didn't opt into form
 * encoding, and answers a real 415 otherwise. Media types with no parser at all
 * still reach Fastify's own 415 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`), normalised to
 * this same `UNSUPPORTED_MEDIA_TYPE` code in lib/error.ts, so the two paths agree.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelipayError } from '../lib/error.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Route accepts `application/x-www-form-urlencoded`. Set only on the MCP
     * OAuth endpoints, where the spec mandates form encoding.
     */
    acceptsForm?: boolean;
  }
}

const FORM_MEDIA_TYPE = 'application/x-www-form-urlencoded';
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);

/** Media type without parameters, lowercased. */
function mediaTypeOf(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const [type] = header.split(';');
  return type ? type.trim().toLowerCase() : null;
}

/** Does the request actually carry a body? An empty POST is not a media-type error. */
function hasBody(req: FastifyRequest): boolean {
  if (typeof req.headers['transfer-encoding'] === 'string') return true;
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length > 0;
}

export async function rejectUnsupportedMediaType(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!METHODS_WITH_BODY.has(req.method)) return;
  // No route matched — let the 404 win rather than pre-empting it with a 415.
  if (req.routeOptions?.url === undefined) return;
  if (!hasBody(req)) return;

  const mediaType = mediaTypeOf(req.headers['content-type']);
  // No Content-Type at all is Fastify's to reject (FST_ERR_CTP_EMPTY_TYPE),
  // which lib/error.ts maps to this same code.
  if (mediaType === null) return;
  if (mediaType === 'application/json' || mediaType.endsWith('+json')) return;
  if (mediaType === FORM_MEDIA_TYPE && req.routeOptions.config?.acceptsForm === true) return;

  throw new RelipayError({
    statusCode: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: `This endpoint does not accept "${mediaType}" bodies.`,
    fix: 'Send Content-Type: application/json',
  });
}
