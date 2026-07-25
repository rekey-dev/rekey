/**
 * Operator OAuth routes — social login for the PANEL. Public (the OAuth flow
 * IS the authentication), mounted under /api/v1/tenant/auth.
 *
 *   GET  /api/v1/tenant/auth/oauth/providers            configured provider names
 *   POST /api/v1/tenant/auth/oauth/:provider/start      → { authorizationUrl }
 *   POST /api/v1/tenant/auth/oauth/:provider/callback   → TenantSignInOutcome
 *
 * The panel owns CSRF: it sets a one-shot httpOnly `state` cookie on start and
 * verifies it on the callback. This layer only round-trips `state`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantOAuthService } from './tenant-oauth.service.js';
import type { TenantDeviceContext } from '../tenant-auth/tenant-auth.service.js';

const ProviderParam = z.object({ provider: z.string().min(1).max(40) });
const StartBody = z.object({ state: z.string().min(1).max(512) });
const CallbackBody = z.object({
  code: z.string().min(1).max(4096),
  // Single-use invite key — only consulted when this OAuth login would create
  // a NEW operator under OPERATOR_SIGNUP_MODE='invite'.
  inviteKey: z.string().min(1).max(512).optional(),
});

function deviceContext(req: { headers: Record<string, unknown>; ip: string }): TenantDeviceContext {
  const ua = req.headers['user-agent'];
  return {
    userAgent: typeof ua === 'string' ? ua.slice(0, 256) : null,
    ip: req.ip,
  };
}

export async function tenantOAuthPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/oauth/providers',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'List operator OAuth providers configured on this deployment',
      },
    },
    async () => ({ success: true, data: { providers: tenantOAuthService.configuredProviders() } }),
  );

  app.post(
    '/oauth/:provider/start',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'Begin operator OAuth sign-in — returns the provider authorization URL',
        params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['state'],
          properties: { state: { type: 'string', minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const { state } = StartBody.parse(req.body);
      return { success: true, data: await tenantOAuthService.buildAuthUrl({ provider, state }) };
    },
  );

  app.post(
    '/oauth/:provider/callback',
    {
      schema: {
        tags: ['Tenant · OAuth'],
        security: [],
        summary: 'Complete operator OAuth sign-in; mints a session (or an MFA challenge)',
        params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 4096 },
            inviteKey: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (req) => {
      const { provider } = ProviderParam.parse(req.params);
      const { code, inviteKey } = CallbackBody.parse(req.body);
      const result = await tenantOAuthService.handleCallback({
        provider,
        code,
        ...(inviteKey !== undefined && { inviteKey }),
        device: deviceContext(req as { headers: Record<string, unknown>; ip: string }),
      });
      return { success: true, data: result };
    },
  );
}
