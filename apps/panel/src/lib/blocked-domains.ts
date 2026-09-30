/**
 * Blocked domains that stop at the apex: `x.com` listed with no `*.x.com`.
 *
 * A blocked `x.com` refuses only `x.com`, so `mail.x.com` still signs up. That
 * is the matching rule on purpose; this only tells the operator about it.
 *
 * @example
 * apexesWithoutWildcard('x.com\n*.y.com\ny.com'); // ['x.com']
 */
export function apexesWithoutWildcard(text: string): string[] {
  const entries = text
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const wildcards = new Set(entries.filter((e) => e.startsWith('*.')).map((e) => e.slice(2)));
  const apexes = entries.filter((e) => !e.startsWith('*.') && !wildcards.has(e));
  return [...new Set(apexes)];
}
