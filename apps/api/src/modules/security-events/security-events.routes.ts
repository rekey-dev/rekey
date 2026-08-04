/**
 * Operator-facing security audit log.
 *
 * GET /api/v1/tenant/security-events — recent security events for the active
 * workspace (sign-ins, session kill-switch, API-key lifecycle, …). OWNER/ADMIN
 * only: the log carries IPs and event metadata that a plain MEMBER shouldn't
 * see. Read-only; the log is append-only and written best-effort elsewhere.
 *
 * Filters: `applicationId`, `type`, `actorType`, plus an inclusive
 * `from`/`to` createdAt window. `?format=csv` returns a downloadable CSV
 * instead of JSON — capped at CSV_MAX_ROWS rows (newest first), same
 * OWNER/ADMIN gate.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  requireTenantSession,
  requireTenantRole,
} from '../../middleware/tenant-session.js';
import { listSecurityEvents, countSecurityEvents } from '../../lib/security-events.js';
import { okPage, errs, ref } from '../../lib/openapi.js';
import { paged } from '../../lib/pagination.js';

/**
 * The 401/403 pair every `/api/v1/tenant/security-events` route shares —
 * `requireTenantSession` (401) runs as an `onRequest` hook, and
 * `requireTenantRole(['OWNER', 'ADMIN'])` (403) as the route `preHandler`,
 * both preceding the handler.
 */
const SECURITY_EVENTS_ERRORS = {
  401:
    'TENANT_SESSION_MISSING — no `Authorization: Bearer` header; or ' +
    'TENANT_SESSION_INVALID — the access token is invalid, expired, or the operator account no longer exists.',
  403:
    'TENANT_MEMBERSHIP_REVOKED — the operator is no longer a member of the active workspace; or ' +
    "TENANT_ROLE_INSUFFICIENT — the operator's live role is below OWNER/ADMIN.",
} as const;

const CSV_MAX_ROWS = 5000;

const Query = z.object({
  applicationId: z.string().min(1).optional(),
  type: z.string().min(1).max(80).optional(),
  actorType: z.enum(['operator', 'end_user', 'system']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['createdAt', 'type']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  format: z.enum(['json', 'csv']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/**
 * Quote a CSV cell. Doubles internal quotes; prefixes formula-trigger
 * characters (`= + - @`) with a single quote so a hostile user-agent string
 * can't become an executing formula when the export is opened in Excel.
 */
function csvCell(value: string | null): string {
  if (value === null || value === '') return '';
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export async function securityEventsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireTenantSession);

  app.get(
    '/',
    {
      preHandler: requireTenantRole(['OWNER', 'ADMIN']),
      schema: {
        tags: ['Tenant · Security'],
        security: [{ tenantSession: [] }],
        summary: 'List recent security events for the active workspace',
        description:
          'Requires the **OWNER or ADMIN** workspace role.',
        querystring: {
          type: 'object',
          properties: {
            applicationId: { type: 'string' },
            type: { type: 'string', maxLength: 80 },
            actorType: { type: 'string', enum: ['operator', 'end_user', 'system'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            sort: { type: 'string', enum: ['createdAt', 'type'] },
            order: { type: 'string', enum: ['asc', 'desc'] },
            format: { type: 'string', enum: ['json', 'csv'] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
          },
        },
        response: {
          200: {
            description:
              'Security events for the workspace. JSON by default; `?format=csv` returns a ' +
              'downloadable CSV file instead (same OWNER/ADMIN gate, capped at ' +
              `${CSV_MAX_ROWS} rows newest-first, and ignores \`limit\`/\`offset\`).`,
            content: {
              'application/json': {
                schema: okPage(ref('SecurityEvent'), 'Security events matching the filters.'),
              },
              'text/csv': {
                schema: {
                  type: 'string',
                  description:
                    'Header row `id,type,actorType,actorId,applicationId,ip,userAgent,metadata,createdAt` ' +
                    'followed by one row per event.',
                },
              },
            },
          },
          ...errs(SECURITY_EVENTS_ERRORS),
        },
      },
    },
    async (req, reply) => {
      const q = Query.parse(req.query);

      if (q.format === 'csv') {
        // CSV export ignores limit/offset — it's "give me the (filtered) log
        // as a file", newest first, capped so a huge tenant can't OOM us.
        const rows = await listSecurityEvents({
          tenantId: req.tenantId!,
          applicationId: q.applicationId,
          type: q.type,
          actorType: q.actorType,
          from: q.from,
          to: q.to,
          limit: CSV_MAX_ROWS,
          cap: CSV_MAX_ROWS,
        });
        const header = 'id,type,actorType,actorId,applicationId,ip,userAgent,metadata,createdAt';
        const lines = rows.map((r) =>
          [
            csvCell(r.id),
            csvCell(r.type),
            csvCell(r.actorType),
            csvCell(r.actorId),
            csvCell(r.applicationId),
            csvCell(r.ip),
            csvCell(r.userAgent),
            csvCell(JSON.stringify(r.metadata ?? {})),
            csvCell(r.createdAt.toISOString()),
          ].join(','),
        );
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="audit-log.csv"')
          .send([header, ...lines].join('\n') + '\n');
      }

      const filters = {
        tenantId: req.tenantId!,
        applicationId: q.applicationId,
        type: q.type,
        actorType: q.actorType,
        from: q.from,
        to: q.to,
      };
      // `listSecurityEvents` clamps `limit` to `cap` (200 here) and defaults it
      // to 50 — mirror both so `page` describes the window that was served.
      const limit = Math.min(q.limit ?? 50, 200);
      const offset = q.offset ?? 0;
      const [items, total] = await Promise.all([
        listSecurityEvents({ ...filters, sort: q.sort, order: q.order, limit, offset }),
        countSecurityEvents(filters),
      ]);
      return { success: true, data: paged(items, total, limit, offset) };
    },
  );
}
