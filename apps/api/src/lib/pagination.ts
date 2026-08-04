/**
 * Shared offset/limit pagination for operator (tenant) list endpoints.
 *
 * Every list endpoint that returns rows from a table that grows with usage
 * MUST bound its query — an unbounded `findMany` will eventually return tens
 * of thousands of rows and freeze/crash the panel that renders them. Use
 * `parsePagination(req.query)` to get a safe `{ take, skip }` (capped at
 * MAX_LIMIT) and, when the consumer needs to page beyond the first window,
 * return `pageMeta(total, take, skip)` alongside the rows.
 *
 * Offset (not cursor) pagination is deliberate: the panel renders numbered
 * pages over modest datasets and the existing endpoints already used `take`,
 * so offset is the smaller, consistent step. Switch a specific endpoint to
 * cursor pagination only if it proves hot on a very large table.
 */

import { z } from 'zod';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** Zod shape to merge into a route's querystring validation. */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
  // Upper-bounded deliberately: `.int().min(0)` alone accepts 1e20 — it IS an
  // integer — which then exceeds a 64-bit signed int inside Prisma's `skip`
  // and surfaces as a 500 with "share this request id with support". User
  // input must not produce a server error, and a caller paging past a million
  // rows has a different problem than pagination.
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});
export type PaginationInput = z.infer<typeof PaginationQuery>;

/** Fastify JSON-schema fragment for the same params (for swagger + coercion). */
export const paginationJsonSchema = {
  limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
  offset: { type: 'integer', minimum: 0, maximum: 2147483647 },
} as const;

/** Resolve `{ take, skip }` for Prisma from a parsed query. */
export function parsePagination(
  input: PaginationInput,
  defaultLimit: number = DEFAULT_LIMIT,
): { take: number; skip: number } {
  return {
    take: Math.min(input.limit ?? defaultLimit, MAX_LIMIT),
    skip: input.offset ?? 0,
  };
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/** Build the `page` envelope a paginated list endpoint returns next to `items`. */
export function pageMeta(total: number, take: number, skip: number): PageMeta {
  return { total, limit: take, offset: skip, hasMore: skip + take < total };
}

/**
 * The body of every paginated list response: `{items, page}`.
 *
 * This is the `data` of the `{success, data}` envelope, and it is what
 * `okPage()` (lib/openapi.ts) documents. It exists as a named type so a
 * handler cannot return `{items, ...pageMeta(...)}` — pagination flattened
 * one level up — and still typecheck; that flat variant shipped on
 * `GET /api/v1/admin/operator-invites` and the whole `admin/metrics` family
 * and disagreed with the published document on every one of them.
 */
export interface Paged<T> {
  items: T[];
  page: PageMeta;
}

/**
 * Build the `{items, page}` body from a page of rows and the total behind it.
 *
 * `total` must be the count of rows matching the SAME filter the rows came
 * from, ignoring `take`/`skip`. A count taken over a different `where` is
 * worse than no count: the caller pages off the end of a list the server told
 * it was longer.
 */
export function paged<T>(items: T[], total: number, take: number, skip: number): Paged<T> {
  return { items, page: pageMeta(total, take, skip) };
}
