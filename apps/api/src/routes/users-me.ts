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
import { requirePublishableOrSecretKey, requireScope } from '../middleware/api-key-auth.js';
import { requireUserSession } from '../middleware/user-session.js';
import { RekeyError } from '../lib/error.js';
import { authService } from '../modules/auth/auth.service.js';

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
      },
    },
    async (req) => {
      return {
        success: true,
        data: { ...req.endUser!, activeOrganizationId: req.activeOrganizationId ?? null },
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
