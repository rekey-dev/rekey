/**
 * Operator MCP read tools for lists: which lists an Application has, and one
 * list's numbers. They return counts, never addresses, and there is no export
 * or erase tool: bulk personal data should not flow into an agent's context,
 * and erasure has no undo.
 *
 * Access is the REST routes' own: `audience:read` in TOOL_SCOPES for a
 * restricted member, and, per Application, the grant preset through
 * `applicationAccess`, so a viewer or billing grant is refused here exactly as
 * it is over HTTP.
 */

import { z } from 'zod';
import { RekeyError } from '../../lib/error.js';
import { accessContextFromTool, applicationAccess } from '../../lib/access-context.js';
import { prisma } from '../../lib/prisma.js';
import { listsService } from '../contacts/lists.service.js';
import type { OperatorTool, OperatorToolContext } from './operator-tools.js';
import { loadAppInTenant } from './operator-write-tools.js';

const ID_MAX = 200;
const ID_ARG = { type: 'string', minLength: 1, maxLength: ID_MAX } as const;

const ListArgs = z.object({ applicationId: z.string().min(1).max(ID_MAX) }).strict();
const StatsArgs = z.object({ applicationId: z.string().min(1).max(ID_MAX), key: z.string().min(1).max(64) }).strict();

function parseArgs<T extends z.ZodTypeAny>(schema: T, tool: string, args: Record<string, unknown>): z.infer<T> {
  const parsed = schema.safeParse(args);
  if (parsed.success) return parsed.data;
  throw new RekeyError({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: `Invalid arguments for ${tool}: ${parsed.error.issues.map((i) => i.message).join('; ')}.`,
    fix: `Check the arguments against ${tool}'s inputSchema in tools/list.`,
  });
}

async function readableApp(ctx: OperatorToolContext, applicationId: string) {
  const app = await loadAppInTenant(ctx, applicationId);
  await applicationAccess(accessContextFromTool({ ...ctx, scopes: ctx.scopes }), app.id, 'read', {
    scope: 'audience:read',
  });
  return app;
}

const DAY_MS = 86_400_000;

export const operatorContactTools: OperatorTool[] = [
  {
    name: 'list_contact_lists',
    description:
      "List an application's lists (waitlists, newsletters, contact forms) with their member and " +
      'submission counts, Public capture state and whether each is archived. Counts only, never ' +
      'addresses. Use a `key` here with get_contact_list_stats.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { applicationId: ID_ARG },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const { applicationId } = parseArgs(ListArgs, 'list_contact_lists', raw);
      const app = await readableApp(ctx, applicationId);
      const lists = await listsService.list(app.id);
      return {
        lists: lists.map((l) => ({
          key: l.key,
          name: l.name,
          kind: l.kind,
          publicCapture: l.publicCapture,
          archived: l.archivedAt !== null,
          subscribed: l.counts.subscribed,
          unsubscribed: l.counts.unsubscribed,
          submissions: l.counts.submissions,
        })),
      };
    },
  },
  {
    name: 'get_contact_list_stats',
    description:
      "One list's numbers: members by status, how many joined and left in the last 7 and 30 days, " +
      'how they joined (browser, your server, operator), and submissions. Counts only, never addresses.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: ID_ARG,
        key: { type: 'string', minLength: 1, maxLength: 64, description: 'The list key, from list_contact_lists.' },
      },
      required: ['applicationId', 'key'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const { applicationId, key } = parseArgs(StatsArgs, 'get_contact_list_stats', raw);
      const app = await readableApp(ctx, applicationId);
      const list = await prisma.contactList.findUnique({ where: { applicationId_key: { applicationId: app.id, key } } });
      if (!list) {
        throw new RekeyError({
          statusCode: 404,
          code: 'LIST_NOT_FOUND',
          message: `No list "${key}" in this application.`,
          fix: 'Call list_contact_lists with this applicationId to see the keys.',
        });
      }
      const now = Date.now();
      const since = (days: number) => new Date(now - days * DAY_MS);
      const [byStatus, bySource, joined7, joined30, left7, left30, submissions] = await Promise.all([
        prisma.contactListMember.groupBy({ by: ['status'], where: { listId: list.id }, _count: { _all: true } }),
        prisma.contactListMember.groupBy({ by: ['source'], where: { listId: list.id }, _count: { _all: true } }),
        prisma.contactListMember.count({ where: { listId: list.id, createdAt: { gte: since(7) } } }),
        prisma.contactListMember.count({ where: { listId: list.id, createdAt: { gte: since(30) } } }),
        prisma.contactListMember.count({ where: { listId: list.id, unsubscribedAt: { gte: since(7) } } }),
        prisma.contactListMember.count({ where: { listId: list.id, unsubscribedAt: { gte: since(30) } } }),
        prisma.contactSubmission.count({ where: { listId: list.id } }),
      ]);
      const count = (rows: Array<{ _count: { _all: number } } & Record<string, unknown>>, field: string, value: string) =>
        rows.find((r) => r[field] === value)?._count._all ?? 0;
      return {
        key: list.key,
        name: list.name,
        archived: list.archivedAt !== null,
        publicCapture: list.publicCapture,
        subscribed: count(byStatus, 'status', 'subscribed'),
        unsubscribed: count(byStatus, 'status', 'unsubscribed'),
        joined: { last7Days: joined7, last30Days: joined30 },
        left: { last7Days: left7, last30Days: left30 },
        source: {
          browser: count(bySource, 'source', 'publishable'),
          server: count(bySource, 'source', 'secret'),
          operator: count(bySource, 'source', 'operator'),
        },
        submissions,
      };
    },
  },
];
