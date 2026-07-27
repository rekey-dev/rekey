/**
 * Bootstrap admin auth.
 *
 * Routes under `/api/v1/admin/*` require the `SUPER_ADMIN_KEY` env value
 * presented as a Bearer token. This is the credential Rekey operators use
 * to bootstrap the first Tenant + Application (and to manage them via CLI
 * before the panel ships).
 *
 * It is *not* the credential a customer's application uses — those are
 * Application-scoped API keys minted via this admin surface.
 *
 * Comparison is constant-time to avoid token-leak via timing side channel.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { RekeyError } from '../lib/error.js';

export async function requireSuperAdmin(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!presented) {
    throw new RekeyError({
      statusCode: 401,
      code: 'ADMIN_AUTH_MISSING',
      message: 'Admin endpoints require an Authorization: Bearer <SUPER_ADMIN_KEY> header.',
      fix: 'Set SUPER_ADMIN_KEY in your .env, then send `Authorization: Bearer <that value>`.',
    });
  }

  const expected = Buffer.from(env.SUPER_ADMIN_KEY, 'utf8');
  const actual = Buffer.from(presented, 'utf8');

  // Length pre-check is safe — leaking that the wrong-length key was wrong is
  // not material (an attacker already knows their guess length).
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new RekeyError({
      statusCode: 401,
      code: 'ADMIN_AUTH_INVALID',
      message: 'The presented admin key does not match SUPER_ADMIN_KEY.',
      fix: 'Verify the value of SUPER_ADMIN_KEY in your .env matches the one you are sending.',
    });
  }
}
