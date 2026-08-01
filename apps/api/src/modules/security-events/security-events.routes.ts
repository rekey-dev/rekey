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
import { listSecurityEvents } from '../../lib/security-events.js';

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
            offset: { type: 'integer', minimum: 0 },
          },
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

      const events = await listSecurityEvents({
        tenantId: req.tenantId!,
        applicationId: q.applicationId,
        type: q.type,
        actorType: q.actorType,
        from: q.from,
        to: q.to,
        sort: q.sort,
        order: q.order,
        limit: q.limit,
        offset: q.offset,
      });
      return { success: true, data: { events } };
    },
  );
}
