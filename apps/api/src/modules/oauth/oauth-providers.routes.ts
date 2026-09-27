import type { FastifyInstance } from 'fastify';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { ok, errs, ref } from '../../lib/openapi.js';
import { listEnabledOAuthProviders } from './enabled-providers.js';

/**
 * Long enough to absorb a sign-in page's repeat renders, short enough that a
 * provider the operator just enabled shows up within a minute. `private`
 * because the answer depends on the Authorization header: a shared cache
 * keyed on the URL alone would hand one Application's list to another.
 */
const CACHE_CONTROL = 'private, max-age=60';

const ERRORS = {
  401:
    'API_KEY_MISSING: no `Authorization: Bearer` header; or API_KEY_INVALID: the secret ' +
    'key is unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID: the publishable key ' +
    'is unknown or was rotated out.',
  403:
    'APPLICATION_DISABLED: the Application is disabled; or IP_NOT_ALLOWED: caller IP is ' +
    "outside the secret key's IP allowlist; or ORIGIN_NOT_ALLOWED: the browser `Origin` is " +
    "outside the publishable key's CORS allowlist; or API_KEY_SCOPE_INSUFFICIENT: the secret " +
    'key lacks the `auth:read` scope (a publishable request is pre-authorized for this route).',
  429: 'RATE_LIMITED: too many requests. Honour the `Retry-After` header.',
} as const;

/**
 * `GET /api/v1/auth/oauth/providers`, which social sign-in buttons a sign-in
 * page should render. Its own plugin because `oauthRoutes` requires
 * `auth:write` on every route, and listing is a read.
 */
export async function oauthProviderListRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/providers',
    {
      onRequest: [requirePublishableOrSecretKey, requireScope('auth:read')],
      schema: {
        tags: ['Public · OAuth'],
        summary: 'List the OAuth providers an end-user can sign in with',
        description:
          'Returns the providers this Application has configured with both a client id and a ' +
          'client secret, so a sign-in page can render one button per entry and start each ' +
          'with `POST /api/v1/auth/oauth/{id}/start`. Only the id and a display name: client ' +
          'ids, redirect URIs, scopes and secrets are never included. Accepts the publishable ' +
          `key. Cacheable for a minute (\`Cache-Control: ${CACHE_CONTROL}\`).`,
        security: [{ apiKey: [] }, { publishableKey: [] }],
        response: {
          // Not okArray: `providers` is bounded by the provider registry (seven
          // entries), and an object leaves room to add fields without a break.
          200: ok(
            {
              type: 'object',
              properties: { providers: { type: 'array', items: ref('OAuthProviderSummary') } },
              required: ['providers'],
            },
            'Enabled providers, in a stable order.',
          ),
          ...errs(ERRORS),
        },
      },
    },
    async (req, reply) => {
      reply.header('Cache-Control', CACHE_CONTROL);
      reply.header('Vary', 'Authorization, Origin');
      return { success: true, data: { providers: listEnabledOAuthProviders(req.application!) } };
    },
  );
}
