/**
 * `get_user_analytics`: the Users overview for an agent. The same service,
 * sections, filters, cache and access as `GET .../analytics/users`: counts,
 * rates and dates only, never a person.
 */

import { AnalyticsUsersQuerySchema, ANALYTICS_SECTIONS } from '@rekey.dev/shared-types';
import { RekeyError } from '../../lib/error.js';
import { accessContextFromTool, applicationAccess } from '../../lib/access-context.js';
import { usersAnalytics } from '../analytics/users-analytics.service.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';

const STR = { type: 'string', maxLength: 200 } as const;

const QUERY_KEYS = [
  'range',
  'from',
  'to',
  'compare',
  'sections',
  'platform',
  'country',
  'via',
  'createdVia',
  'onboarding',
  'verified',
  'mfa',
  'plan',
  'paying',
  'org',
  'profileField',
] as const;

export const operatorAnalyticsTools: OperatorTool[] = [
  {
    name: 'get_user_analytics',
    description:
      "An application's Users overview: KPIs (total, new, DAU/WAU/MAU, stickiness, paying), activity over " +
      'time, audience mix, onboarding, retention, account health, and with billing:read subscription and usage ' +
      'counts. Arguments mirror GET /api/v1/tenant/applications/:id/analytics/users: `range` 7d|30d|90d|12m|custom ' +
      '(with `from`/`to` as YYYY-MM-DD), `sections` as a comma list of ' +
      `${ANALYTICS_SECTIONS.join(', ')}, and the filters as comma lists or "true"/"false". Every section names ` +
      'its timezone. Counts only, never people.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: { type: 'string', minLength: 1, maxLength: 200 },
        ...Object.fromEntries(QUERY_KEYS.map((k) => [k, STR])),
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const applicationId = typeof args.applicationId === 'string' ? args.applicationId : '';
      const app = await loadAppInTenant(ctx, applicationId);
      const access = await applicationAccess(accessContextFromTool({ ...ctx, scopes: ctx.scopes }), app.id, 'read', {
        scope: 'overview:read',
      });
      const raw: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) {
        if (k === 'applicationId') continue;
        if (typeof v !== 'string') {
          throw new RekeyError({
            statusCode: 400,
            code: 'VALIDATION_ERROR',
            message: `Invalid arguments for get_user_analytics: ${k} must be a string.`,
            fix: 'Pass every filter as a string: comma lists for several values, "true" or "false" for flags.',
          });
        }
        raw[k] = v;
      }
      const parsed = AnalyticsUsersQuerySchema.safeParse(raw);
      if (!parsed.success) {
        throw new RekeyError({
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: `Invalid arguments for get_user_analytics: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}.`,
          fix: "Check the arguments against get_user_analytics's inputSchema in tools/list.",
        });
      }
      return usersAnalytics({ applicationId: app.id, scopes: access.scopes, query: parsed.data, operatorId: ctx.tenantUserId });
    },
  },
];
