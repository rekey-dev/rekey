/**
 * Hosted MCP account tools — read-only views of the *authenticated* end-user's
 * own ReliPay data, scoped to (applicationId, endUserId). No secrets are ever
 * returned (no key hashes, password hashes, provider creds).
 *
 * Each tool is a plain `{ name, description, inputSchema, handler }`. The MCP
 * JSON-RPC layer (mcp-server.ts) lists + dispatches them. Kept transport- and
 * SDK-agnostic so the handlers are unit-testable directly.
 */

import { prisma } from '../../lib/prisma.js';

export interface ToolContext {
  applicationId: string;
  endUserId: string;
}

export interface AccountTool {
  name: string;
  description: string;
  /** JSON Schema for tool arguments — all tools here are zero-arg. */
  inputSchema: { type: 'object'; properties: Record<string, unknown>; additionalProperties: boolean };
  handler: (ctx: ToolContext) => Promise<unknown>;
}

const NO_ARGS = { type: 'object' as const, properties: {}, additionalProperties: false };

export const accountTools: AccountTool[] = [
  {
    name: 'get_profile',
    description: "Get the signed-in user's profile (email, role, verification, metadata).",
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const u = await prisma.endUser.findFirst({
        where: { id: ctx.endUserId, applicationId: ctx.applicationId },
        select: { id: true, email: true, emailVerified: true, role: true, metadata: true, createdAt: true },
      });
      if (!u) return { error: 'not_found' };
      return { ...u, createdAt: u.createdAt.toISOString() };
    },
  },
  {
    name: 'get_subscription',
    description: "Get the signed-in user's current subscription + plan, or null if none.",
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const sub = await prisma.subscription.findFirst({
        where: {
          applicationId: ctx.applicationId,
          endUserId: ctx.endUserId,
          status: { in: ['ACTIVE', 'PAST_DUE'] },
        },
        orderBy: { createdAt: 'desc' },
        include: { plan: { select: { slug: true, name: true, interval: true, amount: true, currency: true } } },
      });
      if (!sub) return null;
      return {
        status: sub.status,
        provider: sub.provider,
        currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        cancelAt: sub.cancelAt?.toISOString() ?? null,
        plan: sub.plan,
      };
    },
  },
  {
    name: 'get_credits',
    description: "Get the signed-in user's prepaid credit balance.",
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const bal = await prisma.creditBalance.findUnique({
        where: { applicationId_subjectKey: { applicationId: ctx.applicationId, subjectKey: `u:${ctx.endUserId}` } },
        select: { balance: true },
      });
      return { balance: bal?.balance ?? 0 };
    },
  },
  {
    name: 'list_licenses',
    description: "List the signed-in user's licenses (no license keys are returned).",
    inputSchema: NO_ARGS,
    handler: async (ctx) => {
      const rows = await prisma.license.findMany({
        where: { applicationId: ctx.applicationId, endUserId: ctx.endUserId },
        select: {
          id: true,
          kind: true,
          status: true,
          seatsAllowed: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      return {
        licenses: rows.map((r) => ({
          ...r,
          expiresAt: r.expiresAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  },
];
