/**
 * Offset paging for panel list pages — how "is there a next page?" is answered.
 *
 * ## Where the answer comes from now
 *
 * From the API. Every list endpoint returns
 * `{ success, data: { items, page: { total, limit, offset, hasMore } } }`, so
 * "there is another page" and "there are 36 of these in total" are facts in the
 * response rather than things the panel infers.
 *
 * ## What this replaces (twice over)
 *
 * 1. `<Pager>` originally inferred `hasMore = count === pageSize` — right until
 *    a result set is an exact multiple of the page size, then confidently
 *    wrong: 25 end-users at 25/page rendered a "Next →" onto a page reading
 *    "No results".
 * 2. That was replaced by an over-fetch: ask for `pageSize + 1` rows, and if
 *    the extra one arrives there is a next page. Correct, but it could not work
 *    at the panel's largest page size — `limit` is capped at 100 and 100/page
 *    would have needed `limit=101` — so the broken inference survived there.
 *    It also could not answer "of how many?", because a bare array carries no
 *    total.
 *
 * Both are gone. The endpoints report `hasMore` and `total` directly, and the
 * panel asks for exactly the rows it renders.
 */

/** Offset-pagination metadata, mirroring `pageMeta()` in the API. */
export interface PageMeta {
  /** Rows matching the query, ignoring `limit`/`offset`. */
  total: number;
  /** Rows requested for this window. */
  limit: number;
  /** Rows skipped before this window. */
  offset: number;
  /** True when another page exists (`offset + limit < total`). */
  hasMore: boolean;
}

/** The `data` of every paginated list response. */
export interface Page<T> {
  items: T[];
  page: PageMeta;
}

/**
 * A page with nothing in it, for the `.catch(() => …)` paths where a failed
 * side-panel fetch must not take the whole page down.
 */
export function emptyPage<T>(limit = 0): Page<T> {
  return { items: [], page: { total: 0, limit, offset: 0, hasMore: false } };
}
