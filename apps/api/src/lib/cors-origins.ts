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

async function load(): Promise<void> {
  const apps = await prisma.application.findMany({
    select: {
      corsOrigins: true,
      hostedPortalEnabled: true,
      portalDomain: true,
      portalDomainVerifiedAt: true,
    },
  });
  const next = new Set<string>();
  let anyPortal = false;
  for (const app of apps) {
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
