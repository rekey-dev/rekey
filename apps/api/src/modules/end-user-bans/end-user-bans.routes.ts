/**
 * Operator ban routes, `/api/v1/tenant/applications/:id/end-users/:euid/ban`.
 *
 * Operator-only on purpose: neither a secret key nor the end-user can ban or
 * unban. A leaked backend key must not be a way to lock every user out.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ok, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { requestContext } from '../../lib/security-events.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { BAN_REASON_MAX, endUserBansService, type BanActor } from './end-user-bans.service.js';

const Params = z.object({ id: z.string().min(1), euid: z.string().min(1) });
const BanBody = z.object({ reason: z.string() });

const PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, euid: { type: 'string' } },
  required: ['id', 'euid'],
} as const;

const BAN_STATE = {
  type: 'object',
  properties: {
    banned: { type: 'boolean' },
    bannedAt: { type: 'string', format: 'date-time', nullable: true },
    bannedBy: { type: 'string', nullable: true, description: 'Operator (TenantUser) id who placed the ban.' },
    bannedByEmail: {
      type: 'string',
      nullable: true,
      description: 'That operator\'s email, or null once they no longer exist.',
    },
    banReason: { type: 'string', nullable: true, description: 'Operator-only note. Never shown to the end-user.' },
  },
  required: ['banned', 'bannedAt', 'bannedBy', 'bannedByEmail', 'banReason'],
} as const;

const HISTORY_ENTRY = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['end_user.banned', 'end_user.unbanned'] },
    actorId: { type: 'string', nullable: true },
    actorEmail: { type: 'string', nullable: true },
    reason: { type: 'string', nullable: true, description: 'Null on unban, and after the end-user is erased.' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'type', 'actorId', 'actorEmail', 'reason', 'createdAt'],
} as const;

const ERRORS = {
  401:
    'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: ' +
    'the token is invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
    "TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED: the operator's grant on this Application " +
    'does not permit this action.',
  404:
    'APPLICATION_NOT_FOUND: no application with that id in this workspace (also returned to a ' +
    'MEMBER holding no grant on it); or END_USER_NOT_FOUND: no end-user with that id in this Application.',
} as const;

function actorOf(req: FastifyRequest): BanActor {
  const { ip, userAgent } = requestContext(req);
  return {
    // Set by requireTenantSession for every operator credential it admits.
    operatorUserId: req.tenantUser!.id,
    tenantId: req.tenantId ?? null,
    via: req.operatorTokenScopes ? 'token' : 'session',
    ip,
    userAgent,
  };
}

export async function tenantEndUserBanRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/end-users/:euid/ban',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Get an end-user's ban state and ban history",
        description:
          'Requires **read** access to this Application. History is the last 50 ban and unban ' +
          'events, newest first, with the acting operator.',
        params: PARAMS_SCHEMA,
        response: {
          200: ok(
            {
              type: 'object',
              properties: { state: BAN_STATE, history: { type: 'array', items: HISTORY_ENTRY } },
              required: ['state', 'history'],
            },
            'Current ban state and history.',
          ),
          ...errs(ERRORS),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await endUserBansService.get(id, euid) };
    },
  );

  app.post(
    '/:id/end-users/:euid/ban',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Ban an end-user from this Application',
        description:
          'Requires **write** access to this Application. Ends every session, OAuth/MCP grant, ' +
          'impersonation and outstanding sign-in link now. Until the ban is lifted, sign-in and ' +
          'existing session tokens answer `403 END_USER_BANNED`, OAuth/OIDC/MCP grants answer ' +
          '`invalid_grant` / `invalid_token`, and licence keys the user holds (not org-pooled ones) ' +
          'verify as `suspended`. Subscriptions keep billing; cancel them separately. The `reason` ' +
          'is operator-only. Banning a banned user returns the original ban with `alreadyBanned: true`.',
        params: PARAMS_SCHEMA,
        body: {
          type: 'object',
          required: ['reason'],
          // Length is checked by the service after trimming, so an empty or
          // over-long reason gets BAN_REASON_INVALID rather than a schema error.
          properties: {
            reason: { type: 'string', description: `1 to ${BAN_REASON_MAX} characters after trimming.` },
          },
        },
        response: {
          200: ok(
            {
              type: 'object',
              properties: {
                state: BAN_STATE,
                alreadyBanned: { type: 'boolean' },
                sessionsRevoked: { type: 'integer' },
              },
              required: ['state', 'alreadyBanned', 'sessionsRevoked'],
            },
            'The ban as it now stands.',
          ),
          ...errs({
            ...ERRORS,
            400: 'BAN_REASON_INVALID: `reason` is empty after trimming or longer than 500 characters.',
            410: 'END_USER_ERASED: the end-user was erased; there is nothing to ban.',
          }),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      const body = BanBody.parse(req.body ?? {});
      await ensureAppAccess(req, id, 'write');
      const data = await endUserBansService.ban({
        applicationId: id,
        endUserId: euid,
        reason: body.reason,
        actor: actorOf(req),
      });
      return { success: true, data };
    },
  );

  app.post(
    '/:id/end-users/:euid/unban',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Lift an end-user's ban",
        description:
          'Requires **write** access to this Application. The end-user can sign in again; ' +
          'sessions the ban ended stay ended. Idempotent: `wasBanned` is false when there was ' +
          'no ban to lift.',
        params: PARAMS_SCHEMA,
        response: {
          200: ok(
            {
              type: 'object',
              properties: { state: BAN_STATE, wasBanned: { type: 'boolean' } },
              required: ['state', 'wasBanned'],
            },
            'The end-user, no longer banned.',
          ),
          ...errs({ ...ERRORS, 410: 'END_USER_ERASED: the end-user was erased.' }),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const data = await endUserBansService.unban({ applicationId: id, endUserId: euid, actor: actorOf(req) });
      return { success: true, data };
    },
  );
}
