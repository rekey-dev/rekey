/**
 * Centralised date / time formatting for the panel.
 *
 * `toLocaleDateString()` with no locale arg renders `5/19/2026` in en-US
 * vs `19/05/2026` in en-GB — operators on the same team see different
 * formats for the same timestamp. We standardise on ISO date (`YYYY-MM-DD`)
 * for dates and ISO-with-time (`YYYY-MM-DD HH:mm`) for timestamps. UTC is
 * the right default for shared operator workflows; we surface local time
 * via tooltip when needed.
 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * ISO date only — `2026-05-19`. UTC getters, not local: the value is then
 * independent of the server's TZ *and* identical between server render and
 * client hydration (these helpers are also used in client components).
 */
export function formatDate(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** ISO date + 24h time, UTC — `2026-05-19 14:32`. */
export function formatDateTime(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDate(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Relative ago: `2 min ago`, `5 hr ago`, falls through to formatDate past a week. */
export function formatRelative(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDate(d);
}
