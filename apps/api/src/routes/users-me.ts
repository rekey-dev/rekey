/**
 * GET / PATCH /api/v1/users/me
 *
 * Returns — and now updates — the EndUser identified by the JWT in
 * `X-Rekey-User-Token`, scoped to the Application identified by the key in
 * `Authorization`.
 *
 * The PATCH exists because `EndUser.metadata` was readable and unwritable: the
 * schema advertises it as the place for display name, avatar and custom
 * fields, but every write path was operator-side, so an integrator could show
 * a profile and never let the user edit it. It is a self-service route in the
 * strictest sense — there is no id anywhere in it, so "someone else's record"
 * is not a request this route can express.
 *
 * This is the per-user counterpart to `/api/v1/me`, which returns the
 * *Application*. The two have deliberately DIFFERENT credential tiers, and the
 * difference is the point:
 *
 *   - This route takes the publishable key, because the end-user session is the
 *     authorizer and the response is that user's own record. A browser-only app
 *     reading its signed-in user's profile is the whole use case.
 *   - `/api/v1/me` stays secret-key-only, because it returns the Application's
 *     entire `authConfig` and `billingConfig`. Those are operator configuration,
 *     not user data, and handing them to anything holding a browser-shipped key
 *     would disclose the app's auth policy and billing setup.
 *
 * Nothing here needs redacting for a browser: `authService.getById` returns a
 * `PublicEndUser` (`passwordHash` stripped), and an erased user is rejected
 * before this handler runs, so `erasedBy` is always null on this path.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { organizationsService } from '../modules/organizations/organizations.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../middleware/api-key-auth.js';
import { requireUserSession } from '../middleware/user-session.js';
import { RekeyError } from '../lib/error.js';
import { authService } from '../modules/auth/auth.service.js';
import { ok, errs, ref } from '../lib/openapi.js';

// ---------------------------------------------------------------------------
// Shared error fragments — every route here sits behind
// requirePublishableOrSecretKey + requireScope('auth:read') + requireUserSession
// (see middleware/api-key-auth.ts, middleware/user-session.ts).
// ---------------------------------------------------------------------------

const USERS_ME_401 =
  'API_KEY_MISSING — no `Authorization: Bearer` header; or API_KEY_INVALID — the secret key is ' +
  'unknown, revoked, or expired; or PUBLISHABLE_KEY_INVALID — the publishable key is unknown or ' +
  'has rotated out of its grace window; or USER_TOKEN_MISSING — no `X-Rekey-User-Token` header; ' +
  'or USER_TOKEN_INVALID — the user token is invalid, expired, or signed with a different ' +
  'secret; or USER_TOKEN_WRONG_APPLICATION — the token was issued by a different Application; ' +
  'or IMPERSONATION_SESSION_ENDED — the impersonation session backing this token has ended.';

const USERS_ME_ERRORS = {
  401: USERS_ME_401,
  403:
    "IP_NOT_ALLOWED — a secret-key caller's IP is outside the Application's `ipAllowlist`; or " +
    "ORIGIN_NOT_ALLOWED — a publishable-key caller's `Origin` is outside `corsOrigins`; or " +
    'API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the required scope (`auth:read` for GET, ' +
    '`auth:read` + `auth:write` for PATCH).',
  404: 'END_USER_NOT_FOUND — the end-user behind this session no longer exists in this Application.',
  410: 'END_USER_ERASED — this end-user was erased (GDPR) and can no longer authenticate.',
  429: 'RATE_LIMITED — too many requests for this window. Honour the `Retry-After` header.',
} as const;

/**
 * `{...EndUser, activeOrganizationId, …}` — the shape both GET and PATCH return.
 *
 * This `allOf` was **unsatisfiable** until 2.0.0-rc.3. The `EndUser` component
 * is generated from `EndUserDtoSchema`, a `.strict()` zod object, and the
 * generator stamped `additionalProperties: false` on it. That made
 * `activeOrganizationId` simultaneously required by the second branch and
 * forbidden by the first: no JSON object could ever validate against this
 * declaration. `fromZod` (lib/openapi.ts) now strips the closed flag — those
 * components describe a floor, not a ceiling, which is what their own docblock
 * always claimed.
 *
 * The second branch also names the four fields the handler returns straight off
 * the Prisma row that `EndUserDto` does not model. They were undeclared before,
 * which under a closed schema was the same violation a second time.
 */
const END_USER_SELF_SCHEMA = {
  allOf: [
    ref('EndUser'),
    {
      type: 'object',
      properties: {
        activeOrganizationId: {
          type: 'string',
          nullable: true,
          description:
            "The organization this session is acting for, from the token's `oid` claim. " +
            'Null when the session has no active organization.',
        },
        activeOrganizationRole: {
          type: 'string',
          nullable: true,
          description:
            "The caller's role NAME inside the active organization. Null when there is no " +
            'active organization, or when membership lapsed since the token was minted. ' +
            'NOTE: this is a different axis from the sibling `role` field, which is ' +
            'application-wide and identical in every organization the user belongs to.',
        },
        activeOrganizationBaseRole: {
          type: 'string',
          enum: ['OWNER', 'ADMIN', 'MEMBER'],
          nullable: true,
          description:
            'The authority tier `activeOrganizationRole` maps to. Gate organization ' +
            'permissions on this, never on the role name and never on `role`.',
        },
        role: {
          type: 'string',
          description:
            "The end-user's APPLICATION-wide role: one value per (Application, end-user), " +
            'the same in every organization they belong to. For the organization-scoped role ' +
            'see `activeOrganizationRole`.',
        },
        updatedAt: { type: 'string', format: 'date-time' },
        erasedAt: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          description: 'Set when the record was erased under GDPR. Null for a live user.',
        },
        erasedBy: { type: 'string', nullable: true },
      },
      required: ['activeOrganizationId', 'activeOrganizationRole', 'activeOrganizationBaseRole', 'role', 'updatedAt'],
    },
  ],
};

/**
 * Self-service write surface — a **closed** allowlist.
 *
 * `.strict()` matters as much as the field list: an unknown key is refused
 * loudly (400) rather than dropped silently, so an integrator who tries
 * `{ role: "admin" }` or `{ email: … }` learns immediately that this route
 * will never carry it, instead of shipping code that appears to work and
 * quietly does nothing. See `authService.updateSelf` for why the list is
 * closed rather than a deny-list.
 *
 * The allowlist is about the TOP level of the body. One key inside `metadata`
 * is reserved too — `oidc`, the OIDC identity claims — and refused on the same
 * loud-not-silent principle by `updateSelf`; see lib/oidc-profile.ts.
 */
const UpdateSelfBody = z
  .object({
    metadata: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

export async function usersMeRoutes(app: FastifyInstance): Promise<void> {
  // Order matters: requireUserSession depends on request.application, which the
  // key hook sets.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  // No-ops for a publishable request by design — a publishable key carries no
  // scopes, so route membership plus the session is what constrains it.
  app.addHook('onRequest', requireScope('auth:read'));
  app.addHook('onRequest', requireUserSession);

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Auth'],
        summary: 'Get the current end-user (resolved from the user JWT)',
        description:
          'Requires an Application key (publishable or secret, Authorization header) AND the ' +
          'user JWT (X-Rekey-User-Token header). Callable from a browser with the publishable ' +
          'key, since the JWT is the authorizer and the response is that user\'s own record. ' +
          'Refuses to return data if the JWT was issued by a different Application than the ' +
          'key represents. Note `GET /api/v1/me` is different: it returns the Application, ' +
          'including its whole authConfig and billingConfig, so it stays secret-key-only.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(END_USER_SELF_SCHEMA, "The current end-user's own record."),
          ...errs({ ...USERS_ME_ERRORS }),
        },
      },
    },
    async (req) => {
      const active = await organizationsService.activeRoleFor({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        organizationId: req.activeOrganizationId,
      });
      return {
        success: true,
        data: {
          ...req.endUser!,
          activeOrganizationId: req.activeOrganizationId ?? null,
          activeOrganizationRole: active?.role ?? null,
          activeOrganizationBaseRole: active?.baseRole ?? null,
        },
      };
    },
  );

  app.patch(
    '/',
    {
      // Same credential tier as the GET (the plugin hooks above), plus
      // `auth:write` — the read scope must not buy a write, and this is the
      // posture every other user-session write route in the codebase uses
      // (see modules/organizations/organizations.routes.ts). It stays a no-op
      // for publishable callers for the reason given above: route membership,
      // not scopes, is what authorizes them, and this route's membership is
      // deliberate — a browser updating its own signed-in user's profile is
      // the whole use case.
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Auth'],
        summary: "Update the current end-user's own record",
        description:
          'Updates the EndUser identified by the X-Rekey-User-Token JWT. The token IS the ' +
          'authorizer, so this can only ever write the caller\'s own row — there is no id in ' +
          'the path and the write is scoped to (token subject, key\'s Application). ' +
          '**MERGE SEMANTICS (read this):** `metadata` is merged SHALLOWLY at the top level. ' +
          'A key you omit is left untouched; a key you send REPLACES that top-level key ' +
          'wholesale (nested objects are not deep-merged); a key sent as `null` is DELETED; ' +
          'and `"metadata": null` clears the whole object. Omitting `metadata` entirely ' +
          'changes nothing. Fields other than `metadata` are rejected with 400 — email, role, ' +
          'password and erasure state are not self-service and never will be on this route. ' +
          'One key INSIDE `metadata` is likewise refused (400 `METADATA_KEY_RESERVED`): `oidc`, ' +
          'which holds the OpenID Connect identity claims the Application asserts about this ' +
          'user to relying parties. Those are the operator\'s to write. Every other key, ' +
          'including ones that share a claim\'s name, stays yours.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: {
          type: 'object',
          properties: {
            metadata: {
              // Nullable, hence no `type` — `null` is the "clear it" signal and
              // a bare `type: 'object'` would reject it before the handler.
              description:
                'Free-form per-app metadata. Shallow-merged over what is stored; a top-level ' +
                'key set to null is deleted; null for the whole field clears it. ' +
                'Capped at 16KB serialized after the merge.',
            },
          },
        },
        response: {
          200: ok(END_USER_SELF_SCHEMA, "The current end-user's own record, after the update."),
          ...errs({
            ...USERS_ME_ERRORS,
            400:
              'END_USER_UPDATE_INVALID — the body failed the closed `metadata`-only schema; or ' +
              'METADATA_KEY_RESERVED — `metadata.oidc` is reserved for the operator; or ' +
              'METADATA_TOO_LARGE — `metadata` exceeds 16KB serialized after the merge.',
          }),
        },
      },
    },
    async (req) => {
      const parsed = UpdateSelfBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new RekeyError({
          statusCode: 400,
          code: 'END_USER_UPDATE_INVALID',
          message:
            'The update body is not accepted. Only `metadata` (an object, or null to clear) may be set here.',
          fix: 'Send { "metadata": { … } }. Email, role and password changes have their own routes and are not self-service.',
        });
      }

      const endUser = await authService.updateSelf({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        ...(parsed.data.metadata !== undefined && { metadata: parsed.data.metadata }),
      });

      return {
        success: true,
        data: { ...endUser, activeOrganizationId: req.activeOrganizationId ?? null },
      };
    },
  );
}
