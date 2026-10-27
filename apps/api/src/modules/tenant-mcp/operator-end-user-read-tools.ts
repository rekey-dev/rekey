/**
 * Operator MCP read tools for end-users: the paged list and one end-user's
 * credit balance. Each returns what its REST route returns to the same scope.
 */

import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { creditsService } from '../credits/credits.service.js';
import { END_USER_LIST_SELECT, endUserListRow } from '../end-users/list-rows.js';
import type { OperatorTool } from './operator-tools.js';
import { loadAppInTenant, loadEndUserInApp } from './operator-write-tools.js';
import { ApplicationIdArg, defineTool } from './tool-definition.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const LEDGER_ENTRIES = 50;

export const operatorEndUserReadTools: OperatorTool[] = [
  defineTool({
    name: 'list_end_users',
    description:
      "An application's end-users, newest first, the rows GET /applications/:id/end-users returns: id, email, " +
      'verification, role, metadata, profile, bannedAt, sign-in and activity dates, onboardingStatus and ' +
      '`createdVia`. `search` narrows to emails containing it. Pages with `limit` and `offset`; `total` counts ' +
      'every match. get_end_user has one end-user in full.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        search: z.string().min(1).max(254).optional().describe('A substring of the email, any case.'),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).max(1_000_000).default(0),
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadAppInTenant(ctx, input.applicationId, 'read');
      const where = { applicationId: app.id, ...(input.search && { email: { contains: input.search.toLowerCase() } }) };
      const [users, total] = await Promise.all([
        prisma.endUser.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          skip: input.offset,
          select: END_USER_LIST_SELECT,
        }),
        prisma.endUser.count({ where }),
      ]);
      return {
        endUsers: users.map(endUserListRow),
        total,
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + users.length < total,
      };
    },
  }),
  defineTool({
    name: 'get_end_user_credits',
    description:
      `An end-user's credit balance and their ${LEDGER_ENTRIES} most recent ledger entries, newest first. Each ` +
      'entry has a signed `delta`, the `reason`, `balanceAfter`, `description` and `metadata`.',
    args: z
      .object({
        applicationId: ApplicationIdArg,
        endUserId: z.string().min(1).max(200).describe('The end-user id, from list_end_users or get_end_user.'),
      })
      .strict(),
    annotations: READ_ONLY,
    run: async (ctx, input) => {
      const app = await loadEndUserInApp(ctx, input.applicationId, input.endUserId, 'read');
      const subject = { endUserId: input.endUserId };
      const [balance, ledger] = await Promise.all([
        creditsService.getBalance(app.id, subject),
        creditsService.listLedger(app.id, subject, { limit: LEDGER_ENTRIES }),
      ]);
      return {
        balance,
        ledger: ledger.map((e) => ({
          id: e.id,
          delta: e.delta,
          reason: e.reason,
          balanceAfter: e.balanceAfter,
          description: e.description,
          metadata: e.metadata,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    },
  }),
];
