/**
 * `GET /api/v1/tenant/applications/:id/end-users/:euid/insights`: what the
 * panel's end-user Overview shows beyond the account row. Its own route so the
 * detail route stays lean. See docs/analytics.md.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ok, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { endUserInsights } from './insights.service.js';
import { ONBOARDING_STATUS_JSON_SCHEMA, PROFILE_FIELD_JSON_SCHEMA } from './profile.routes.js';

const Params = z.object({ id: z.string().min(1), euid: z.string().min(1) });

const nullableString = { type: 'string', nullable: true } as const;

const INSIGHTS_SCHEMA = {
  type: 'object',
  properties: {
    signIns: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        lastSignedInAt: { type: 'string', format: 'date-time', nullable: true },
        lastSignInVia: nullableString,
        firstSignedInAt: { type: 'string', format: 'date-time', nullable: true },
        trackedSince: { type: 'string', format: 'date-time' },
        createdVia: {
          type: 'string',
          description:
            'How the account was created: password, magic_link, oauth:<provider>, passkey, operator, import or ' +
            'billing. `unknown` for accounts created before this was recorded.',
        },
      },
      required: ['count', 'lastSignedInAt', 'lastSignInVia', 'firstSignedInAt', 'trackedSince', 'createdVia'],
    },
    activity: {
      type: 'object',
      properties: {
        lastActiveOn: { type: 'string', format: 'date', nullable: true },
        last30: { type: 'array', items: { type: 'boolean' }, description: 'The last 30 UTC days, oldest first.' },
        last63: {
          type: 'array',
          items: { type: 'boolean' },
          description: 'The last 63 UTC days, oldest first: the whole window the activity bits remember.',
        },
        activeDaysLast7: { type: 'integer' },
        activeDaysLast30: { type: 'integer' },
      },
      required: ['lastActiveOn', 'last30', 'last63', 'activeDaysLast7', 'activeDaysLast30'],
    },
    platforms: {
      type: 'object',
      properties: {
        last: nullableString,
        seen: { type: 'array', items: { type: 'string' } },
        lastCountry: nullableString,
      },
      required: ['last', 'seen', 'lastCountry'],
    },
    sources: {
      type: 'array',
      description: 'Up to 5 places the user signs in from, newest first, from their recent sessions.',
      items: {
        type: 'object',
        properties: {
          platform: { type: 'string' },
          os: nullableString,
          browser: nullableString,
          appVersion: nullableString,
          country: nullableString,
          lastSeenAt: { type: 'string', format: 'date-time' },
          sessions: { type: 'integer' },
          live: { type: 'boolean' },
        },
        required: ['platform', 'os', 'browser', 'appVersion', 'country', 'lastSeenAt', 'sessions', 'live'],
      },
    },
    security: {
      type: 'object',
      properties: {
        mfaEnabled: { type: 'boolean' },
        passkeys: { type: 'integer' },
        oauthProviders: { type: 'array', items: { type: 'string' } },
      },
      required: ['mfaEnabled', 'passkeys', 'oauthProviders'],
    },
    profile: {
      type: 'object',
      properties: {
        fields: { type: 'array', items: PROFILE_FIELD_JSON_SCHEMA },
        answers: { type: 'object', additionalProperties: true },
        onboardingCompletedAt: { type: 'string', format: 'date-time', nullable: true },
        onboardingSkippedAt: { type: 'string', format: 'date-time', nullable: true },
        onboardingStatus: ONBOARDING_STATUS_JSON_SCHEMA,
        missingRequired: { type: 'array', items: { type: 'string' } },
      },
      required: ['fields', 'answers', 'onboardingCompletedAt', 'onboardingSkippedAt', 'onboardingStatus', 'missingRequired'],
    },
  },
  required: ['signIns', 'activity', 'platforms', 'sources', 'security', 'profile'],
} as const;

export async function insightsTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/end-users/:euid/insights',
    {
      config: { access: { scope: 'end-users:read' } },
      schema: {
        tags: ['Tenant · End-users'],
        security: [{ tenantSession: [] }],
        summary: "An end-user's sign-ins, activity, platforms and onboarding answers",
        description:
          'Requires **read** access to this Application. Sign-in counters, the last 30 active days, platforms ' +
          'and countries, up to 5 places they sign in from, security factors, and the profile answers against ' +
          'the schema. See docs/analytics.md.',
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, euid: { type: 'string' } },
          required: ['id', 'euid'],
        },
        response: {
          200: ok(INSIGHTS_SCHEMA, 'The insights.'),
          ...errs({
            401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
            403:
              "TENANT_MEMBERSHIP_REVOKED / TENANT_ROLE_INSUFFICIENT / APP_ACCESS_DENIED: the operator's grant " +
              'does not permit reading end users here.',
            404:
              'APPLICATION_NOT_FOUND: no application with that id in this workspace; or END_USER_NOT_FOUND: no ' +
              'end-user with that id in this Application.',
          }),
        },
      },
    },
    async (req) => {
      const { id, euid } = Params.parse(req.params);
      await ensureAppAccess(req, id, 'read');
      return { success: true, data: await endUserInsights(id, euid) };
    },
  );
}
