/** What a tool is, and the helpers every tool file shares. */

import { z } from 'zod';
import type { AdminClient } from './client.js';

export interface ToolDefinition<TArgs extends z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<TArgs>;
  execute: (client: AdminClient, args: z.infer<z.ZodObject<TArgs>>) => Promise<unknown>;
}

/**
 * A tool with its argument type checked against its own schema. The registry
 * holds tools of every shape, so each one is built through this.
 *
 * @example
 * defineTool({ name: 'get_x', description: '…', inputSchema: z.object({ id: z.string() }), execute: (c, args) => c.request('GET', `/x/${args.id}`) });
 */
export function defineTool<TArgs extends z.ZodRawShape>(tool: ToolDefinition<TArgs>): ToolDefinition<z.ZodRawShape> {
  return tool as unknown as ToolDefinition<z.ZodRawShape>;
}

/**
 * `limit` / `offset`, accepted by every offset-paged list endpoint. Merged
 * into each list tool's args so a model can page, and so a result capped at
 * the server default is never mistaken for the whole set.
 */
export const PagingArgs = {
  limit: z.number().int().min(1).max(100).optional().describe('Rows per page, 1-100. Default 50.'),
  offset: z.number().int().min(0).optional().describe('Rows to skip (0-based). Default 0.'),
};

/** Build `?a=b&…`, dropping undefined values. Returns '' when empty. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** How every tool that takes or returns money states the unit. */
export const MINOR_UNITS = 'integer, minor units of the currency (cents for USD, whole yen for JPY)';
