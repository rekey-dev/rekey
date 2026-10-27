/**
 * Operator MCP tools for support mode: see which accounts are in it, and end
 * a case. Opening and changing a case stay in the panel and the REST API,
 * where an operator picks the capabilities and writes the reason.
 *
 * `list_support_cases` returns the operator's reason, which is free text about
 * a customer. It is the same text the REST route returns to the same scope.
 * Notes are counted, never returned.
 */

import { z } from 'zod';
import { supportCasesService } from '../support-cases/support-cases.service.js';
import { parseArgs } from './operator-contact-tools.js';
import type { OperatorTool, OperatorToolContext } from './operator-tools.js';
import { loadAppInTenant, loadEndUserInApp } from './operator-write-tools.js';

const ID_MAX = 200;
const ID_ARG = { type: 'string', minLength: 1, maxLength: ID_MAX } as const;
const LIST_LIMIT_MAX = 100;

const ListArgs = z
  .object({
    applicationId: z.string().min(1).max(ID_MAX),
    status: z.enum(['open', 'closed']).default('open'),
    endUserId: z.string().min(1).max(ID_MAX).optional(),
    limit: z.number().int().min(1).max(LIST_LIMIT_MAX).default(25),
  })
  .strict();
const CloseArgs = z
  .object({ applicationId: z.string().min(1).max(ID_MAX), endUserId: z.string().min(1).max(ID_MAX) })
  .strict();

function actorOf(ctx: OperatorToolContext) {
  return {
    actorType: 'operator' as const,
    actorId: ctx.tenantUserId,
    tenantId: ctx.tenantId,
    via: 'operator_mcp' as const,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  };
}

export const operatorSupportTools: OperatorTool[] = [
  {
    name: 'list_support_cases',
    description:
      "List an application's support cases. status \"open\" (the default) is the accounts in support " +
      'mode now, oldest case first; "closed" is past cases, most recently opened first. Each case ' +
      'has its end-user, capabilities, scope, devices, the operator who opened it, their reason and ' +
      'noteCount (the notes themselves are not returned).',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        applicationId: ID_ARG,
        status: { type: 'string', enum: ['open', 'closed'], default: 'open' },
        endUserId: { ...ID_ARG, description: 'Only cases on this end-user.' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX, default: 25 },
      },
      required: ['applicationId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(ListArgs, 'list_support_cases', raw);
      const app = await loadAppInTenant(ctx, args.applicationId, 'read');
      const { items, total } = await supportCasesService.list(app.id, {
        status: args.status === 'open' ? 'OPEN' : 'CLOSED',
        endUserId: args.endUserId,
        take: args.limit,
        skip: 0,
      });
      return { total, cases: items };
    },
  },
  {
    name: 'close_support_case',
    description:
      "End an end-user's open support case: its capabilities stop being reported on the next read. " +
      'Returns the closed case, or case: null when none was open. Opening a new case is done in ' +
      'the panel or over the REST API.',
    write: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { applicationId: ID_ARG, endUserId: ID_ARG },
      required: ['applicationId', 'endUserId'],
      additionalProperties: false,
    },
    handler: async (ctx, raw) => {
      const args = parseArgs(CloseArgs, 'close_support_case', raw);
      const app = await loadEndUserInApp(ctx, args.applicationId, args.endUserId, 'write');
      return supportCasesService.end({ applicationId: app.id, endUserId: args.endUserId, actor: actorOf(ctx) });
    },
  },
];
