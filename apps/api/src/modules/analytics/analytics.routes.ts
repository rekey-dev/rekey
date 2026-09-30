/**
 * `GET /api/v1/tenant/applications/:id/analytics/users`: the Users overview.
 * Counts, rates and dates only, never a person. See docs/analytics.md.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ANALYTICS_SECTIONS, AnalyticsUsersQuerySchema } from '@rekey.dev/shared-types';
import { ok, errs } from '../../lib/openapi.js';
import { ensureAppAccess } from '../../lib/app-access.js';
import { globalRateLimitKey, globalRateLimitMax } from '../../lib/rate-limit.js';
import { requireTenantSession } from '../../middleware/tenant-session.js';
import { usersAnalytics } from './users-analytics.service.js';
import { ANALYTICS_REQUESTS_PER_MINUTE } from './compute-limit.js';

const Params = z.object({ id: z.string().min(1) });


function analyticsRateKey(req: FastifyRequest): string {
  const id = (req.params as { id?: string }).id ?? '';
  return `an:${globalRateLimitKey(req)}:${id}`;
}

const str = { type: 'string' } as const;

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    range: { type: 'string', description: 'One of 7d, 30d, 90d, 12m, custom. Default 30d.' },
    from: { type: 'string', description: 'YYYY-MM-DD, with range=custom.' },
    to: { type: 'string', description: 'YYYY-MM-DD, with range=custom.' },
    compare: { type: 'string', description: 'One of prev, none. Default prev.' },
    sections: { type: 'string', description: `Comma list of ${ANALYTICS_SECTIONS.join(', ')}. Default: all.` },
    platform: { type: 'string', description: 'Comma list of platforms (the user\'s latest).' },
    country: { type: 'string', description: 'Comma list of ISO 3166-1 alpha-2 codes, at most 10.' },
    via: { type: 'string', description: 'Comma list of sign-in methods (the user\'s latest).' },
    createdVia: { type: 'string', description: 'Comma list: password, magic_link, oauth, oauth:<provider>, passkey, operator, import, billing, unknown.' },
    onboarding: { type: 'string', description: 'One of pending, completed, skipped.' },
    verified: { type: 'string', description: 'One of true, false.' },
    mfa: { type: 'string', description: 'One of true, false.' },
    plan: { type: 'string', description: 'A plan id of this Application. Needs billing:read.' },
    paying: { type: 'string', description: 'One of true, false. Needs billing:read.' },
    org: { type: 'string', description: 'An organization id of this Application. Needs organizations:read.' },
    profileField: { type: 'string', description: 'Profile field key for the onboarding answers. Needs end-users:read.' },
  },
} as const;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    asOf: { type: 'string', format: 'date-time' },
    range: {
      type: 'object',
      properties: {
        from: str,
        to: str,
        days: { type: 'integer' },
        timezone: str,
        compare: { type: 'object', nullable: true, properties: { from: str, to: str } },
      },
      required: ['from', 'to', 'days', 'timezone', 'compare'],
    },
    coverage: { type: 'object', additionalProperties: true },
    filters: { type: 'object', additionalProperties: true },
    sections: {
      type: 'object',
      additionalProperties: true,
      description:
        'One envelope per section: `{status:"ok",source,timezone,computedAt,cache,data,ignoredFilters,gaps}`, ' +
        '`{status:"error",error}`, `{status:"forbidden",scope}`, `{status:"pending",retryAfterSeconds}` or ' +
        '`{status:"unavailable",reason,fix}`. Shapes: `AnalyticsUsersResponse` in @rekey.dev/shared-types.',
    },
  },
  required: ['asOf', 'range', 'coverage', 'filters', 'sections'],
} as const;

export async function analyticsTenantRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/:id/analytics/users',
    {
      config: {
        access: { scope: 'overview:read' },
        rateLimit: {
          max: globalRateLimitMax(ANALYTICS_REQUESTS_PER_MINUTE),
          timeWindow: '1 minute',
          keyGenerator: analyticsRateKey,
        },
      },
      schema: {
        tags: ['Tenant · Analytics'],
        security: [{ tenantSession: [] }],
        summary: 'Users overview: KPIs, activity, mix, onboarding, retention, security, billing counts, usage',
        description:
          'Requires **read** access to this Application and `overview:read`. Plan and paying filters need ' +
          '`billing:read`, the organization filter `organizations:read`, `profileField` `end-users:read`. A ' +
          'section the caller lacks the scope for is `forbidden` when the default set was asked for, and 403 when ' +
          'it was named in `sections`. Every section succeeds or fails on its own. The live path counts UTC days; ' +
          'every section names its timezone. 120 requests a minute per operator per Application, of which at most 30 ' +
          'may compute an uncached section; cached sections do not count. See docs/analytics.md.',
        params: { type: 'object', properties: { id: str }, required: ['id'] },
        querystring: QUERY_SCHEMA,
        response: {
          200: ok(RESPONSE_SCHEMA, 'The requested sections.'),
          ...errs({
            400:
              'VALIDATION_ERROR: a malformed parameter; ANALYTICS_RANGE_INVALID: from after to, to after today, or ' +
              'a bad day; ANALYTICS_RANGE_TOO_LONG: longer than the path can answer; ANALYTICS_FILTER_UNSUPPORTED: ' +
              'an unknown section.',
            401: 'TENANT_SESSION_MISSING / TENANT_SESSION_INVALID: no valid operator session.',
            403:
              'SCOPE_INSUFFICIENT: no `overview:read`, or a filter or named section needs a scope the caller lacks; ' +
              'TENANT_MEMBERSHIP_REVOKED / APP_ACCESS_DENIED.',
            404:
              'APPLICATION_NOT_FOUND: no such Application in this workspace; PLAN_NOT_FOUND / ORGANIZATION_NOT_FOUND: ' +
              'the plan or organization filter names one this Application does not have.',
            429:
              'RATE_LIMITED: more than 120 requests, or more than 30 uncached section computations, a minute for ' +
              'this Application. Honour Retry-After.',
            503: 'ANALYTICS_BUSY: every requested section was waiting for a compute slot. Honour Retry-After.',
          }),
        },
      },
    },
    async (req) => {
      const { id } = Params.parse(req.params);
      const access = await ensureAppAccess(req, id, 'read');
      const query = AnalyticsUsersQuerySchema.parse(req.query ?? {});
      const data = await usersAnalytics({
        applicationId: id,
        scopes: access.scopes,
        query,
        log: req.log,
        operatorId: req.tenantUser!.id,
      });
      return { success: true, data };
    },
  );
}
