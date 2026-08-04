/**
 * The tables every test suite truncates between tests, and the module-level
 * state no TRUNCATE can reach.
 *
 * Its own module because there are now TWO setups that need it — `test/setup.ts`
 * for the default suite and `test-providers/setup.ts` for the sandbox harness —
 * and they cannot import each other: `test/setup.ts` registers the fake-provider
 * `vi.mock` in its module scope, so importing anything from it would install the
 * fakes into the sandbox harness and quietly turn every real-provider test into
 * a test of the fakes. That is the exact failure the harness exists to make
 * impossible, so the shared parts live here, where nothing is mocked.
 *
 * A table missing from this list is state that survives into the next test.
 * Add new domain tables here, child-before-parent (CASCADE follows the FKs
 * anyway, but the order documents the shape).
 */

export const DOMAIN_TABLES = [
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
] as const;

/**
 * Modules that keep state the TRUNCATE cannot reach, each exporting a
 * `__resetForTests`. What each one holds, and why it has to be dropped:
 *
 *   brute-force        failure counters + lockouts, keyed
 *                      `bf:lock:<scope>:<appId>:<email>` — so a lock outlives
 *                      the end-user it refers to and hits the next test that
 *                      recycles the address. In test this is an in-MEMORY
 *                      store, never Redis (`getRedis()` returns null).
 *   cors-origins       the union of every Application's registered origins,
 *                      on a 30s TTL.
 *   signing-keys       active JWT signing key + JWKS snapshot, on a 60s TTL,
 *                      against `signing_keys` rows the TRUNCATE removes.
 *   request-log        buffered api_request_logs rows, flushed by a TIMER —
 *                      the in-flight INSERT the TRUNCATE deadlock retry exists
 *                      to survive.
 *   dependency-outage  the 5-minute per-(subsystem, tenant) suppression window
 *                      on outage security events.
 *   oauth/oidc         cached OIDC discovery documents, on a 24h TTL.
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

/**
 * Reset every module-level singleton that outlives a single test.
 *
 * The imports are DYNAMIC, and that is load-bearing: a static import loads
 * these modules — and their dependencies — into this file's module graph before
 * a test file's hoisted `vi.mock` can register. `brute-force-fail-closed.test.ts`
 * mocks `lib/redis.js`, and a static import of brute-force from here would bind
 * it to the REAL one, silently turning six fail-closed assertions
 * green-by-accident. Resolving at hook time gets the mocked module like any
 * other consumer.
 */
export async function resetProcessGlobalState(): Promise<void> {
  resetFns ??= await Promise.all(
    RESET_MODULES.map(async (spec) => {
      const mod = (await import(spec)) as { __resetForTests: () => void };
      return mod.__resetForTests;
    }),
  );
  for (const reset of resetFns) reset();
}

/**
 * `TRUNCATE ... RESTART IDENTITY CASCADE` over every domain table, retrying on
 * deadlock.
 *
 * TRUNCATE needs an AccessExclusiveLock, which can deadlock (40P01) against a
 * still-in-flight best-effort INSERT from the previous test — e.g. the
 * fire-and-forget api_request_logs / security_events writers, whose writes
 * intentionally outlive the request. The blocking write settles within
 * milliseconds.
 */
export async function truncateDomainTables(
  execute: (sql: string) => Promise<unknown>,
): Promise<void> {
  // Quoted identifiers, single statement, so the truncate is atomic.
  const stmt = `TRUNCATE TABLE ${DOMAIN_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`;
  for (let attempt = 1; ; attempt++) {
    try {
      await execute(stmt);
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
