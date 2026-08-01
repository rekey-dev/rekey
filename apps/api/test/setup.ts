/**
 * Per-file test setup.
 *
 * Truncates the domain tables before each test so individual cases stay
 * isolated. We use `TRUNCATE ... RESTART IDENTITY CASCADE` to also reset
 * sequences and follow FK chains — slightly heavier than per-table DELETE
 * but a lot less code than carefully ordering deletes.
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
import { getRedis } from '../src/lib/redis.js';
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
 * Postgres is not the only store holding per-test state.
 *
 * Brute-force lock keys are keyed on application + email, so they outlive the
 * TRUNCATE that removed the end-user they refer to — a lock set by one test can
 * still be counting when the next one signs in as a freshly created user with a
 * recycled address. Rate-limit counters have the same shape (see
 * `globalRateLimitMax` in lib/rate-limit.ts, which is what stops the global
 * limiter from throttling the suite against itself), so clear those too rather
 * than depend on which store the plugin happens to be using.
 *
 * SCAN rather than FLUSHDB: the BullMQ webhook queue shares this Redis and its
 * jobs are not per-test state.
 */
async function clearRedisTestState(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  for (const pattern of ['fastify-rate-limit-*', 'bf:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  }
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
  await truncateDomainTables();
  await clearRedisTestState();
});

afterAll(async () => {
  await prisma.$disconnect();
});
