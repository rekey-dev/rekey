/**
 * GET /.well-known/jwks.json — the deployment's RS256 public key set
 * (RFC 7517), for verifying END-USER access tokens minted by Applications
 * that opted into `authConfig.tokenAlg = "RS256"`.
 *
 * Public + unauthenticated by design: it serves only PUBLIC key material,
 * and offline verifiers (API gateways, edge middleware, @rekey.dev/node's
 * `verifyAccessToken`) must reach it without credentials. Registered at the
 * root (no /api/v1 prefix) — the well-known path is a fixed location per
 * RFC 8615.
 *
 * Includes rotated keys until their rows are deleted, so tokens signed just
 * before a rotation keep verifying through their (15-minute) lifetime.
 * Cached for 5 minutes (Cache-Control) — verifiers are told to poll on that
 * cadence, which also bounds how long a freshly minted rotation key takes to
 * propagate to offline verifiers.
 */

import type { FastifyInstance } from 'fastify';
import { getJwks } from '../lib/signing-keys.js';

export async function jwksRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/.well-known/jwks.json',
    {
      schema: {
        tags: ['Public · Auth'],
        security: [],
        summary: 'JSON Web Key Set (RS256 public keys for end-user access tokens)',
        description:
          'Public RSA keys (RFC 7517) for verifying RS256-signed end-user access tokens ' +
          'offline — no API call, no secret. Tokens carry the matching `kid` in their JWT ' +
          'header. Only Applications with `authConfig.tokenAlg = "RS256"` mint such tokens; ' +
          'the default HS256 tokens cannot be verified against this set. No authentication; ' +
          'responses are cacheable for 5 minutes.',
        response: {
          200: {
            type: 'object',
            properties: {
              keys: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    kty: { type: 'string', enum: ['RSA'] },
                    kid: { type: 'string' },
                    alg: { type: 'string', enum: ['RS256'] },
                    use: { type: 'string', enum: ['sig'] },
                    n: { type: 'string' },
                    e: { type: 'string' },
                  },
                  required: ['kty', 'kid', 'alg', 'use', 'n', 'e'],
                },
              },
            },
            required: ['keys'],
          },
        },
      },
    },
    async (_req, reply) => {
      // Standard JWKS body — NOT the { success, data } envelope; off-the-shelf
      // JWKS clients (jose, jwks-rsa, …) expect the raw RFC 7517 shape.
      const jwks = await getJwks();
      reply.header('cache-control', 'public, max-age=300');
      return jwks;
    },
  );
}
