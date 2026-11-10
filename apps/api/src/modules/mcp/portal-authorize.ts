/**
 * The hosted portal as an Application's authorization page: the credential
 * rule for its calls to `/oauth/authorize/preview` and `/grant`, and
 * `/oauth/authorize/deny`, which only the portal calls.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RekeyError } from '../../lib/error.js';
import { authRateLimit } from '../../lib/rate-limit.js';
import { TOKEN_BODY_LIMIT } from '../../lib/body-limits.js';
import { errs, type JsonSchema } from '../../lib/openapi.js';
import { requirePublishableOrSecretKey } from '../../middleware/api-key-auth.js';
import { mcpOAuthService, resolveAuthServerApp } from './oauth.service.js';
import {
  AUTHORIZATION_REQUEST_ID,
  peekAuthorizationRequest,
  redirectWithAnswer,
  takeAuthorizationRequest,
} from './authorization-requests.js';

export const PortalGrantBody = z
  .object({
    request_id: z.string().regex(AUTHORIZATION_REQUEST_ID),
    organization_id: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

export const PortalGrantBodySchema: JsonSchema = {
  type: 'object',
  required: ['request_id'],
  properties: {
    request_id: {
      type: 'string',
      description: 'The id the authorization endpoint put on the hosted portal URL. Hosted portal only.',
    },
    organization_id: { type: 'string', nullable: true },
  },
};

export function authorizationRequestUnknown(): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'AUTHORIZATION_REQUEST_UNKNOWN',
    message:
      'This authorization request has expired, was already answered, belongs to another Application, or names a ' +
      'redirect URI its client no longer has registered.',
    fix:
      'Start again from the application that asked: it sends the browser back to /oauth/authorize, which issues a ' +
      'new request. If the client no longer lists the redirect URI it asks with, register that URI for the client ' +
      'again first, or the new request is refused too.',
  });
}

/**
 * A hosted-portal session asked to approve a client on an Application that
 * binds sign-in to a device. `details` carries the client's own name and
 * nothing else, so the portal can say whom it is sending back.
 */
export function authorizationNeedsDeviceSession(clientName: string | null): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'AUTHORIZATION_NEEDS_DEVICE_SESSION',
    message:
      'This Application binds sign-in to a device, so another app cannot be approved from its hosted portal.',
    fix:
      'End user: sign in from the application itself. Operator: authorization for an Application that binds ' +
      'sign-in to a device needs your own page, set as authConfig.hostedAuthorizeUrl and backed by your ' +
      'server; see docs/oidc-provider.md.',
    details: { client_name: clientName },
  });
}

/**
 * Security invariant: a publishable key is accepted here only with the
 * deployment caller secret. The publishable key and a user's access token
 * both reach browsers, so without this any script holding a user's token
 * could approve a client for them without the user ever seeing a consent
 * screen. The caller secret proves the request is the hosted portal's server,
 * which only answers after the user pressed Allow.
 */
export async function requirePortalCallerForPublishableKey(req: FastifyRequest): Promise<void> {
  if (req.authKind === 'publishable' && !req.internalCaller) {
    throw new RekeyError({
      statusCode: 403,
      code: 'SESSION_HANDOFF_FORBIDDEN',
      message: 'A publishable key can answer an authorization request only from the hosted portal.',
      fix: 'Call this from your server with the Application secret key.',
    });
  }
}

const DenyBody = z.object({ request_id: z.string().regex(AUTHORIZATION_REQUEST_ID) }).strict();

export async function portalAuthorizeDenyRoute(app: FastifyInstance): Promise<void> {
  app.post(
    '/:slug/oauth/authorize/deny',
    {
      bodyLimit: TOKEN_BODY_LIMIT,
      preHandler: [requirePublishableOrSecretKey, requirePortalCallerForPublishableKey, requirePortalKey],
      config: { rateLimit: authRateLimit(30) },
      schema: {
        tags: ['MCP · OAuth'],
        summary: 'Refuse an authorization request on the end-user’s behalf',
        description:
          'Hosted portal only: the publishable key plus the deployment caller secret. Spends the ' +
          'request and returns the redirect that carries `error=access_denied` (and the ' +
          "client's `state`) to the client's registered redirect URI. Grants nothing, so no user " +
          'token is needed.',
        body: {
          type: 'object',
          required: ['request_id'],
          properties: { request_id: { type: 'string' } },
        },
        response: {
          200: {
            description: 'Send the browser here.',
            type: 'object',
            properties: { redirect_to: { type: 'string' } },
            required: ['redirect_to'],
          },
          ...errs({
            400: 'AUTHORIZATION_REQUEST_UNKNOWN: the `request_id` expired, was answered, or belongs to another Application, or the client no longer has that redirect URI.',
            401: 'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID.',
            403: 'SESSION_HANDOFF_FORBIDDEN: the caller is not the hosted portal.',
            404: 'MCP_NOT_FOUND: the Application does not exist, or neither `authConfig.mcpEnabled` nor `authConfig.oidcEnabled` is on.',
            429: 'RATE_LIMITED: too many requests. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async (req, reply) => {
      const { slug } = z.object({ slug: z.string().min(1).max(40) }).parse(req.params);
      const application = await resolveAuthServerApp(slug);
      if (req.application?.id !== application.id) throw authorizationRequestUnknown();
      const { request_id: id } = DenyBody.parse(req.body ?? {});
      const peeked = await peekAuthorizationRequest(id);
      if (!peeked || peeked.applicationId !== application.id) throw authorizationRequestUnknown();
      const client = await mcpOAuthService.getClient(application.id, peeked.clientId);
      if (!client?.redirectUris.includes(peeked.redirectUri)) throw authorizationRequestUnknown();
      const request = await takeAuthorizationRequest(id);
      if (!request) throw authorizationRequestUnknown();
      return reply
        .header('cache-control', 'no-store')
        .send({ redirect_to: redirectWithAnswer(request, { error: 'access_denied' }) });
    },
  );
}

/** `/deny` answers the hosted portal and nobody else, a secret key included. */
async function requirePortalKey(req: FastifyRequest): Promise<void> {
  if (req.authKind !== 'publishable') {
    throw new RekeyError({
      statusCode: 403,
      code: 'SESSION_HANDOFF_FORBIDDEN',
      message: 'Only the hosted portal refuses an authorization request here.',
      fix: 'From your own authorization page, send the browser to the redirect URI with error=access_denied yourself.',
    });
  }
}
