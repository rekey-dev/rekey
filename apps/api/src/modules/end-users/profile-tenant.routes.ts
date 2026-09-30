/**
 * Profile fields on the operator surface: read and replace the Application's
 * profile schema, and set one end user's answers or complete or skip their
 * onboarding. Registered under
 * `/api/v1/tenant/applications`. See docs/profile-fields.md.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { assertEndUserInApplication } from '../../lib/end-users.js';
import { recordSecurityEvent, requestContext } from '../../lib/security-events.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { profileService } from './profile.service.js';
import {
  ONBOARDING_NEVER_GATES,
  PROFILE_FIELD_JSON_SCHEMA,
  PROFILE_PATCH_BODY,
  PROFILE_STATE_JSON_SCHEMA,
  PROFILE_WRITE_ERRORS,
  ProfilePatch,
  profileState,
} from './profile.routes.js';

const TENANT_ERRORS = {
  401:
    'TENANT_SESSION_MISSING: no `Authorization: Bearer` header; or TENANT_SESSION_INVALID: the token is ' +
    'invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED: the operator is no longer a member of this workspace; or ' +
    "TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED: the operator's grant on this Application does not permit " +
    'this action.',
  404: 'APPLICATION_NOT_FOUND: no application with that id in this workspace.',
} as const;
const END_USER_404 = TENANT_ERRORS[404] + ' Or END_USER_NOT_FOUND: no end-user with that id in this Application.';

const AppParams = z.object({ id: z.string().min(1) });
const APP_PARAMS_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
const UserParams = AppParams.extend({ euid: z.string().min(1) });
const USER_PARAMS_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, euid: { type: 'string' } },
  required: ['id', 'euid'],
} as const;
const FIELDS_RESPONSE = {
  type: 'object',
  properties: {
    fields: { type: 'array', items: PROFILE_FIELD_JSON_SCHEMA },
    version: { type: 'integer', description: 'Send it back with a PUT to refuse the write if another landed first.' },
  },
  required: ['fields', 'version'],
} as const;

export async function profileTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/profile-schema',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Read the Application's profile fields",
        description: 'Requires **read** access to this Application. The onboarding questions, in order.',
        params: APP_PARAMS_SCHEMA,
        response: { 200: ok(FIELDS_RESPONSE, 'The profile fields.'), ...errs(TENANT_ERRORS) },
      },
    },
    async (req) => {
      const { id } = AppParams.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await profileService.schemaWithVersion(id) };
    },
  );

  app.put(
    '/:id/profile-schema',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Replace the Application's profile fields",
        description:
          'Requires **write** access to this Application. Replaces the whole list. A field that any user has ' +
          'answered keeps its key and type: removing or retyping it is refused, and so is removing a select ' +
          'option users picked. Labels, flags and new options change freely. Send the `version` you read to ' +
          'refuse the write if someone else saved in between.',
        params: APP_PARAMS_SCHEMA,
        body: {
          type: 'object',
          required: ['fields'],
          properties: {
            fields: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: true } },
            version: {
              type: 'integer',
              minimum: 0,
              description: 'The `version` the fields were read at. When sent, a PUT made after another is refused.',
            },
          },
        },
        response: {
          200: ok(FIELDS_RESPONSE, 'The stored profile fields, with defaults filled in.'),
          ...errs({
            ...TENANT_ERRORS,
            400: 'PROFILE_SCHEMA_INVALID: the fields do not parse; `details.issues` names each problem.',
            409:
              'PROFILE_FIELD_KEY_IMMUTABLE: a field with answers was removed or retyped; `details.fields` counts ' +
              'the answers for each. Or PROFILE_OPTION_IN_USE: a select option users picked was removed ' +
              '(`details.options`). Or PROFILE_SCHEMA_CHANGED: `version` is not the current one.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = AppParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      const { fields, version } = z
        .object({ fields: z.unknown(), version: z.number().int().min(0).optional() })
        .parse(req.body);
      const stored = await profileService.putSchema(id, fields, version);
      void recordSecurityEvent({
        type: 'app.profile_schema_updated',
        actorType: 'operator',
        actorId: req.tenantUser!.id,
        tenantId: req.tenantId!,
        applicationId: id,
        ...requestContext(req),
        metadata: { keys: stored.fields.map((f) => f.key), version: stored.version },
      });
      return { success: true, data: stored };
    },
  );

  app.patch(
    '/:id/end-users/:euid/profile',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Set an end-user's profile answers",
        description:
          'Requires **write** access to this Application. Sets any field, including `writableBy: "server"` ones. ' +
          'Emits `user.updated` with `via: "operator"` when an answer changed.',
        params: USER_PARAMS_SCHEMA,
        body: PROFILE_PATCH_BODY,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers after the update.'),
          ...errs({
            ...TENANT_ERRORS,
            400: PROFILE_WRITE_ERRORS,
            404: END_USER_404,
            410: 'END_USER_ERASED: the account was erased.',
          }),
        },
      },
    },
    async (req) => {
      const { id, euid } = UserParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await assertEndUserInApplication(id, euid);
      const state = await profileService.update({
        applicationId: id,
        endUserId: euid,
        patch: ProfilePatch.parse(req.body ?? {}),
        writer: 'server',
        via: 'operator',
      });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/:id/end-users/:euid/onboarding/complete',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "Mark an end-user's onboarding complete",
        description:
          'Requires **write** access to this Application. Same rule as the end-user route: every required field ' +
          'must be answered. Emits `user.onboarding_completed` with `via: "operator"` the first time. ' +
          ONBOARDING_NEVER_GATES,
        params: USER_PARAMS_SCHEMA,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({
            ...TENANT_ERRORS,
            404: END_USER_404,
            409: 'PROFILE_INCOMPLETE: required fields are unanswered; `details.missing` lists their keys.',
            410: 'END_USER_ERASED: the account was erased.',
          }),
        },
      },
    },
    async (req) => {
      const { id, euid } = UserParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await assertEndUserInApplication(id, euid);
      const state = await profileService.completeOnboarding({ applicationId: id, endUserId: euid, via: 'operator' });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/:id/end-users/:euid/onboarding/skip',
    {
      config: { access: { scope: 'end-users:write' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: 'Record that an end-user skipped onboarding',
        description:
          'Requires **write** access to this Application. Records the first skip and emits ' +
          '`user.onboarding_skipped` with `via: "operator"`; a repeat or a skip after completion changes nothing. ' +
          ONBOARDING_NEVER_GATES,
        params: USER_PARAMS_SCHEMA,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({ ...TENANT_ERRORS, 404: END_USER_404, 410: 'END_USER_ERASED: the account was erased.' }),
        },
      },
    },
    async (req) => {
      const { id, euid } = UserParams.parse(req.params);
      await ensureAppAccess(req, id, 'write');
      await assertEndUserInApplication(id, euid);
      const state = await profileService.skipOnboarding({ applicationId: id, endUserId: euid, via: 'operator' });
      return { success: true, data: profileState(state) };
    },
  );
}
