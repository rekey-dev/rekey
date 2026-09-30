import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/** Days `activityBits` remembers, counting `lastActiveOn` itself. */
export const ACTIVITY_WINDOW_DAYS = 63;

/** Today's UTC calendar day as a `@db.Date` value (midnight UTC). */
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Mark the user active today, at most once per UTC day: shift `activityBits`
 * left by the days since `lastActiveOn`, set bit 0 and move `lastActiveOn` to
 * today. A gap of 63 days or more starts the bits over. The WHERE clause makes
 * it a conditional claim, so concurrent refreshes write once and the rest
 * match no row.
 *
 * Called from sign-in and from both refresh paths, never per request. Pass the
 * `lastActiveOn` the caller already loaded to skip the statement entirely on a
 * second visit the same day. Returns whether this call made the claim.
 *
 * Raw SQL so `updated_at` (the OIDC `updated_at` claim) does not move.
 *
 * @example
 *   await claimDailyActivity(prisma, endUser.id, { lastActiveOn: endUser.lastActiveOn });
 */
export async function claimDailyActivity(
  client: Prisma.TransactionClient,
  endUserId: string,
  known?: { lastActiveOn: Date | null },
): Promise<boolean> {
  if (known?.lastActiveOn && known.lastActiveOn.getTime() >= utcToday().getTime()) return false;
  const claimed = await client.$executeRaw`
    UPDATE "end_users" AS eu
       SET "last_active_on" = t.today,
           "activity_bits" = CASE
             WHEN eu."last_active_on" IS NULL OR eu."activity_bits" IS NULL
               OR t.today - eu."last_active_on" >= ${ACTIVITY_WINDOW_DAYS}
             THEN 1::bigint::bit(63)
             ELSE (eu."activity_bits" << (t.today - eu."last_active_on")) | 1::bigint::bit(63)
           END
      FROM (SELECT (now() AT TIME ZONE 'UTC')::date AS today) AS t
     WHERE eu."id" = ${endUserId}
       AND (eu."last_active_on" IS NULL OR eu."last_active_on" < t.today)`;
  return claimed === 1;
}

/**
 * Add `platform` to the user's `platformsSeen` if it is not there yet. A
 * conditional append, so racing writers add it once, and a caller that loaded
 * the user skips the statement when the platform is already known.
 *
 * @example
 *   await notePlatformSeen(prisma, endUser.id, 'mcp', { platformsSeen: endUser.platformsSeen });
 */
export async function notePlatformSeen(
  client: Prisma.TransactionClient,
  endUserId: string,
  platform: string,
  known?: { platformsSeen: readonly string[] },
): Promise<void> {
  if (known?.platformsSeen.includes(platform)) return;
  await client.$executeRaw`
    UPDATE "end_users"
       SET "platforms_seen" = array_append(COALESCE("platforms_seen", '{}'), ${platform}::text)
     WHERE "id" = ${endUserId}
       AND NOT (${platform}::text = ANY(COALESCE("platforms_seen", '{}')))`;
}

/**
 * The day's activity claim plus the platform it came from, for a path where a
 * failure must not fail the request it rides on (a refresh, a token grant).
 * Activity is telemetry; a session is not. Pass the user when the caller
 * already loaded it, so a second visit the same day on a known platform costs
 * no statement at all.
 *
 * @example
 *   await recordActivitySafely(endUser, session.clientPlatform);
 *   await recordActivitySafely(endUserId, 'mcp');
 */
export async function recordActivitySafely(
  user: string | { id: string; lastActiveOn: Date | null; platformsSeen: readonly string[] },
  platform: string | null,
): Promise<void> {
  const id = typeof user === 'string' ? user : user.id;
  const known = typeof user === 'string' ? undefined : user;
  await claimDailyActivity(prisma, id, known).catch(() => false);
  if (platform) await notePlatformSeen(prisma, id, platform, known).catch(() => undefined);
}

/**
 * Which of the last `days` UTC days (oldest first, ending today) the user was
 * active, decoded from `lastActiveOn` and the bit(63) string Prisma returns.
 *
 * @example
 *   activeDays(user.lastActiveOn, user.activityBits, 30) // [false, ..., true]
 */
export function activeDays(
  lastActiveOn: Date | null,
  activityBits: string | null,
  days: number,
  today: Date = utcToday(),
): boolean[] {
  const out = Array.from({ length: days }, () => false);
  if (!lastActiveOn || !activityBits) return out;
  const bits = BigInt(`0b${activityBits}`);
  const lag = Math.round((today.getTime() - utcToday(lastActiveOn).getTime()) / 86_400_000);
  for (let i = 0; i < days; i++) {
    const n = days - 1 - i - lag;
    if (n >= 0 && n < ACTIVITY_WINDOW_DAYS) out[i] = ((bits >> BigInt(n)) & 1n) === 1n;
  }
  return out;
}
