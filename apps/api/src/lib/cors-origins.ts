/**
 * Per-Application CORS origin cache.
 *
 * CORS is enforced before any API key is known (preflight is unauthenticated),
 * so we can't look up "which app" per request. Instead the API allows any
 * origin registered by ANY Application: the union of every app's `corsOrigins`,
 * cached in memory. The `@fastify/cors` origin callback is synchronous, so it
 * reads the snapshot directly; the cache is primed at boot and refreshed in the
 * background on a short TTL (plus eagerly when a tenant edits their origins).
 */

import { prisma } from './prisma.js';
import { portalBaseOrigin } from './portal-origins.js';

let cache = new Set<string>();
let loadedAt = 0;
let refreshing: Promise<void> | null = null;
const TTL_MS = 30_000;

/**
 * Page size the refresh walks the `applications` table in, and the overall
 * ceiling on how many contributing applications it will read.
 *
 * There used to be no `where` and no `take` on this query at all: every 30
 * seconds, forever, the whole `applications` table was loaded into memory. On
 * a single-tenant self-host that is a handful of rows; on the hosted product it
 * grows with total customer count, on a fixed timer, whether or not anyone is
 * calling the API.
 *
 * Two changes bound it. The `where` skips applications that contribute nothing
 * to the union — no CORS origins registered AND no hosted portal — which is
 * most of them, because `corsOrigins` is opt-in configuration. And the read is
 * paged with a cursor, so peak memory is one page rather than the whole table.
 *
 * MAX_APPS is a real, lossy ceiling: past it, later applications' origins are
 * simply not in the union and their browser requests are refused. That is
 * deliberate — an unbounded read of a multi-tenant table on a 30s timer is the
 * worse failure — and the number is far above any plausible deployment. The
 * warning below is what tells an operator they have reached it.
 */
const APPS_PAGE_SIZE = 1_000;
const MAX_APPS = 20_000;

async function load(): Promise<void> {
  const next = new Set<string>();
  let anyPortal = false;
  let cursor: string | undefined;
  let seen = 0;
  for (;;) {
    const page = await prisma.application.findMany({
      // Only applications that can contribute an origin.
      where: {
        OR: [{ NOT: { corsOrigins: { isEmpty: true } } }, { hostedPortalEnabled: true }],
      },
      select: {
        id: true,
        corsOrigins: true,
        hostedPortalEnabled: true,
        portalDomain: true,
        portalDomainVerifiedAt: true,
      },
      orderBy: { id: 'asc' },
      take: APPS_PAGE_SIZE,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
    });
    for (const app of page) {
      for (const origin of app.corsOrigins) {
        if (origin) next.add(origin);
      }
      // Verified custom portal domains call the API from their own origin.
      if (app.hostedPortalEnabled) {
        anyPortal = true;
        if (app.portalDomain && app.portalDomainVerifiedAt) {
          next.add(`https://${app.portalDomain}`);
        }
      }
    }
    seen += page.length;
    if (page.length < APPS_PAGE_SIZE) break;
    if (seen >= MAX_APPS) {
      console.warn(
        `[cors] stopped building the origin union at ${MAX_APPS} applications; origins ` +
          'registered past that point are NOT allowed. Raise MAX_APPS in lib/cors-origins.ts.',
      );
      break;
    }
    cursor = page[page.length - 1]!.id;
  }
  // The shared hosted-portal host serves every opted-in app from one origin —
  // when this deployment runs one at all (PUBLIC_PORTAL_URL has no default).
  const portalOrigin = portalBaseOrigin();
  if (anyPortal && portalOrigin) next.add(portalOrigin);
  cache = next;
  loadedAt = Date.now();
}

/** Warm the cache once at boot (before the CORS plugin is registered). */
export async function primeCorsOrigins(): Promise<void> {
  await load();
}

/** Force an immediate reload — call after a tenant mutates its origins. */
export async function refreshCorsOrigins(): Promise<void> {
  await load();
}

/**
 * Whether `origin` is registered by some Application. Synchronous for the CORS
 * callback; kicks off a background refresh when the snapshot is stale and
 * answers from the current snapshot meanwhile.
 */
export function isRegisteredAppOrigin(origin: string): boolean {
  if (Date.now() - loadedAt > TTL_MS && !refreshing) {
    refreshing = load()
      .catch(() => undefined)
      .finally(() => {
        refreshing = null;
      });
  }
  return cache.has(origin);
}

/**
 * Drop the snapshot so the next read re-loads from the DB.
 *
 * Test-only. The snapshot is module-level and lives behind a 30s TTL, so an
 * origin registered by an application a TRUNCATE has since removed stays
 * allowed for every test that follows within that window. Called from
 * test/setup.ts's beforeEach.
 */
export function __resetForTests(): void {
  cache = new Set<string>();
  loadedAt = 0;
  refreshing = null;
}
