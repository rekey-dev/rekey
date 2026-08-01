/**
 * Per-file test setup.
 *
 * Truncates the domain tables before each test so individual cases stay
 * isolated. We use `TRUNCATE ... RESTART IDENTITY CASCADE` to also reset
 * sequences and follow FK chains — slightly heavier than per-table DELETE
 * but a lot less code than carefully ordering deletes.
 *
 * Postgres is not the only store holding per-test state, and the second one is
 * NOT Redis. Under `NODE_ENV=test` `getRedis()` returns null by design, so
 * brute-force counters, OIDC discovery documents, signing keys, the
 * request-log buffer and the outage-event window all live in plain
 * module-level variables that no TRUNCATE reaches. Nothing reset them, so each
 * one leaked into every later test that shared its module instance. Each now
 * exports a `__resetForTests`, and `resetProcessGlobalState` below calls all of
 * them from `beforeEach`.
 *
 * This replaced a `clearRedisTestState()` that SCANned Redis for `bf:*` keys.
 * It could never have worked: it opened with `const redis = getRedis(); if
 * (!redis) return;`, and in test that is always null. It deleted zero keys on
 * all 950 invocations while its docblock described fixing exactly the leak
 * that was in fact still happening, in memory, one module over.
 *
 * It also installs the FAKE billing providers. The shipped factory only ever
 * returns real, network-talking providers and throws when an Application has
 * no credentials — deliberately, see `providers/index.ts`. Tests must not
 * reach api.stripe.com, so the seam is here in test-land rather than a
 * `NODE_ENV === 'test'` branch in the product. `pickProvider` and
 * `countryFromRequest` keep their real implementations: routing logic is
 * under test, the network call is not.
 */

import { afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { fakeProviderFor } from './fakes/billing-providers.js';

vi.mock('../src/modules/billing/providers/index.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/modules/billing/providers/index.js')>();
  return {
    ...actual,
    // A `vi.fn`, not a bare arrow: tests need to assert on the call log —
    // "plan creation did not ask for a provider" is only checkable that way,
    // and a mock that silently answers is exactly how the Stripe-required
    // regression stayed invisible.
    getProviderForApplication: vi.fn(async (_application: unknown, provider: string) =>
      fakeProviderFor(provider),
    ),
  };
});

const DOMAIN_TABLES = [
  'idempotency_keys',
  'api_request_logs',
  'email_logs',
  'email_templates',
  'webhook_events',
  'coupon_redemptions',
  'coupons',
  'usage_records',
  'usage_meters',
  'license_activations',
  'licenses',
  'dunning_cases',
  'payments',
  'subscriptions',
  'plans',
  'mfa_credentials',
  'oauth_identities',
  'password_reset_tokens',
  'refresh_tokens',
  'webauthn_credentials',
  'magic_link_tokens',
  'impersonation_audits',
  'organization_invitations',
  'organization_memberships',
  'organizations',
  'api_keys',
  'end_users',
  'tenant_webauthn_credentials',
  'tenant_mfa_credentials',
  'tenant_invitations',
  'tenant_password_reset_tokens',
  'tenant_magic_link_tokens',
  'tenant_refresh_tokens',
  'application_grants',
  'operator_invites',
  'tenant_memberships',
  'tenant_users',
  'applications',
  'tenants',
];

/**
 * Modules that keep state the TRUNCATE below cannot reach, each exporting a
 * `__resetForTests`. What each one holds, and why it has to be dropped:
 *
 *   brute-force        failure counters + lockouts, keyed
 *                      `bf:lock:<scope>:<appId>:<email>` — so a lock outlives
 *                      the end-user it refers to and hits the next test that
 *                      recycles the address. In test this is an in-MEMORY
 *                      store, never Redis (`getRedis()` returns null), which
 *                      is why the old Redis SCAN never cleared it.
 *   cors-origins       the union of every Application's registered origins,
 *                      on a 30s TTL.
 *   signing-keys       active JWT signing key + JWKS snapshot, on a 60s TTL,
 *                      against `signing_keys` rows the TRUNCATE removes.
 *   request-log        buffered api_request_logs rows, flushed by a TIMER —
 *                      the in-flight INSERT the TRUNCATE deadlock retry below
 *                      exists to survive.
 *   dependency-outage  the 5-minute per-(subsystem, tenant) suppression window
 *                      on outage security events.
 *   oauth/oidc         cached OIDC discovery documents, on a 24h TTL.
 *
 * Imported DYNAMICALLY, and that is load-bearing: a static import here loads
 * these modules — and their dependencies — into the file's module graph before
 * a test file's hoisted `vi.mock` can register. `brute-force-fail-closed.test.ts`
 * mocks `lib/redis.js`, and a static import of brute-force from this file binds
 * it to the REAL one, silently turning six fail-closed assertions green-by-
 * accident. Resolving at hook time gets the mocked module like any other
 * consumer.
 */
const RESET_MODULES = [
  '../src/lib/brute-force.js',
  '../src/lib/cors-origins.js',
  '../src/lib/signing-keys.js',
  '../src/lib/request-log.js',
  '../src/lib/dependency-outage.js',
  '../src/modules/oauth/providers/oidc.js',
] as const;

let resetFns: Array<() => void> | null = null;

/** Reset every module-level singleton that outlives a single test. */
async function resetProcessGlobalState(): Promise<void> {
  resetFns ??= await Promise.all(
    RESET_MODULES.map(async (spec) => {
      const mod = (await import(spec)) as { __resetForTests: () => void };
      return mod.__resetForTests;
    }),
  );
  for (const reset of resetFns) reset();
}

async function truncateDomainTables(): Promise<void> {
  // Quoted identifiers + RESTART IDENTITY + CASCADE.
  // Single statement so the truncate is atomic.
  const stmt = `TRUNCATE TABLE ${DOMAIN_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
  // TRUNCATE needs an AccessExclusiveLock, which can deadlock (40P01) against a
  // still-in-flight best-effort INSERT from the previous test — e.g. the
  // fire-and-forget api_request_logs / security_events writers, whose writes
  // intentionally outlive the request. Retry a few times on deadlock; the
  // blocking write settles within milliseconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2034' || /40P01|deadlock/i.test(String((err as Error).message))) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 50 * attempt));
        continue;
      }
      throw err;
    }
  }
}

beforeEach(async () => {
  // Globals first: dropping the request-log buffer removes the in-flight
  // INSERT that the TRUNCATE's deadlock retry exists to survive.
  await resetProcessGlobalState();
  await truncateDomainTables();
});

afterAll(async () => {
  await prisma.$disconnect();
});
