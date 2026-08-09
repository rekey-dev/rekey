/**
 * Staleness gate for `lastUsedAt` telemetry writes.
 *
 * The API-key, operator-PAT and MCP bearer middlewares used to fire a
 * fire-and-forget `UPDATE ... SET last_used_at = now()` on EVERY authenticated
 * request. Fire-and-forget does not make a write free: each one checks out a
 * pooled connection, generates WAL, and at steady load every update for one
 * credential lands on the SAME row, serializing on its lock. A customer
 * backend at 500 rps produced 500 writes/s against one `api_keys` row.
 *
 * `lastUsedAt` is telemetry ("was this credential used recently"), so
 * minute-granularity is enough for every consumer (the panel's key list).
 * This gate remembers, per credential id, when this process last wrote the
 * bump and suppresses further writes for THROTTLE_MS.
 *
 * Multi-replica note: the map is per-process, so with N replicas the row is
 * written at most N times per window instead of once. That is still a ~500x
 * reduction at the loads that matter, and staleness semantics are unchanged
 * (each replica writes at least once per window while traffic flows).
 *
 * The map is bounded: when it grows past MAX_ENTRIES (revoked keys, churned
 * PATs) it is cleared outright. The cost of a clear is one extra UPDATE per
 * live credential, which is exactly the pre-throttle steady state for a
 * single request. Callers namespace their ids ("ak:", "pat:") so two models'
 * cuids can never alias each other.
 */

const THROTTLE_MS = 60_000;
const MAX_ENTRIES = 10_000;

const lastWritten = new Map<string, number>();

/**
 * Returns true when the caller should perform the `lastUsedAt` write for
 * `id`, and records the decision. Optimistic: the slot is claimed before the
 * write settles, so a failed write waits out the window instead of retrying
 * per-request. Acceptable for telemetry.
 */
export function shouldWriteLastUsed(id: string, now: number = Date.now()): boolean {
  const prev = lastWritten.get(id);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  if (lastWritten.size >= MAX_ENTRIES) lastWritten.clear();
  lastWritten.set(id, now);
  return true;
}

/** Test hook: forget all throttle state. */
export function resetLastUsedThrottle(): void {
  lastWritten.clear();
}
