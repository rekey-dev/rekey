const DAY_MS = 86_400_000;

/**
 * A UTC day as an operator reads it at a glance: `Today`, `Yesterday`,
 * `12 days ago`, then the ISO date past a month.
 *
 * @example
 * formatActiveDay('2026-09-28T00:00:00.000Z', new Date('2026-09-30T10:00:00Z')) // "2 days ago"
 */
export function formatActiveDay(day: string, now: Date = new Date()): string {
  const d = new Date(day);
  if (Number.isNaN(d.getTime())) return '';
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((today - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days <= 30) return `${days} days ago`;
  return d.toISOString().slice(0, 10);
}
