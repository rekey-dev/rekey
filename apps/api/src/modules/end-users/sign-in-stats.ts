import type { Prisma } from '@prisma/client';

/** What a sign-in knows about its client, when the route read it (lib/client-platform.ts). */
export interface SignInClient {
  platform: string;
  country: string | null;
}

/**
 * Count a real sign-in: stamp `lastSignedInAt` and `lastSignInVia`, add one
 * to `signInCount`, and note where it came from: `lastPlatform`, the platform
 * in `platformsSeen` once, and `lastCountry` when this sign-in has one (a
 * server-side sign-in keeps the last known country). Runs in the transaction
 * that writes the session's refresh row, so a sign-in that rolls back counts
 * nothing, and the increment happens in SQL, so racing sign-ins each count
 * once.
 *
 * Raw SQL so `updated_at` stays put: it is the OIDC `updated_at` claim, which
 * means "profile changed", and a sign-in changes no profile.
 *
 * @example
 *   await prisma.$transaction((tx) => recordSignIn(tx, endUser.id, 'passkey', { platform: 'web', country: 'DE' }));
 */
export async function recordSignIn(
  tx: Prisma.TransactionClient,
  endUserId: string,
  via: string,
  client: SignInClient | null = null,
): Promise<void> {
  const platform = client?.platform ?? null;
  const country = client?.country ?? null;
  await tx.$executeRaw`
    UPDATE "end_users"
       SET "last_signed_in_at" = now() AT TIME ZONE 'UTC',
           "last_sign_in_via" = ${via},
           "sign_in_count" = "sign_in_count" + 1,
           "last_platform" = COALESCE(${platform}::text, "last_platform"),
           "last_country" = COALESCE(${country}::char(2), "last_country"),
           "platforms_seen" = CASE
             WHEN ${platform}::text IS NULL OR ${platform}::text = ANY(COALESCE("platforms_seen", '{}')) THEN "platforms_seen"
             ELSE array_append(COALESCE("platforms_seen", '{}'), ${platform}::text)
           END
     WHERE "id" = ${endUserId}`;
}
