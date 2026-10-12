import type { ListPage } from '@rekey.dev/shared-types';

/**
 * What an operator namespace needs to make a request: a sender that already
 * carries the operator token, and the path of the Application it acts on.
 */
export interface OperatorTransport {
  /** `/api/v1/tenant/applications/<id>`, with the id already encoded. */
  readonly base: string;
  send<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}

type QueryValue = string | number | boolean | Date | readonly string[] | undefined;

/**
 * A query string from the values that are set. Dates are sent as ISO 8601 and
 * lists joined with commas, as the operator routes read them.
 */
export function queryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (value instanceof Date) search.set(key, value.toISOString());
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') search.set(key, String(value));
    else if (value.length > 0) search.set(key, value.join(','));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function pageQuery(page: ListPage | undefined): Record<string, QueryValue> {
  return { limit: page?.limit, offset: page?.offset };
}

export const segment = (value: string): string => encodeURIComponent(value);
