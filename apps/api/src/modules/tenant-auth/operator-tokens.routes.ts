/**
 * Operator-PAT-gated tenant routes.
 *
 * These are the routes an AI agent (or any non-interactive automation) calls
 * with an operator personal-access-token (`Authorization: Bearer rp_op_…`)
 * instead of a short-lived session JWT — replacing reliance on the global
 * SUPER_ADMIN_KEY.
 *
 * Every route here authenticates via `resolveOperatorToken` (which decorates
 * req.tenantId / req.tenantUser / req.tenantRole exactly like a session) and is
 * default-deny on writes: the mint endpoint additionally requires the PAT to
 * carry the `keys:mint` scope. We deliberately reuse the existing services
 * (`applicationsService`, `apiKeysService`) and only add the PAT auth + scope
 * gate + tenant-ownership check — no duplicated business logic, no weakening of
 * the session-gated `/api/v1/tenant/applications/*` surface.
 *
 * Mounted under /api/v1/tenant/operator.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applicationsService } from '../applications/applications.service.js';
import { apiKeysService, MAX_KEYS_PER_APP } from '../api-keys/api-keys.service.js';
import { RekeyError } from '../../lib/error.js';
import {
  resolveOperatorToken,
  requireOperatorScope,
} from '../../middleware/operator-token-auth.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { ok, okPage, errs, ref } from '../../lib/openapi.js';
import { stripApplicationSecrets } from '../../lib/app-access.js';
import { PaginationQuery, parsePagination, paged, paginationJsonSchema } from '../../lib/pagination.js';

/**
 * The 401/403 pair `resolveOperatorToken` (middleware/operator-token-auth.ts) produces,
 * shared by every route in this plugin.
 */
const OPERATOR_PAT_ERRORS = {
  401: 'OPERATOR_TOKEN_INVALID — the PAT is missing, unknown, revoked, or expired.',
  403: "TENANT_MEMBERSHIP_REVOKED — the PAT's operator no longer has a membership in its bound workspace.",
} as const;

/**
 * Make sure the named application belongs to the workspace the PAT is bound to.
 * Same "not found" code for a cross-tenant app as the operator-session surface,
 * so a PAT can't be used as a tenant-enumeration oracle. That surface has since
 * moved to `lib/app-access.ts` `ensureAppAccess`, which additionally enforces
 * per-Application grants; this local helper only checks tenant ownership,
 * because a PAT's authority comes from its scopes, not from a membership row.
 */
async function ensureAppInTenant(
  applicationId: string,
  tenantId: string,
  role?: string,
): Promise<void> {
  // A PAT's authority was taken entirely from its scopes, and the live role the
  // middleware resolves was read by nothing. So a token minted by an ADMIN kept
  // full workspace power after that person was demoted to MEMBER — including
  // minting Application secret keys, which are durable credentials that outlive
  // the token. Membership EXISTENCE was re-checked; the role was not.
  //
  // Scopes bound what a token may do. They cannot stand in for whether its
  // holder is still allowed to do it.
  if (role !== undefined && role !== 'OWNER' && role !== 'ADMIN') {
    throw new RekeyError({
      statusCode: 403,
      code: 'TENANT_ROLE_INSUFFICIENT',
      message: 'This token was minted by a member who no longer has admin rights in this workspace.',
      fix: 'Have an owner or admin mint a new token, or restore the role.',
    });
  }
  try {
    // Scoped fetch: the tenant filter lives in the query itself, so a
    // cross-tenant id and a missing id are indistinguishable at the DB.
    await applicationsService.get(applicationId, { tenantId });
  } catch (e) {
    if (e instanceof RekeyError && e.code === 'APPLICATION_NOT_FOUND') {
      // Re-throw with the PAT surface's own wording (the service's `fix`
      // points at the admin list endpoint, which a PAT cannot call).
      throw new RekeyError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application "${applicationId}" not found in this workspace.`,
        fix: 'List applications via GET /api/v1/tenant/operator/applications.',
      });
    }
    throw e;
  }
}

const AppParam = z.object({ id: z.string().min(1) });

const MintKeyBody = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
});

export async function operatorTokenRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this plugin is authenticated by an operator PAT.
  app.addHook('onRequest', resolveOperatorToken);

  // ---------- Applications (read scope) ----------

  app.get(
    '/applications',
    {
      preHandler: requireOperatorScope('read'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'List Applications in the PAT\'s workspace (requires `read` scope)',
        querystring: { type: 'object', properties: { ...paginationJsonSchema } },
        response: {
          200: okPage(ref('Application'), "A page of Applications in the PAT's workspace."),
          ...errs({
            400: 'VALIDATION_ERROR — `limit` or `offset` is out of range.',
            401: OPERATOR_PAT_ERRORS[401],
            403:
              "TENANT_MEMBERSHIP_REVOKED — the PAT's operator no longer has a membership in " +
              'its bound workspace; or OPERATOR_SCOPE_INSUFFICIENT — the PAT does not carry ' +
              'the `read` scope.',
          }),
        },
      },
    },
    async (req) => {
      // This query used to be unbounded: `applicationsService.list(tenantId)`
      // with no take, so a workspace with thousands of Applications returned
      // all of them in one body. Bounded now, and the caller is told the total.
      const { take, skip } = parsePagination(PaginationQuery.parse(req.query));
      const [items, total] = await Promise.all([
        applicationsService.list(req.tenantId!, { take, skip }),
        applicationsService.count(req.tenantId!),
      ]);
      return {
        success: true,
        data: paged(items.map(stripApplicationSecrets), total, take, skip),
      };
    },
  );

  // ---------- API keys ----------

  app.get(
    '/applications/:id/api-keys',
    {
      preHandler: requireOperatorScope('read'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'List active API keys for an application (requires `read` scope)',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        response: {
          // The two sibling routes over the same resource
          // (`/tenant/applications/{id}/api-keys` and
          // `/admin/applications/{id}/api-keys`) are bare arrays, allow-listed
          // in test/openapi-contract.test.ts because active keys are hard-capped
          // at MAX_KEYS_PER_APP (25) on the write path. This route is NOT on that
          // list and the published document declares `{items, page}` for it, so
          // it returns the envelope. `page.hasMore` is always false in practice —
          // the cap sits below any page size — but the shape matches what the
          // contract says, which is what a generated client compiles against.
          200: okPage(ref('ApiKey'), 'A page of active (non-revoked) API keys for the application.'),
          ...errs({
            401: OPERATOR_PAT_ERRORS[401],
            403:
              "TENANT_MEMBERSHIP_REVOKED — the PAT's operator no longer has a membership in " +
              'its bound workspace; or OPERATOR_SCOPE_INSUFFICIENT — the PAT does not carry ' +
              'the `read` scope.',
            404: "APPLICATION_NOT_FOUND — no application with that id in the PAT's workspace.",
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppInTenant(id, req.tenantId!, req.tenantRole);
      const items = await apiKeysService.listForApplication(id);
      // No take/skip: the write path caps active keys at MAX_KEYS_PER_APP, so
      // the full set IS the page and `total` is exact rather than estimated.
      // `limit` is reported as the cap, not `items.length`, so an empty
      // Application does not claim it served a window of size 0.
      return { success: true, data: paged(items, items.length, MAX_KEYS_PER_APP, 0) };
    },
  );

  app.post(
    '/applications/:id/api-keys',
    {
      // Default-deny: minting an Application API key needs the 'keys:mint' scope.
      preHandler: requireOperatorScope('keys:mint'),
      schema: {
        tags: ['Tenant · Operator PAT'],
        security: [{ operatorPat: [] }],
        summary: 'Mint an Application API key via an operator PAT (requires `keys:mint` scope)',
        description:
          'Mints an Application secret key. The PAT must carry the `keys:mint` scope and be bound ' +
          'to the workspace that owns the application. The `rawKey` is shown exactly once.',
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            scopes: { type: 'array', items: { type: 'string' } },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        response: {
          201: ok(
            {
              type: 'object',
              properties: {
                apiKey: ref('ApiKey'),
                rawKey: { type: 'string', description: 'The raw secret key. Shown once.' },
                warning: { type: 'string' },
              },
              required: ['apiKey', 'rawKey', 'warning'],
            },
            'The minted Application API key. `rawKey` is shown exactly once.',
          ),
          ...errs({
            400:
              'API_KEY_EXPIRY_IN_PAST — `expiresAt` is not in the future; or ' +
              'API_KEY_LIMIT_REACHED — the application already has the maximum active keys.',
            401: OPERATOR_PAT_ERRORS[401],
            403:
              "TENANT_MEMBERSHIP_REVOKED — the PAT's operator no longer has a membership in " +
              'its bound workspace; or OPERATOR_SCOPE_INSUFFICIENT — the PAT does not carry ' +
              'the `keys:mint` scope.',
            404: "APPLICATION_NOT_FOUND — no application with that id in the PAT's workspace.",
          }),
        },
      },
    },
    async (req, reply) => {
      const { id } = AppParam.parse(req.params);
      await ensureAppInTenant(id, req.tenantId!, req.tenantRole);
      const body = MintKeyBody.parse(req.body);
      const result = await apiKeysService.create({
        applicationId: id,
        name: body.name,
        scopes: body.scopes,
        ...(body.expiresAt !== undefined && { expiresAt: new Date(body.expiresAt) }),
      });
      void recordSecurityEvent({
        type: 'app.api_key.created',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        // Note the actor authenticated via PAT, for forensics.
        metadata: {
          apiKeyId: result.apiKey.id,
          name: body.name,
          scopes: body.scopes,
          via: 'operator_pat',
        },
      });
      return reply.status(201).send({
        success: true,
        data: {
          apiKey: result.apiKey,
          rawKey: result.rawKey,
          warning:
            'Store this rawKey now — it is shown exactly once and cannot be recovered. Treat it like a database password.',
        },
      });
    },
  );
}
