/**
 * The list view (filter, page, page size) a Server Action lands back on.
 *
 * The view arrives as a bound argument, which the browser can rewrite, so only
 * the named keys survive and each must match its pattern. The result only ever
 * becomes the query of the action's own page.
 *
 * @example
 * keepQuery('status=FAILED&offset=50&next=//evil', { status: /^FAILED$/, offset: /^\d{1,7}$/ }).toString();
 * // 'status=FAILED&offset=50'
 */
export function keepQuery(raw: string, rules: Record<string, RegExp>): URLSearchParams {
  const from = new URLSearchParams(raw);
  const kept = new URLSearchParams();
  for (const [key, pattern] of Object.entries(rules)) {
    const value = from.get(key);
    if (value !== null && pattern.test(value)) kept.set(key, value);
  }
  return kept;
}
