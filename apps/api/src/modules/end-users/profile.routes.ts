/**
 * Profile fields on the end-user surfaces: the schema a signed-in app reads
 * to render its onboarding form, the user's own answers and onboarding
 * completion or skip, and the same writes for a secret key. The operator surface is in
 * `profile-tenant.routes.ts`. See docs/profile-fields.md.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ONBOARDING_STATUSES, PROFILE_FIELD_TYPES, onboardingStatus, type ProfileStateDto } from '@rekey.dev/shared-types';
import { ok, errs } from '../../lib/openapi.js';
import { requireApiKey, requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireUserSession } from '../../middleware/user-session.js';
import { profileService, type ProfileState } from './profile.service.js';

export const PROFILE_FIELD_JSON_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    type: { type: 'string', enum: [...PROFILE_FIELD_TYPES] },
    options: { type: 'array', items: { type: 'string' } },
    requiredForOnboarding: { type: 'boolean' },
    writableBy: { type: 'string', enum: ['user', 'server'] },
    showInList: { type: 'boolean' },
    pii: { type: 'boolean' },
  },
  required: ['key', 'label', 'type', 'requiredForOnboarding', 'writableBy', 'showInList', 'pii'],
} as const;

export const ONBOARDING_STATUS_JSON_SCHEMA = {
  type: 'string',
  enum: [...ONBOARDING_STATUSES],
  description:
    '`completed` once onboarding was completed (even after a skip), else `skipped` once it was skipped, else ' +
    '`pending`. Recorded only: Rekey gates nothing on it, your app decides where each user goes.',
} as const;

export const PROFILE_STATE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    profile: {
      type: 'object',
      additionalProperties: true,
      description: 'Answers keyed by field key: strings, numbers or booleans. A date is YYYY-MM-DD.',
    },
    onboardingCompletedAt: { type: 'string', format: 'date-time', nullable: true },
    onboardingSkippedAt: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description: 'When the user skipped onboarding. Kept after a later completion.',
    },
    onboardingStatus: ONBOARDING_STATUS_JSON_SCHEMA,
  },
  required: ['profile', 'onboardingCompletedAt', 'onboardingSkippedAt', 'onboardingStatus'],
} as const;

export const PROFILE_PATCH_BODY = {
  type: 'object',
  description: 'Answers to set, keyed by field key. `null` clears an answer; keys you omit are kept.',
  additionalProperties: true,
} as const;

export const PROFILE_WRITE_ERRORS =
  'PROFILE_FIELD_UNKNOWN: a key names no field in the profile schema; or PROFILE_FIELD_INVALID: an ' +
  "answer is not the shape its field takes (`details.issues`); or PROFILE_TOO_LARGE: the answers would " +
  'exceed 16 KB.';

export const ProfilePatch = z.record(z.unknown());

export function profileState(state: ProfileState): ProfileStateDto {
  return {
    profile: state.profile,
    onboardingCompletedAt: state.onboardingCompletedAt?.toISOString() ?? null,
    onboardingSkippedAt: state.onboardingSkippedAt?.toISOString() ?? null,
    onboardingStatus: onboardingStatus(state),
  };
}

export const ONBOARDING_NEVER_GATES =
  'Rekey records onboarding and never gates on it: sign-in and every other route work the same in any status.';

const PROFILE_INCOMPLETE_409 = 'PROFILE_INCOMPLETE: required fields are unanswered; `details.missing` lists their keys.';

const KEY_401 =
  'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: the key is missing, unknown, revoked or expired.';
const SESSION_401 =
  KEY_401 +
  ' Or USER_TOKEN_MISSING / USER_TOKEN_INVALID / USER_TOKEN_WRONG_APPLICATION: no valid `X-Rekey-User-Token` ' +
  'for this Application.';
const KEY_403 =
  "IP_NOT_ALLOWED / ORIGIN_NOT_ALLOWED: the caller is outside the Application's allowlist; or " +
  'API_KEY_SCOPE_INSUFFICIENT: the secret key lacks the scope this route needs.';

/** `GET /api/v1/profile-schema`. */
export async function profileSchemaPublicRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:read'));

  app.get(
    '/profile-schema',
    {
      schema: {
        tags: ['Public · Profile'],
        summary: "The Application's profile fields",
        description:
          'The onboarding questions to render. A publishable key gets only the fields the user may answer ' +
          '(`writableBy: "user"`); a secret key gets every field.',
        security: [{ publishableKey: [] }, { apiKey: [] }],
        response: {
          200: ok(
            { type: 'object', properties: { fields: { type: 'array', items: PROFILE_FIELD_JSON_SCHEMA } }, required: ['fields'] },
            'The fields, in the order the operator set.',
          ),
          ...errs({ 401: KEY_401, 403: KEY_403 }),
        },
      },
    },
    async (req) => {
      const fields = await profileService.schema(req.application!.id);
      const visible = req.authKind === 'secret' ? fields : fields.filter((f) => f.writableBy === 'user');
      return { success: true, data: { fields: visible } };
    },
  );
}

/** `PATCH /api/v1/users/me/profile` and `POST /api/v1/users/me/onboarding/complete` and `.../skip`. */
export async function profileSelfRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireScope('auth:read'));
  app.addHook('onRequest', requireUserSession);

  app.patch(
    '/profile',
    {
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Profile'],
        summary: "Answer the current end-user's profile fields",
        description:
          'Sets answers for the user behind `X-Rekey-User-Token`. Only fields with `writableBy: "user"` may be ' +
          'set here. Emits `user.updated` with `changed: ["profile.<key>", ...]` when an answer changed.',
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        body: PROFILE_PATCH_BODY,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers after the update.'),
          ...errs({
            400: PROFILE_WRITE_ERRORS,
            401: SESSION_401,
            403: KEY_403 + ' Or PROFILE_FIELD_READ_ONLY: a field is `writableBy: "server"`.',
            410: 'END_USER_ERASED: the account was erased.',
          }),
        },
      },
    },
    async (req) => {
      const state = await profileService.update({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        patch: ProfilePatch.parse(req.body ?? {}),
        writer: 'user',
        via: 'self',
      });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/onboarding/complete',
    {
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Profile'],
        summary: "Mark the current end-user's onboarding complete",
        description:
          'Succeeds once every field with `requiredForOnboarding` has an answer, stamps `onboardingCompletedAt` ' +
          'and emits `user.onboarding_completed`. Calling it again returns the same time and emits nothing. ' +
          'Allowed after a skip. ' +
          ONBOARDING_NEVER_GATES,
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({
            401: SESSION_401,
            403: KEY_403,
            409: PROFILE_INCOMPLETE_409,
            410: 'END_USER_ERASED: the account was erased.',
          }),
        },
      },
    },
    async (req) => {
      const state = await profileService.completeOnboarding({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        via: 'self',
      });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/onboarding/skip',
    {
      onRequest: requireScope('auth:write'),
      schema: {
        tags: ['Public · Profile'],
        summary: 'Record that the current end-user skipped onboarding',
        description:
          'Stamps `onboardingSkippedAt` and emits `user.onboarding_skipped`, whatever is answered. Calling it ' +
          'again, or after onboarding was completed, changes nothing and returns the current state. ' +
          ONBOARDING_NEVER_GATES,
        security: [
          { publishableKey: [], userToken: [] },
          { apiKey: [], userToken: [] },
        ],
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({ 401: SESSION_401, 403: KEY_403, 410: 'END_USER_ERASED: the account was erased.' }),
        },
      },
    },
    async (req) => {
      const state = await profileService.skipOnboarding({
        applicationId: req.application!.id,
        endUserId: req.endUser!.id,
        via: 'self',
      });
      return { success: true, data: profileState(state) };
    },
  );
}

const ServerParams = z.object({ id: z.string().min(1) });
const SERVER_PARAMS_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
const SERVER_404 = 'END_USER_NOT_FOUND: no end-user with that id in this Application.';

/** `PATCH /api/v1/users/:id/profile` and `POST /api/v1/users/:id/onboarding/complete` and `.../skip`, secret key only. */
export async function profileServerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  app.addHook('onRequest', requireScope('auth:write'));

  app.patch(
    '/:id/profile',
    {
      schema: {
        tags: ['Public · Profile'],
        summary: "Set an end-user's profile answers (server-side)",
        description:
          'Secret key only. Sets any field, including `writableBy: "server"` ones. Emits `user.updated` with ' +
          '`via: "server"` when an answer changed.',
        security: [{ apiKey: [] }],
        params: SERVER_PARAMS_SCHEMA,
        body: PROFILE_PATCH_BODY,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers after the update.'),
          ...errs({ 400: PROFILE_WRITE_ERRORS, 401: KEY_401, 403: KEY_403, 404: SERVER_404, 410: 'END_USER_ERASED: the account was erased.' }),
        },
      },
    },
    async (req) => {
      const { id } = ServerParams.parse(req.params);
      const state = await profileService.update({
        applicationId: req.application!.id,
        endUserId: id,
        patch: ProfilePatch.parse(req.body ?? {}),
        writer: 'server',
        via: 'server',
      });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/:id/onboarding/complete',
    {
      schema: {
        tags: ['Public · Profile'],
        summary: "Mark an end-user's onboarding complete (server-side)",
        description:
          'Secret key only. Same rule as the self-service route: every required field must be answered. ' +
          ONBOARDING_NEVER_GATES,
        security: [{ apiKey: [] }],
        params: SERVER_PARAMS_SCHEMA,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({
            401: KEY_401,
            403: KEY_403,
            404: SERVER_404,
            409: PROFILE_INCOMPLETE_409,
            410: 'END_USER_ERASED: the account was erased.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = ServerParams.parse(req.params);
      const state = await profileService.completeOnboarding({ applicationId: req.application!.id, endUserId: id, via: 'server' });
      return { success: true, data: profileState(state) };
    },
  );

  app.post(
    '/:id/onboarding/skip',
    {
      schema: {
        tags: ['Public · Profile'],
        summary: 'Record that an end-user skipped onboarding (server-side)',
        description:
          'Secret key only. Same rule as the self-service route: records the first skip and emits ' +
          '`user.onboarding_skipped` with `via: "server"`; a repeat or a skip after completion changes nothing. ' +
          ONBOARDING_NEVER_GATES,
        security: [{ apiKey: [] }],
        params: SERVER_PARAMS_SCHEMA,
        response: {
          200: ok(PROFILE_STATE_JSON_SCHEMA, 'The answers and the onboarding state.'),
          ...errs({ 401: KEY_401, 403: KEY_403, 404: SERVER_404, 410: 'END_USER_ERASED: the account was erased.' }),
        },
      },
    },
    async (req) => {
      const { id } = ServerParams.parse(req.params);
      const state = await profileService.skipOnboarding({ applicationId: req.application!.id, endUserId: id, via: 'server' });
      return { success: true, data: profileState(state) };
    },
  );
}
